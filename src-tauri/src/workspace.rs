//! Carpetas aisladas por tarea (opción de Ajustes). Cada tarea tomada trabaja en su propia copia del
//! proyecto, `.lienzo/tareas/<id>`, así dos agentes pueden tocar el mismo archivo a la vez sin
//! pisarse. Idea de los worktrees de Orca, pero sin pedir que el proyecto sea un repo: se apoya en el
//! git propio de cada proyecto (`.lienzo/historial`, ver `history.rs`), que ya existe en todos.
//!
//! - Al tomar la tarea se guarda una foto del proyecto (la «base») y se abre un worktree de ella.
//! - Las carpetas pesadas (`node_modules`, `.venv`…, también las de subcarpetas como `web/`) no se
//!   copian: se enlazan con un junction.
//! - Si el proyecto está en OneDrive, las copias van fuera (`%LOCALAPPDATA%\lienzo\tareas`): si no,
//!   OneDrive subiría a la nube cada copia de cada tarea.
//! - Al entregar (o al aprobarse, en modo director) primero se trae a la copia lo que cambió en el
//!   proyecto desde la base (fusión a tres bandas, como `git merge-file`) y después se copia al
//!   proyecto lo que cambió el agente. Si algo choca, se deja marcado en la copia y no se toca el
//!   proyecto: el agente lo resuelve y vuelve a entregar.

use crate::history::{base_cmd, ensure_at, git, git_env, repo_dir, root_of, LOCK};
use std::path::{Path, PathBuf};

/// Carpetas que no entran en el historial y que la copia necesita para compilar o probar: se enlazan.
const SHARED: [&str; 3] = ["node_modules", ".venv", "venv"];

/// Clave de una ruta para compararla: sin `\\?\`, con «/», sin barra final y en minúsculas.
fn path_key(p: &str) -> String {
    let p = p.strip_prefix(r"\\?\").unwrap_or(p);
    crate::hub::project_key(p)
}

/// Las carpetas de OneDrive de este equipo (personal y de empresa).
fn onedrive_dirs() -> Vec<String> {
    ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]
        .iter()
        .filter_map(|v| std::env::var(v).ok())
        .filter(|v| !v.trim().is_empty())
        .collect()
}

/// Dónde van las copias de las tareas de un proyecto: dentro de él salvo que esté en OneDrive;
/// entonces en `local/<huella de la carpeta>`.
fn tasks_root_in(root: &Path, onedrive: &[String], local: &Path) -> PathBuf {
    let key = path_key(&root.display().to_string());
    let synced = onedrive.iter().map(|d| path_key(d)).any(|d| key == d || key.starts_with(&format!("{d}/")));
    if !synced {
        return root.join(".lienzo").join("tareas");
    }
    // FNV-1a: un nombre corto y estable por carpeta (como el archivo del feed).
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in key.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    local.join(format!("{h:016x}"))
}

