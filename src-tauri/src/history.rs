//! Historial del proyecto: una copia de los archivos de cada tarea al entregarla, para ver qué
//! cambió y deshacerlo (o rehacerlo) por tarea.
//!
//! Va en un repositorio git aparte, `.lienzo/historial`, con el proyecto como árbol de trabajo:
//! no hace falta que la carpeta sea un repo y, si lo es, no se toca el `.git` del usuario.

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

/// Una operación de git a la vez (el índice es uno solo).
pub(crate) static LOCK: Mutex<()> = Mutex::new(());

const DIFF_CAP: usize = 400 * 1024;
const BIG_FILE: u64 = 20 * 1024 * 1024;
const LIST_FILES_CAP: usize = 200;
const EXCLUDE: &str = "# lienzo: lo que no entra en el historial\n\
.lienzo/\n.git/\nnode_modules/\ndist/\nbuild/\ntarget/\n.next/\n.nuxt/\n.svelte-kit/\n.vite/\n\
.turbo/\n.cache/\ncoverage/\nvenv/\n.venv/\n__pycache__/\n*.pyc\n*.log\n.DS_Store\nThumbs.db\n\
# lo que lienzo escribe para coordinar a los agentes\n\
/.claude/\n/.agents/\n/.opencode/\n/.gemini/\n/.mcp.json\n/opencode.json\n/CLAUDE.md\n/AGENTS.md\n";
const NOISE: [&str; 12] = [
    ".lienzo", ".git", "node_modules", "dist", "build", "target", ".next", "venv", ".venv", "__pycache__", ".cache",
    "coverage",
];

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct HFile {
    pub path: String,
    /// A (nuevo), M (cambiado) o D (borrado).
    pub status: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct HEntry {
    pub id: String,
    pub ts_ms: u64,
    pub title: String,
    /// inicio | entrega | deshacer | rehacer | manual
    pub kind: String,
    pub task: Option<u64>,
    pub by: String,
    /// Entrada a la que se refiere un «deshacer» o «rehacer».
    pub target: String,
    pub files: Vec<HFile>,
    pub files_total: usize,
    /// Sus cambios están deshechos ahora mismo.
    pub undone: bool,
}

#[derive(Serialize)]
pub struct HList {
    pub entries: Vec<HEntry>,
    /// Cambios en disco que aún no están en ninguna entrada.
    pub pending: Vec<HFile>,
}

#[derive(Serialize)]
pub struct HDiff {
    pub diff: String,
    pub truncated: bool,
}

#[derive(Serialize)]
pub struct HOutcome {
    pub done: bool,
    pub message: String,
    /// Motivos para pensárselo (otras entregas tocaron lo mismo, cambios sin guardar…).
    pub warnings: Vec<String>,
}

pub(crate) fn root_of(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path.trim());
    if !p.is_dir() {
        return Err("la carpeta del proyecto no existe".into());
    }
    let c = p.canonicalize().map_err(|e| e.to_string())?;
    // Sin el prefijo \\?\ de Windows: git no lo entiende en --work-tree.
    let s = c.display().to_string();
    Ok(PathBuf::from(s.strip_prefix(r"\\?\").unwrap_or(&s)))
}

pub(crate) fn repo_dir(root: &Path) -> PathBuf {
    root.join(".lienzo").join("historial")
}

pub(crate) fn base_cmd() -> Command {
    let mut c = Command::new("git");
    c.env("GIT_TERMINAL_PROMPT", "0");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // sin ventana de consola
    }
    c
}

pub(crate) fn git_env(root: &Path, args: &[&str], env: &[(&str, &Path)]) -> Result<String, String> {
    let mut c = base_cmd();
    c.arg(format!("--git-dir={}", repo_dir(root).display()))
        .arg(format!("--work-tree={}", root.display()))
        .args([
            "-c", "core.autocrlf=false",
            "-c", "core.safecrlf=false",
            "-c", "core.quotepath=false",
            "-c", "core.longpaths=true",
            "-c", "user.name=lienzo",
            "-c", "user.email=lienzo@localhost",
        ])
        .args(args)
        .current_dir(root);
    for (k, v) in env {
        c.env(k, v);
    }
    let out = c.output().map_err(|e| format!("no pude ejecutar git: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let msg = if err.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { err };
        return Err(msg);
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

pub(crate) fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    git_env(root, args, &[])
}

/// Archivos enormes (modelos, vídeos…): fuera del historial para no duplicarlos.
fn big_files(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    let mut seen = 0usize;
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            seen += 1;
            if seen > 50_000 {
                return out;
            }
            let name = e.file_name().to_string_lossy().to_string();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                if !NOISE.contains(&name.as_str()) {
                    stack.push(e.path());
                }
            } else if ft.is_file() && e.metadata().map(|m| m.len() > BIG_FILE).unwrap_or(false)
                && let Ok(rel) = e.path().strip_prefix(root) {
                    out.push(format!("/{}", rel.display().to_string().replace('\\', "/")));
                }
        }
    }
    out
}

/// Crea el historial con el estado actual como punto de partida (si aún no existe).
pub(crate) fn ensure_at(root: &Path) -> Result<bool, String> {
    let repo = repo_dir(root);
    if repo.join("HEAD").exists() {
        return Ok(false);
    }
    std::fs::create_dir_all(&repo).map_err(|e| e.to_string())?;
    let out = base_cmd()
        .args(["init", "-q", "--bare"])
        .arg(&repo)
        .output()
        .map_err(|e| format!("no pude ejecutar git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let mut exclude = EXCLUDE.to_string();
    for big in big_files(root) {
        exclude.push_str(&big);
        exclude.push('\n');
    }
    let info = repo.join("info");
    let _ = std::fs::create_dir_all(&info);
    std::fs::write(info.join("exclude"), exclude).map_err(|e| e.to_string())?;
    git(root, &["add", "-A"])?;
    git(root, &["commit", "-q", "--allow-empty", "-m", "Punto de partida\n\nlienzo-kind: inicio"])?;
    Ok(true)
}

/// Activa el historial de un proyecto (en segundo plano al abrirlo).
pub fn ensure(project: &str) -> Result<bool, String> {
    let root = root_of(project)?;
    let _g = LOCK.lock().map_err(|e| e.to_string())?;
    ensure_at(&root)
}

/// «src/a.js:12», «C:\proy\src\a.js#L3-9» → «src/a.js» (None si está fuera del proyecto).
fn rel_of(root: &Path, raw: &str) -> Option<String> {
    let mut s = raw.trim().trim_matches(|c| c == '`' || c == '"' || c == '\'').replace('\\', "/");
    if let Some(i) = s.find("#L") {
        s.truncate(i);
    }
    // Sufijo :línea(:columna), sin confundirlo con la unidad «C:».
    while let Some(i) = s.rfind(':') {
        let tail = &s[i + 1..];
        if i > 1 && !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit() || c == '-') {
            s.truncate(i);
        } else {
            break;
        }
    }
    let root_s = root.display().to_string().replace('\\', "/");
    let root_s = root_s.trim_end_matches('/');
    let rel = if s.len() > root_s.len() + 1
        && s[..root_s.len()].eq_ignore_ascii_case(root_s)
        && s.as_bytes()[root_s.len()] == b'/'
    {
        s[root_s.len() + 1..].to_string()
    } else if Path::new(&s).is_absolute() || s.starts_with('/') {
        return None;
    } else {
        s.trim_start_matches("./").to_string()
    };
    let rel = rel.trim_end_matches('/').to_string();
    if rel.is_empty() {
        return None;
    }
    for c in Path::new(&rel).components() {
        if !matches!(c, Component::Normal(_)) {
            return None;
        }
    }
    if rel == ".lienzo" || rel.starts_with(".lienzo/") {
        return None;
    }
    Some(rel)
}

fn commit(root: &Path, msg: &str) -> Result<String, String> {
    git(root, &["commit", "-q", "--allow-empty", "-m", msg])?;
    Ok(git(root, &["rev-parse", "HEAD"])?.trim().to_string())
}

/// Guarda la entrega de una tarea: solo sus archivos, tal como están ahora.
pub fn record(project: &str, task: u64, title: &str, by: &str, files: &[String]) -> Result<String, String> {
    let root = root_of(project)?;
    let _g = LOCK.lock().map_err(|e| e.to_string())?;
    ensure_at(&root)?;
    let mut rels: Vec<String> = Vec::new();
    for f in files.iter().take(300) {
        if let Some(r) = rel_of(&root, f)
            && !rels.contains(&r) {
                rels.push(r);
            }
    }
    for r in &rels {
        // Una ruta que no existe ni existió da error: se ignora.
        let _ = git(&root, &["add", "-A", "--", r]);
    }
    let title: String = title.trim().chars().take(140).collect();
    let by = by.trim().replace('\n', " ");
    commit(
        &root,
        &format!("#{task} {title}\n\nlienzo-kind: entrega\nlienzo-task: {task}\nlienzo-by: {by}"),
    )
}

fn trailers(body: &str) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for l in body.lines() {
        if let Some(rest) = l.strip_prefix("lienzo-")
            && let Some((k, v)) = rest.split_once(':') {
                m.insert(k.trim().to_string(), v.trim().to_string());
            }
    }
    m
}

fn parse_status(block: &str) -> Vec<HFile> {
    block
        .lines()
        .filter_map(|l| {
            let (st, p) = l.split_once('\t')?;
            let st = st.trim();
            if st.is_empty() || p.trim().is_empty() {
                return None;
            }
            Some(HFile { path: p.trim().to_string(), status: st[..1].to_string() })
        })
        .collect()
}

fn parse_log(out: &str) -> Vec<HEntry> {
    let mut entries = Vec::new();
    for chunk in out.split('\u{1e}') {
        let parts: Vec<&str> = chunk.splitn(4, '\u{1f}').collect();
        if parts.len() < 4 {
            continue;
        }
        let id = parts[0].trim().to_string();
        let ts_ms = parts[1].trim().parse::<u64>().unwrap_or(0) * 1000;
        let msg = parts[2];
        let t = trailers(msg);
        let title = msg.lines().next().unwrap_or("").trim().to_string();
        let all = parse_status(parts[3]);
        let files_total = all.len();
        entries.push(HEntry {
            id,
            ts_ms,
            title,
            kind: t.get("kind").cloned().unwrap_or_else(|| "manual".into()),
            task: t.get("task").and_then(|v| v.parse().ok()),
            by: t.get("by").cloned().unwrap_or_default(),
            target: t.get("target").cloned().unwrap_or_default(),
            files: all.into_iter().take(LIST_FILES_CAP).collect(),
            files_total,
            undone: false,
        });
    }
    // De la más vieja a la más nueva: cada deshacer/rehacer cambia el estado de su objetivo.
    let mut undone: HashMap<String, bool> = HashMap::new();
    for e in entries.iter().rev() {
        match e.kind.as_str() {
            "deshacer" => {
                undone.insert(e.target.clone(), true);
            }
            "rehacer" => {
                undone.insert(e.target.clone(), false);
            }
            _ => {}
        }
    }
    for e in entries.iter_mut() {
        e.undone = undone.get(&e.id).copied().unwrap_or(false);
    }
    entries
}

fn pending_at(root: &Path) -> Vec<HFile> {
    let Ok(out) = git(root, &["status", "--porcelain=v1", "-uall", "--no-renames"]) else {
        return vec![];
    };
    out.lines()
        .filter(|l| l.len() > 3)
        .take(300)
        .map(|l| {
            let code = &l[..2];
            let st = if code == "??" { "A".to_string() } else { code.trim().chars().next().unwrap_or('M').to_string() };
            HFile { path: l[3..].trim_matches('"').to_string(), status: st }
        })
        .collect()
}

pub fn list(project: &str) -> Result<HList, String> {
    let root = root_of(project)?;
    let _g = LOCK.lock().map_err(|e| e.to_string())?;
    ensure_at(&root)?;
    let out = git(
        &root,
        &["log", "-n", "300", "--no-renames", "--format=%x1e%H%x1f%ct%x1f%B%x1f", "--name-status"],
    )?;
    let mut entries = parse_log(&out);
    // El punto de partida trae todo el proyecto: no hace falta listarlo.
    for e in entries.iter_mut() {
        if e.kind == "inicio" {
            e.files.clear();
        }
    }
    Ok(HList { entries, pending: pending_at(&root) })
}

fn check_id(id: &str) -> Result<(), String> {
    if id.len() >= 7 && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("entrada del historial no válida".into())
    }
}

fn cap(mut diff: String) -> HDiff {
    if diff.len() <= DIFF_CAP {
        return HDiff { diff, truncated: false };
    }
    let mut cut = DIFF_CAP;
    while cut > 0 && !diff.is_char_boundary(cut) {
        cut -= 1;
    }
    diff.truncate(cut);
    HDiff { diff, truncated: true }
}

/// Cambios de una entrada, o los que aún no están guardados (`id` = «pending»).
pub fn diff(project: &str, id: &str) -> Result<HDiff, String> {
    let root = root_of(project)?;
    let _g = LOCK.lock().map_err(|e| e.to_string())?;
    ensure_at(&root)?;
    if id == "pending" {
        // Con un índice aparte, para que los archivos nuevos también salgan.
        let tmp = repo_dir(&root).join("index-pendiente");
        let _ = std::fs::remove_file(&tmp);
        let env = [("GIT_INDEX_FILE", tmp.as_path())];
        git_env(&root, &["read-tree", "HEAD"], &env)?;
        git_env(&root, &["add", "-A"], &env)?;
        let d = git_env(&root, &["diff", "--cached", "--no-color", "--no-renames", "-U3", "HEAD"], &env);
        let _ = std::fs::remove_file(&tmp);
        return Ok(cap(d?));
    }
    check_id(id)?;
    let parents = git(&root, &["rev-list", "--parents", "-n", "1", id])?;
    if parents.split_whitespace().count() < 2 {
        return Ok(HDiff { diff: String::new(), truncated: false });
    }
    Ok(cap(git(&root, &["show", "--format=", "--no-color", "--no-renames", "-U3", id])?))
}