/// La carpeta de las copias de las tareas del proyecto (ver `tasks_root_in`).
pub fn tasks_root(root: &Path) -> PathBuf {
    let local = std::env::var("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir());
    tasks_root_in(root, &onedrive_dirs(), &local.join(crate::hub::DATA_NAME).join("tareas"))
}

/// Carpeta aislada de la tarea `task`. Una copia ya empezada en el sitio de antes
/// (`.lienzo/tareas` dentro del proyecto) sigue allí hasta que se entregue.
pub fn ws_dir(root: &Path, task: u64) -> PathBuf {
    let before = root.join(".lienzo").join("tareas").join(task.to_string());
    if before.join(".git").exists() {
        return before;
    }
    tasks_root(root).join(task.to_string())
}

fn base_ref(task: u64) -> String {
    format!("refs/lienzo/base/{task}")
}

/// git dentro de la copia (su `.git` apunta al historial del proyecto).
fn git_ws(ws: &Path, args: &[&str], env: &[(&str, &Path)]) -> Result<String, String> {
    let mut c = base_cmd();
    c.arg("-C").arg(ws).args([
        "-c", "core.autocrlf=false",
        "-c", "core.safecrlf=false",
        "-c", "core.quotepath=false",
        "-c", "core.longpaths=true",
        "-c", "user.name=lienzo",
        "-c", "user.email=lienzo@localhost",
    ]);
    c.args(args);
    for (k, v) in env {
        c.env(k, v);
    }
    let out = c.output().map_err(|e| format!("no pude ejecutar git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Contenido de `path` en el commit `rev` (None si allí no existe). En bytes: puede ser binario.
fn blob(root: &Path, rev: &str, path: &str) -> Option<Vec<u8>> {
    let out = base_cmd()
        .arg(format!("--git-dir={}", repo_dir(root).display()))
        .args(["cat-file", "blob", &format!("{rev}:{path}")])
        .output()
        .ok()?;
    out.status.success().then_some(out.stdout)
}

/// Foto de una carpeta como commit, sin tocar el índice ni la rama de nadie (índice aparte).
fn snapshot_with(index: &Path, run: impl Fn(&[&str], &[(&str, &Path)]) -> Result<String, String>) -> Result<String, String> {
    let env = [("GIT_INDEX_FILE", index)];
    run(&["add", "-A"], &env)?;
    let tree = run(&["write-tree"], &env)?.trim().to_string();
    let commit = run(&["commit-tree", &tree, "-m", "lienzo: foto"], &env)?.trim().to_string();
    let _ = std::fs::remove_file(index);
    Ok(commit)
}

/// Foto del proyecto tal como está ahora (con lo que aún no está guardado en el historial).
fn snapshot_project(root: &Path) -> Result<String, String> {
    let index = repo_dir(root).join("index-lienzo-foto");
    // Partir del índice del historial acelera el `add -A` (no relee lo que no cambió).
    let _ = std::fs::copy(repo_dir(root).join("index"), &index);
    snapshot_with(&index, |args, env| git_env(root, args, env))
}

fn snapshot_ws(root: &Path, ws: &Path, task: u64) -> Result<String, String> {
    let index = repo_dir(root).join(format!("index-lienzo-tarea-{task}"));
    snapshot_with(&index, |args, env| git_ws(ws, args, env))
}

/// Qué archivos cambian entre dos commits: (A/M/D, ruta relativa con «/»).
fn changes(root: &Path, from: &str, to: &str) -> Result<Vec<(char, String)>, String> {
    let out = git(root, &["diff", "--name-status", "--no-renames", "-z", from, to])?;
    let mut it = out.split('\0').filter(|s| !s.is_empty());
    let mut v = Vec::new();
    while let (Some(st), Some(path)) = (it.next(), it.next()) {
        v.push((st.chars().next().unwrap_or('M'), path.to_string()));
    }
    Ok(v)
}

fn read(path: &Path) -> Option<Vec<u8>> {
    std::fs::read(path).ok()
}

fn write(path: &Path, data: Option<&[u8]>) -> Result<(), String> {
    match data {
        Some(bytes) => {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            std::fs::write(path, bytes).map_err(|e| format!("no pude escribir {}: {e}", path.display()))
        }
        None => {
            if path.is_file() {
                std::fs::remove_file(path).map_err(|e| format!("no pude borrar {}: {e}", path.display()))?;
            }
            Ok(())
        }
    }
}

/// Fusión a tres bandas de un archivo de texto: (resultado, ¿con conflictos?). None si no se puede
/// (binario o git no pudo).
fn merge3(root: &Path, task: u64, mine: &[u8], base: &[u8], theirs: &[u8]) -> Option<(Vec<u8>, bool)> {
    let tmp = repo_dir(root).join(format!("fusion-{task}"));
    std::fs::create_dir_all(&tmp).ok()?;
    let (a, b, c) = (tmp.join("copia"), tmp.join("base"), tmp.join("proyecto"));
    std::fs::write(&a, mine).ok()?;
    std::fs::write(&b, base).ok()?;
    std::fs::write(&c, theirs).ok()?;
    let out = base_cmd()
        .args(["merge-file", "-p", "-L", "tu copia", "-L", "base", "-L", "proyecto"])
        .args([&a, &b, &c])
        .output()
        .ok();
    let _ = std::fs::remove_dir_all(&tmp);
    let out = out?;
    // merge-file: 0 = limpio, >0 = número de conflictos, <0 (o 255) = error (p. ej. binario).
    match out.status.code() {
        Some(0) => Some((out.stdout, false)),
        Some(n) if n > 0 && n < 128 => Some((out.stdout, true)),
        _ => None,
    }
}

/// Hasta qué profundidad se buscan carpetas pesadas en subcarpetas (`web/node_modules`, `apps/x/…`).
const SHARED_DEPTH: usize = 4;

/// Carpetas en las que no se busca (ni se entra en las pesadas que se encuentren).
fn skip_dir(name: &str) -> bool {
    name.starts_with('.') || matches!(name, "target" | "dist" | "build" | "out" | "__pycache__")
}

/// Las carpetas pesadas de `dir` y sus subcarpetas (rutas relativas). Sin seguir enlaces.
fn find_shared(dir: &Path, rel: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Ok(ft) = e.file_type() else { continue };
        let path = e.path();
        if SHARED.contains(&name.as_str()) {
            if ft.is_dir() || ft.is_symlink() || is_junction(&path) {
                out.push(rel.join(&name));
            }
            continue;
        }
        if depth > 0 && ft.is_dir() && !ft.is_symlink() && !is_junction(&path) && !skip_dir(&name) {
            find_shared(&path, &rel.join(&name), depth - 1, out);
        }
    }
}

/// Enlaza en la copia las carpetas pesadas del proyecto (un junction en Windows: no pide permisos
/// de administrador), también las de subcarpetas. Si no se puede, la copia sigue sin ellas.
fn link_shared(root: &Path, ws: &Path) {
    let mut found = Vec::new();
    find_shared(root, Path::new(""), SHARED_DEPTH, &mut found);
    for rel in found {
        let src = root.join(&rel);
        let dst = ws.join(&rel);
        // Solo donde la copia tiene la carpeta de al lado (si no, esa parte no es del proyecto).
        if !src.is_dir() || dst.exists() || !dst.parent().is_some_and(Path::is_dir) {
            continue;
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&dst)
                .arg(&src)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .creation_flags(0x0800_0000)
                .status();
        }
        #[cfg(not(windows))]
        {
            let _ = std::os::unix::fs::symlink(&src, &dst);
        }
    }
}

/// Quita los enlaces de la copia (solo el enlace: lo enlazado sigue intacto en el proyecto).
fn unlink_shared(ws: &Path) -> Result<(), String> {
    let mut found = Vec::new();
    find_shared(ws, Path::new(""), SHARED_DEPTH, &mut found);
    for rel in found {
        let dst = ws.join(rel);
        let Ok(meta) = std::fs::symlink_metadata(&dst) else { continue };
        let is_link = meta.file_type().is_symlink() || is_junction(&dst);
        if is_link {
            std::fs::remove_dir(&dst).map_err(|e| format!("no pude quitar el enlace {}: {e}", dst.display()))?;
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_junction(p: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    // FILE_ATTRIBUTE_REPARSE_POINT
    std::fs::symlink_metadata(p).map(|m| m.file_attributes() & 0x400 != 0).unwrap_or(false)
}

#[cfg(not(windows))]
fn is_junction(_: &Path) -> bool {
    false
}

/// Crea (o devuelve, si ya existe) la carpeta aislada de la tarea. Devuelve su ruta.
pub fn create(project: &str, task: u64) -> Result<String, String> {
    let root = root_of(project)?;
    let _g = LOCK.lock().map_err(|e| e.to_string())?;
    ensure_at(&root)?;
    let ws = ws_dir(&root, task);
    if ws.join(".git").exists() {
        return Ok(ws.display().to_string());
    }
    // Byte a byte: ni un `.gitattributes` del proyecto puede convertir saltos de línea en la copia
    // (info/attributes manda sobre los del proyecto).
    let attrs = repo_dir(&root).join("info").join("attributes");
    if !attrs.exists() {
        let _ = std::fs::write(&attrs, "* -text\n");
    }
    let base = snapshot_project(&root)?;
    git(&root, &["update-ref", &base_ref(task), &base])?;
    if let Some(dir) = ws.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let out = base_cmd()
        .arg(format!("--git-dir={}", repo_dir(&root).display()))
        // Sin conversión de saltos de línea: la copia tiene que ser idéntica al proyecto, byte a byte.
        .args(["-c", "core.longpaths=true", "-c", "core.autocrlf=false", "worktree", "add", "--detach", "-q"])
        .arg(&ws)
        .arg(&base)
        .output()
        .map_err(|e| format!("no pude ejecutar git: {e}"))?;
    if !out.status.success() {
        let _ = git(&root, &["update-ref", "-d", &base_ref(task)]);
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    link_shared(&root, &ws);
    Ok(ws.display().to_string())
}

/// ¿La tarea tiene su carpeta aislada?
pub fn exists(project: &str, task: u64) -> bool {
    root_of(project).map(|r| ws_dir(&r, task).join(".git").exists()).unwrap_or(false)
}

/// Trae a la copia lo que cambió en el proyecto desde la base. Devuelve los archivos que chocaron
/// (quedan con marcas `<<<<<<<` en la copia) y deja la base en el estado actual del proyecto.
fn sync_locked(root: &Path, ws: &Path, task: u64) -> Result<Vec<String>, String> {
    let base = git(root, &["rev-parse", &base_ref(task)])?.trim().to_string();
    let now = snapshot_project(root)?;
    let mut conflicts = Vec::new();
    for (_, path) in changes(root, &base, &now)? {
        let target = ws.join(&path);
        let b = blob(root, &base, &path);
        let p = blob(root, &now, &path);
        let w = read(&target);
        if w == b {
            // La copia no lo tocó: se queda con lo del proyecto.
            write(&target, p.as_deref())?;
        } else if w == p {
            // Los dos llegaron a lo mismo.
        } else {
            match (w.as_deref(), b.as_deref(), p.as_deref()) {
                (Some(w), Some(b), Some(p)) => match merge3(root, task, w, b, p) {
                    Some((merged, clash)) => {
                        write(&target, Some(&merged))?;
                        if clash {
                            conflicts.push(path.clone());
                        }
                    }
                    None => conflicts.push(path.clone()),
                },
                // Uno lo borró y el otro lo cambió, o los dos lo crearon distinto: lo decide el agente.
                _ => conflicts.push(path.clone()),
            }
        }
    }
    git(root, &["update-ref", &base_ref(task), &now])?;
    Ok(conflicts)
}

/// Resultado de unir una entrega al proyecto.
pub enum Delivery {
    /// Se copió al proyecto: rutas absolutas de lo que cambió.
    Merged(Vec<String>),
    /// Chocó con cambios del proyecto: rutas (relativas) que quedaron marcadas en la copia.
    Conflict(Vec<String>),
}

/// Une al proyecto el trabajo de la copia. Primero la pone al día con el proyecto; si algo choca,
/// no toca el proyecto.
pub fn deliver(project: &str, task: u64) -> Result<Delivery, String> {
    let root = root_of(project)?;
    let _g = LOCK.lock().map_err(|e| e.to_string())?;
    let ws = ws_dir(&root, task);
    if !ws.join(".git").exists() {
        return Err(format!("la tarea #{task} no tiene carpeta aislada"));
    }
    let conflicts = sync_locked(&root, &ws, task)?;
    if !conflicts.is_empty() {
        return Ok(Delivery::Conflict(conflicts));
    }
    let base = git(&root, &["rev-parse", &base_ref(task)])?.trim().to_string();
    let work = snapshot_ws(&root, &ws, task)?;
    let mut merged = Vec::new();
    for (st, path) in changes(&root, &base, &work)? {
        let dest = root.join(&path);
        let data = if st == 'D' { None } else { read(&ws.join(&path)) };
        write(&dest, data.as_deref())?;
        merged.push(dest.display().to_string());
    }
    git(&root, &["update-ref", &base_ref(task), &work])?;
    Ok(Delivery::Merged(merged))
}

/// Los cambios de la copia frente a su base, como diff (para que el líder revise sin unir aún).
pub fn diff(project: &str, task: u64, cap: usize) -> Result<String, String> {
    let root = root_of(project)?;
    let _g = LOCK.lock().map_err(|e| e.to_string())?;
    let ws = ws_dir(&root, task);
    let base = git(&root, &["rev-parse", &base_ref(task)])?.trim().to_string();
    let work = snapshot_ws(&root, &ws, task)?;
    let mut d = git(&root, &["diff", "--no-renames", "--stat", "-p", &base, &work])?;
    if d.len() > cap {
        let mut cut = cap;
        while !d.is_char_boundary(cut) {
            cut -= 1;
        }
        d.truncate(cut);
        d.push_str("\n… (diff recortado)");
    }
    Ok(d)
}

/// Borra la carpeta aislada de la tarea (tras unirla, o si la tarea se borra).
pub fn discard(project: &str, task: u64) -> Result<(), String> {
    let root = root_of(project)?;
    let _g = LOCK.lock().map_err(|e| e.to_string())?;
    let ws = ws_dir(&root, task);
    if ws.exists() {
        // Antes de borrar nada, fuera los enlaces: así nunca se toca node_modules del proyecto.
        unlink_shared(&ws)?;
        let removed = base_cmd()
            .arg(format!("--git-dir={}", repo_dir(&root).display()))
            .args(["worktree", "remove", "--force"])
            .arg(&ws)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !removed && ws.exists() {
            std::fs::remove_dir_all(&ws).map_err(|e| format!("no pude borrar la carpeta aislada: {e}"))?;
        }
    }
    let _ = git(&root, &["worktree", "prune"]);
    let _ = git(&root, &["update-ref", "-d", &base_ref(task)]);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lienzo-ws-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src").join("a.txt"), "uno\ndos\ntres\ncuatro\ncinco\n").unwrap();
        std::fs::write(dir.join("b.txt"), "b\n").unwrap();
        dir
    }

    fn text(p: PathBuf) -> String {
        std::fs::read_to_string(p).unwrap_or_default()
    }

    #[test]
    fn isolated_work_lands_in_the_project_only_on_delivery() {
        let root = project("entrega");
        let proj = root.display().to_string();
        let ws = PathBuf::from(create(&proj, 7).unwrap());
        assert_eq!(text(ws.join("src").join("a.txt")), "uno\ndos\ntres\ncuatro\ncinco\n", "la copia parte del proyecto");
        std::fs::write(ws.join("src").join("a.txt"), "UNO\ndos\ntres\ncuatro\ncinco\n").unwrap();
        std::fs::write(ws.join("nuevo.md"), "hola\n").unwrap();
        std::fs::remove_file(ws.join("b.txt")).unwrap();
        assert!(!root.join("nuevo.md").exists(), "el proyecto no cambia mientras trabaja");
        // Mientras, otro cambia otra línea del mismo archivo en el proyecto.
        std::fs::write(root.join("src").join("a.txt"), "uno\ndos\ntres\ncuatro\nCINCO\n").unwrap();
        let Delivery::Merged(files) = deliver(&proj, 7).unwrap() else { panic!("no debía chocar") };
        assert_eq!(text(root.join("src").join("a.txt")), "UNO\ndos\ntres\ncuatro\nCINCO\n", "se unen los dos cambios");
        assert_eq!(text(root.join("nuevo.md")), "hola\n");
        assert!(!root.join("b.txt").exists(), "lo borrado en la copia se borra");
        assert_eq!(files.len(), 3, "{files:?}");
        discard(&proj, 7).unwrap();
        assert!(!ws.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn clashes_stay_in_the_copy_marked() {
        let root = project("choque");
        let proj = root.display().to_string();
        let ws = PathBuf::from(create(&proj, 8).unwrap());
        std::fs::write(ws.join("src").join("a.txt"), "uno\nDOS copia\ntres\ncuatro\ncinco\n").unwrap();
        std::fs::write(root.join("src").join("a.txt"), "uno\nDOS proyecto\ntres\ncuatro\ncinco\n").unwrap();
        let Delivery::Conflict(c) = deliver(&proj, 8).unwrap() else { panic!("debía chocar") };
        assert_eq!(c, vec!["src/a.txt".to_string()]);
        assert_eq!(text(root.join("src").join("a.txt")), "uno\nDOS proyecto\ntres\ncuatro\ncinco\n", "el proyecto no se toca");
        assert!(text(ws.join("src").join("a.txt")).contains("<<<<<<< tu copia"), "la copia queda marcada");
        // El agente lo resuelve y vuelve a entregar: ahora sí entra.
        std::fs::write(ws.join("src").join("a.txt"), "uno\nDOS las dos\ntres\ncuatro\ncinco\n").unwrap();
        let Delivery::Merged(_) = deliver(&proj, 8).unwrap() else { panic!("ya resuelto") };
        assert_eq!(text(root.join("src").join("a.txt")), "uno\nDOS las dos\ntres\ncuatro\ncinco\n");
        discard(&proj, 8).unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn shared_folders_are_linked_and_survive_the_cleanup() {
        let root = project("enlaces");
        std::fs::create_dir_all(root.join("node_modules").join("pkg")).unwrap();
        std::fs::write(root.join("node_modules").join("pkg").join("index.js"), "x").unwrap();
        // También los de subcarpetas (web/node_modules), pero no los de carpetas que no están en la copia.
        std::fs::create_dir_all(root.join("src").join("node_modules").join("lib")).unwrap();
        std::fs::write(root.join("src").join("node_modules").join("lib").join("i.js"), "y").unwrap();
        std::fs::create_dir_all(root.join("vacia").join(".venv")).unwrap();
        let proj = root.display().to_string();
        let ws = PathBuf::from(create(&proj, 9).unwrap());
        assert!(ws.join("node_modules").join("pkg").join("index.js").exists(), "la copia ve node_modules");
        assert!(ws.join("src").join("node_modules").join("lib").join("i.js").exists(), "y el de la subcarpeta");
        assert!(!ws.join("vacia").exists(), "una carpeta sin archivos del proyecto no se crea");
        discard(&proj, 9).unwrap();
        assert!(root.join("node_modules").join("pkg").join("index.js").exists(), "borrar la copia no toca el original");
        assert!(root.join("src").join("node_modules").join("lib").join("i.js").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn las_copias_salen_de_onedrive() {
        let local = Path::new(r"C:\Local\lienzo\tareas");
        let od = vec![r"C:\Users\x\OneDrive".to_string()];
        let inside = tasks_root_in(Path::new(r"\\?\C:\Users\x\OneDrive\Escritorio\Mi app"), &od, local);
        assert!(inside.starts_with(local), "{}", inside.display());
        // La misma carpeta escrita de otra forma da la misma huella.
        assert_eq!(inside, tasks_root_in(Path::new(r"c:/users/x/onedrive/escritorio/mi app/"), &od, local));
        // Fuera de OneDrive (o una carpeta que solo empieza igual), dentro del proyecto.
        let out = tasks_root_in(Path::new(r"C:\Projects\app"), &od, local);
        assert_eq!(out, Path::new(r"C:\Projects\app").join(".lienzo").join("tareas"));
        let near = tasks_root_in(Path::new(r"C:\Users\x\OneDriveViejo\app"), &od, local);
        assert!(!near.starts_with(local));
    }
}