fn entry_files(root: &Path, id: &str) -> Result<Vec<HFile>, String> {
    Ok(parse_status(&git(root, &["show", "--format=", "--no-renames", "--name-status", id])?))
}

/// Deshace (`redo` = false) o rehace los cambios de una entrada, solo en sus archivos.
/// Sin `force`, si hay motivos para pensárselo no toca nada y los devuelve.
pub fn revert(project: &str, id: &str, redo: bool, force: bool) -> Result<HOutcome, String> {
    let root = root_of(project)?;
    check_id(id)?;
    let _g = LOCK.lock().map_err(|e| e.to_string())?;
    ensure_at(&root)?;
    let msg = git(&root, &["log", "-n", "1", "--format=%B", id])?;
    let t = trailers(&msg);
    let subject = msg.lines().next().unwrap_or("").trim().to_string();
    if t.get("kind").map(|k| k == "inicio").unwrap_or(false) {
        return Err("el punto de partida no se puede deshacer".into());
    }
    let files = entry_files(&root, id)?;
    if files.is_empty() {
        return Ok(HOutcome { done: false, message: "Esa entrega no cambió archivos.".into(), warnings: vec![] });
    }
    let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();

    let mut warnings = Vec::new();
    // Entregas posteriores que tocaron los mismos archivos (salvo deshacer/rehacer de esta).
    let mut args = vec!["log", "--format=%x1e%h%x1f%B", "--no-renames"];
    let range = format!("{id}..HEAD");
    args.push(&range);
    args.push("--");
    args.extend(paths.iter().copied());
    let later = git(&root, &args)?;
    for chunk in later.split('\u{1e}') {
        let Some((_, body)) = chunk.split_once('\u{1f}') else { continue };
        let tt = trailers(body);
        if tt.get("target").map(|v| id.starts_with(v.as_str()) || v.starts_with(id)).unwrap_or(false) {
            continue;
        }
        let s = body.lines().next().unwrap_or("").trim();
        warnings.push(format!("Después, «{s}» cambió alguno de estos archivos: también se perderá."));
    }
    let mut dargs = vec!["status", "--porcelain=v1", "--"];
    dargs.extend(paths.iter().copied());
    let dirty = git(&root, &dargs)?;
    let dirty: Vec<String> = dirty.lines().filter(|l| l.len() > 3).map(|l| l[3..].to_string()).collect();
    if !dirty.is_empty() {
        warnings.push(format!("Hay cambios aún sin guardar en {}: se perderán.", dirty.join(", ")));
    }
    if !warnings.is_empty() && !force {
        return Ok(HOutcome { done: false, message: String::new(), warnings });
    }

    let parent = format!("{id}^");
    for f in &files {
        // Al deshacer, lo nuevo se borra; al rehacer, lo borrado.
        let remove = if redo { f.status == "D" } else { f.status == "A" };
        if remove {
            let _ = git(&root, &["rm", "-q", "--cached", "--ignore-unmatch", "--", &f.path]);
            let abs = root.join(&f.path);
            if abs.is_file() {
                std::fs::remove_file(&abs).map_err(|e| format!("no pude borrar {}: {e}", f.path))?;
            }
        } else {
            let from = if redo { id } else { parent.as_str() };
            git(&root, &["checkout", from, "--", &f.path])?;
        }
    }
    for p in &paths {
        let _ = git(&root, &["add", "-A", "--", p]);
    }
    let (verb, kind) = if redo { ("Rehacer", "rehacer") } else { ("Deshacer", "deshacer") };
    let task = t.get("task").map(|v| format!("\nlienzo-task: {v}")).unwrap_or_default();
    commit(&root, &format!("{verb}: {subject}\n\nlienzo-kind: {kind}\nlienzo-target: {id}{task}"))?;
    let n = files.len();
    Ok(HOutcome {
        done: true,
        message: format!(
            "{} «{subject}»: {n} archivo{}.",
            if redo { "Rehecha" } else { "Deshecha" },
            if n == 1 { "" } else { "s" }
        ),
        warnings,
    })
}

/// Guarda como una entrada los cambios sueltos (los que no vinieron de una tarea).
pub fn save(project: &str, title: &str) -> Result<String, String> {
    let root = root_of(project)?;
    let _g = LOCK.lock().map_err(|e| e.to_string())?;
    ensure_at(&root)?;
    if pending_at(&root).is_empty() {
        return Err("no hay cambios sin guardar".into());
    }
    git(&root, &["add", "-A"])?;
    let title = if title.trim().is_empty() { "Cambios sueltos".to_string() } else { title.trim().chars().take(140).collect() };
    commit(&root, &format!("{title}\n\nlienzo-kind: manual\nlienzo-by: tú"))
}

#[tauri::command]
pub async fn history_list(path: String) -> Result<HList, String> {
    tauri::async_runtime::spawn_blocking(move || list(&path)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn history_diff(path: String, id: String) -> Result<HDiff, String> {
    tauri::async_runtime::spawn_blocking(move || diff(&path, &id)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn history_revert(path: String, id: String, redo: bool, force: bool) -> Result<HOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || revert(&path, &id, redo, force))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn history_save(path: String, title: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || save(&path, &title)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lienzo-hist-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn read(p: &Path) -> String {
        std::fs::read_to_string(p).unwrap_or_default()
    }

    #[test]
    fn rutas_de_las_entregas() {
        let root = PathBuf::from(r"C:\proy");
        assert_eq!(rel_of(&root, "src/a.js").as_deref(), Some("src/a.js"));
        assert_eq!(rel_of(&root, r"C:\proy\src\a.js:12").as_deref(), Some("src/a.js"));
        assert_eq!(rel_of(&root, "c:/PROY/src/a.js#L3-9").as_deref(), Some("src/a.js"));
        assert_eq!(rel_of(&root, "./src/").as_deref(), Some("src"));
        assert_eq!(rel_of(&root, r"C:\otra\a.js"), None);
        assert_eq!(rel_of(&root, "../fuera.txt"), None);
        assert_eq!(rel_of(&root, ".lienzo/adjuntos/x.png"), None);
    }

    #[test]
    fn deshacer_y_rehacer_por_tarea() {
        let root = tmp("rev");
        let p = root.display().to_string();
        std::fs::write(root.join("a.txt"), "uno\n").unwrap();
        std::fs::write(root.join("b.txt"), "be\n").unwrap();
        std::fs::create_dir_all(root.join("node_modules/x")).unwrap();
        std::fs::write(root.join("node_modules/x/i.js"), "ruido").unwrap();
        assert!(ensure(&p).unwrap());
        assert!(!ensure(&p).unwrap());

        // Tarea 1: cambia a.txt y crea c.txt. Tarea 2: cambia b.txt.
        std::fs::write(root.join("a.txt"), "dos\n").unwrap();
        std::fs::write(root.join("c.txt"), "nuevo\n").unwrap();
        std::fs::write(root.join("b.txt"), "be 2\n").unwrap();
        let t1 = record(&p, 1, "Cambia a", "opencode", &[format!("{p}\\a.txt"), "c.txt:3".into()]).unwrap();
        let t2 = record(&p, 2, "Cambia b", "antigravity", &["b.txt".into()]).unwrap();

        let l = list(&p).unwrap();
        assert_eq!(l.entries.len(), 3);
        assert_eq!(l.entries[0].task, Some(2));
        assert_eq!(l.entries[1].files, vec![
            HFile { path: "a.txt".into(), status: "M".into() },
            HFile { path: "c.txt".into(), status: "A".into() },
        ]);
        assert_eq!(l.entries[2].kind, "inicio");
        assert!(l.pending.is_empty(), "{:?}", l.pending);
        assert!(diff(&p, &t1).unwrap().diff.contains("+dos"));

        // Deshacer la 1 deja la 2 intacta.
        let o = revert(&p, &t1, false, false).unwrap();
        assert!(o.done, "{:?}", o.warnings);
        assert_eq!(read(&root.join("a.txt")), "uno\n");
        assert!(!root.join("c.txt").exists());
        assert_eq!(read(&root.join("b.txt")), "be 2\n");
        let l = list(&p).unwrap();
        assert!(l.entries.iter().find(|e| e.id == t1).unwrap().undone);
        assert!(!l.entries.iter().find(|e| e.id == t2).unwrap().undone);

        // Rehacer la devuelve.
        assert!(revert(&p, &t1, true, false).unwrap().done);
        assert_eq!(read(&root.join("a.txt")), "dos\n");
        assert_eq!(read(&root.join("c.txt")), "nuevo\n");
        assert!(!list(&p).unwrap().entries.iter().find(|e| e.id == t1).unwrap().undone);

        // Si otra entrega tocó lo mismo después, avisa antes de tocar nada.
        std::fs::write(root.join("a.txt"), "tres\n").unwrap();
        record(&p, 3, "Otra vez a", "claude", &["a.txt".into()]).unwrap();
        let o = revert(&p, &t1, false, false).unwrap();
        assert!(!o.done);
        assert!(o.warnings[0].contains("Otra vez a"), "{:?}", o.warnings);
        assert_eq!(read(&root.join("a.txt")), "tres\n");
        assert!(revert(&p, &t1, false, true).unwrap().done);
        assert_eq!(read(&root.join("a.txt")), "uno\n");

        // Cambios sueltos: se ven y se guardan.
        std::fs::write(root.join("d.txt"), "suelto\n").unwrap();
        let l = list(&p).unwrap();
        assert_eq!(l.pending, vec![HFile { path: "d.txt".into(), status: "A".into() }]);
        assert!(diff(&p, "pending").unwrap().diff.contains("+suelto"));
        save(&p, "").unwrap();
        assert!(list(&p).unwrap().pending.is_empty());
        assert!(save(&p, "").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
