//! Ventana de solo lectura a la carpeta del proyecto del equipo: git, listados
//! y lecturas de archivo para las pestanas de Cambios, Preview y Archivos del
//! centro de mando.
//!
//! Todo se valida contra la raiz canonicalizada del proyecto: nunca se sale de
//! esa carpeta, y las lecturas van con tope de tamano.

use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;

const READ_CAP: usize = 512 * 1024;
const DIFF_CAP: usize = 400 * 1024;
const WALK_CAP: usize = 8000;
const NOISE_DIRS: [&str; 9] = [
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    "venv",
    ".venv",
    "__pycache__",
];

#[derive(Serialize)]
pub struct GitFile {
    path: String,
    status: String,
}

#[derive(Serialize)]
pub struct GitStatus {
    repo: bool,
    branch: String,
    files: Vec<GitFile>,
    diff: String,
    truncated: bool,
}

#[derive(Serialize)]
pub struct Entry {
    name: String,
    rel: String,
    dir: bool,
    size: u64,
    mtime_ms: u64,
}

#[derive(Serialize)]
pub struct FileData {
    text: String,
    truncated: bool,
    binary: bool,
    size: u64,
    mtime_ms: u64,
}

#[derive(Serialize)]
pub struct RecentFile {
    rel: String,
    mtime_ms: u64,
    size: u64,
}

#[derive(Serialize)]
pub struct TaskDiff {
    diff: String,
    files: Vec<GitFile>,
    truncated: bool,
}

fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn root_of(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path.trim());
    if !p.is_dir() {
        return Err("la carpeta del proyecto no existe".into());
    }
    p.canonicalize().map_err(|e| e.to_string())
}

/// Join a project-relative path, rejecting anything that escapes the root.
fn join_rel(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let mut out = root.to_path_buf();
    for comp in Path::new(rel.trim()).components() {
        match comp {
            Component::Normal(c) => out.push(c),
            Component::CurDir => {}
            _ => return Err("ruta fuera del proyecto".into()),
        }
    }
    Ok(out)
}

fn git(path: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .map_err(|e| format!("no pude ejecutar git: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(err.trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn is_noise(name: &str) -> bool {
    NOISE_DIRS.contains(&name)
}

fn git_with_paths(path: &Path, pre: &[&str], paths: &[String]) -> Result<String, String> {
    let mut args: Vec<&str> = pre.to_vec();
    args.extend(paths.iter().map(|s| s.as_str()));
    git(path, &args)
}

/// Normaliza y valida una lista de rutas relativas al proyecto (sin salirse de
/// la raiz; si existen, tambien sin escapar por symlinks). Deduplica y acota.
fn clean_paths(root: &Path, paths: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in paths.iter().take(300) {
        let rel = raw.trim().replace('\\', "/");
        if rel.is_empty() {
            continue;
        }
        let Ok(abs) = join_rel(root, &rel) else { continue };
        if let Ok(canon) = abs.canonicalize() {
            if !canon.starts_with(root) {
                continue;
            }
        }
        if !out.contains(&rel) {
            out.push(rel);
        }
    }
    out
}

fn slice_diff(diff: &mut String) -> bool {
    if diff.len() <= DIFF_CAP {
        return false;
    }
    let mut cut = DIFF_CAP;
    while cut > 0 && !diff.is_char_boundary(cut) {
        cut -= 1;
    }
    diff.truncate(cut);
    true
}

fn status_files(root: &Path, paths: &[String]) -> Vec<GitFile> {
    let mut files = Vec::new();
    let Ok(porcelain) = git_with_paths(root, &["status", "--porcelain=v1", "-uall", "--"], paths)
    else {
        return files;
    };
    for line in porcelain.lines() {
        if line.len() < 4 {
            continue;
        }
        let code = line[..2].trim().to_string();
        let mut p = line[3..].to_string();
        if let Some(idx) = p.find(" -> ") {
            p = p[idx + 4..].to_string();
        }
        files.push(GitFile {
            path: p,
            status: if code.is_empty() { "?".into() } else { code },
        });
    }
    files
}

/// Repo, rama actual y raiz canonica del proyecto.
#[tauri::command]
pub fn project_info(path: String) -> Result<Value, String> {
    let root = root_of(&path)?;
    let branch = git(&root, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
    let repo = !branch.trim().is_empty() || git(&root, &["rev-parse", "--git-dir"]).is_ok();
    Ok(json!({
        "root": root.display().to_string(),
        "repo": repo,
        "branch": branch.trim(),
    }))
}

/// Cambios del arbol de trabajo: estado por archivo + diff unificado con HEAD.
#[tauri::command]
pub fn project_status(path: String) -> Result<GitStatus, String> {
    let root = root_of(&path)?;
    let branch = git(&root, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
    if branch.trim().is_empty() && git(&root, &["rev-parse", "--git-dir"]).is_err() {
        return Ok(GitStatus {
            repo: false,
            branch: String::new(),
            files: vec![],
            diff: String::new(),
            truncated: false,
        });
    }
    let files = status_files(&root, &[]);
    // Diff contra HEAD (preparado + sin preparar). Si el repo aun no tiene
    // commits, cae al diff normal.
    let mut diff = git(&root, &["diff", "HEAD", "--no-color", "-U3"])
        .or_else(|_| git(&root, &["diff", "--no-color", "-U3"]))
        .unwrap_or_default();
    let truncated = slice_diff(&mut diff);
    Ok(GitStatus {
        repo: true,
        branch: branch.trim().to_string(),
        files,
        diff,
        truncated,
    })
}

/// Diff + estado limitado a las rutas de una tarea (revision por tarea).
#[tauri::command]
pub fn project_diff_paths(path: String, paths: Vec<String>) -> Result<TaskDiff, String> {
    let root = root_of(&path)?;
    let clean = clean_paths(&root, &paths);
    if clean.is_empty() {
        return Ok(TaskDiff {
            diff: String::new(),
            files: vec![],
            truncated: false,
        });
    }
    let files = status_files(&root, &clean);
    let mut diff = git_with_paths(&root, &["diff", "HEAD", "--no-color", "-U3", "--"], &clean)
        .or_else(|_| git_with_paths(&root, &["diff", "--no-color", "-U3", "--"], &clean))
        .unwrap_or_default();
    let truncated = slice_diff(&mut diff);
    Ok(TaskDiff {
        diff,
        files,
        truncated,
    })
}

/// Confirma (commit) los archivos de una tarea, solo esas rutas.
#[tauri::command]
pub fn project_commit_paths(
    path: String,
    paths: Vec<String>,
    message: String,
) -> Result<String, String> {
    let root = root_of(&path)?;
    let clean = clean_paths(&root, &paths);
    let msg: String = message.trim().chars().take(200).collect();
    if msg.is_empty() {
        return Err("falta el mensaje del commit".into());
    }
    // Solo rutas que git puede confirmar: con seguimiento, o nuevas y no
    // ignoradas.
    let mut targets: Vec<String> = Vec::new();
    for rel in &clean {
        let tracked = git(&root, &["ls-files", "--error-unmatch", "--", rel]).is_ok();
        let ignored = git(&root, &["check-ignore", "-q", "--", rel]).is_ok();
        let exists = join_rel(&root, rel)
            .map(|p| p.exists())
            .unwrap_or(false);
        if tracked || (exists && !ignored) {
            targets.push(rel.clone());
        }
    }
    if targets.is_empty() {
        return Err("esos archivos no están bajo git (ignorados o ausentes)".into());
    }
    git_with_paths(&root, &["add", "-A", "--"], &targets)?;
    match git_with_paths(&root, &["commit", "-m", &msg, "--"], &targets) {
        Ok(out) => Ok(out
            .lines()
            .next()
            .unwrap_or("commit hecho")
            .trim()
            .to_string()),
        Err(e) if e.contains("nothing to commit") || e.contains("nada para hacer commit") => {
            Err("esos archivos no tienen cambios nuevos que confirmar".into())
        }
        Err(e) => Err(e),
    }
}

/// Devuelve los archivos de una tarea al ultimo commit (destructivo).
#[tauri::command]
pub fn project_revert_paths(path: String, paths: Vec<String>) -> Result<String, String> {
    let root = root_of(&path)?;
    let clean = clean_paths(&root, &paths);
    if clean.is_empty() {
        return Err("no hay archivos de la tarea para revertir".into());
    }
    let mut restored = 0usize;
    let mut deleted = 0usize;
    let mut failed = 0usize;
    for rel in &clean {
        let Ok(abs) = join_rel(&root, rel) else { continue };
        let tracked = git(&root, &["ls-files", "--error-unmatch", "--", rel]).is_ok();
        if tracked {
            if git(&root, &["checkout", "HEAD", "--", rel]).is_ok() {
                restored += 1;
            } else {
                // Nuevo aun sin commit: fuera del indice y del disco.
                let _ = git(&root, &["rm", "--cached", "-f", "--", rel]);
                if std::fs::remove_file(&abs).is_ok() {
                    deleted += 1;
                } else {
                    failed += 1;
                }
            }
        } else if abs.exists() {
            if std::fs::remove_file(&abs).is_ok() {
                deleted += 1;
            } else {
                failed += 1;
            }
        }
    }
    let mut bits = Vec::new();
    if restored > 0 {
        bits.push(format!(
            "{restored} restaurado{}",
            if restored == 1 { "" } else { "s" }
        ));
    }
    if deleted > 0 {
        bits.push(format!(
            "{deleted} eliminado{}",
            if deleted == 1 { "" } else { "s" }
        ));
    }
    if bits.is_empty() && failed == 0 {
        bits.push("nada que revertir".to_string());
    }
    if failed > 0 {
        bits.push(format!("{failed} sin poder tocar"));
    }
    Ok(bits.join(", "))
}

/// Listado de una carpeta del proyecto (ordenado: carpetas primero).
#[tauri::command]
pub fn project_list(path: String, rel: String) -> Result<Vec<Entry>, String> {
    let root = root_of(&path)?;
    let dir = join_rel(&root, &rel)?;
    let meta = std::fs::metadata(&dir).map_err(|_| "la carpeta no existe".to_string())?;
    if !meta.is_dir() {
        return Err("no es una carpeta".into());
    }
    let parent = rel.trim().trim_end_matches(['/', '\\']).to_string();
    let mut out = Vec::new();
    for e in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if is_noise(&name) {
            continue;
        }
        let Ok(meta) = e.metadata() else { continue };
        let rel_child = if parent.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", parent, name)
        };
        out.push(Entry {
            name,
            rel: rel_child,
            dir: meta.is_dir(),
            size: meta.len(),
            mtime_ms: mtime_ms(&meta),
        });
    }
    out.sort_by(|a, b| {
        b.dir
            .cmp(&a.dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// Lee un archivo del proyecto (texto plano, con tope de 512 KB).
#[tauri::command]
pub fn project_read(path: String, rel: String) -> Result<FileData, String> {
    let root = root_of(&path)?;
    let file = join_rel(&root, &rel)?;
    let canon = file
        .canonicalize()
        .map_err(|_| "el archivo no existe".to_string())?;
    if !canon.starts_with(&root) {
        return Err("ruta fuera del proyecto".into());
    }
    let meta = std::fs::metadata(&canon).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("no es un archivo".into());
    }
    let raw = std::fs::read(&canon).map_err(|e| e.to_string())?;
    let truncated = raw.len() > READ_CAP;
    let slice = &raw[..raw.len().min(READ_CAP)];
    let binary = slice.iter().take(8192).any(|b| *b == 0);
    Ok(FileData {
        text: if binary {
            String::new()
        } else {
            String::from_utf8_lossy(slice).to_string()
        },
        truncated,
        binary,
        size: meta.len(),
        mtime_ms: mtime_ms(&meta),
    })
}

/// Archivos recientes del proyecto con las extensiones pedidas (para Preview).
#[tauri::command]
pub fn project_recent(
    path: String,
    exts: Vec<String>,
    limit: Option<usize>,
) -> Result<Vec<RecentFile>, String> {
    let root = root_of(&path)?;
    let wanted: Vec<String> = exts
        .iter()
        .map(|e| e.trim_start_matches('.').to_lowercase())
        .collect();
    let limit = limit.unwrap_or(40).clamp(1, 200);
    let mut out: Vec<RecentFile> = Vec::new();
    let mut stack = vec![root.clone()];
    let mut visited = 0usize;
    while let Some(dir) = stack.pop() {
        if visited > WALK_CAP {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            visited += 1;
            if visited > WALK_CAP {
                break;
            }
            let name = e.file_name().to_string_lossy().to_string();
            let Ok(meta) = e.metadata() else { continue };
            if meta.is_dir() {
                if !is_noise(&name) {
                    stack.push(e.path());
                }
                continue;
            }
            let lower = name.to_lowercase();
            let dot = match lower.rfind('.') {
                Some(i) => i,
                None => continue,
            };
            if !wanted.contains(&lower[dot + 1..].to_string()) {
                continue;
            }
            let Ok(canon) = e.path().canonicalize() else {
                continue;
            };
            if !canon.starts_with(&root) {
                continue;
            }
            let rel = canon
                .strip_prefix(&root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            out.push(RecentFile {
                rel,
                mtime_ms: mtime_ms(&meta),
                size: meta.len(),
            });
        }
    }
    out.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    out.truncate(limit);
    Ok(out)
}

const IMAGE_CAP: u64 = 12 * 1024 * 1024;

fn image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_string_lossy().to_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

/// Una imagen (captura) que un agente generó o miró, como `data:` URL para el chat.
/// Es la única lectura que puede salir del proyecto: las capturas suelen quedar en
/// carpetas temporales. Por eso solo acepta extensiones de imagen y con tope de tamaño.
#[tauri::command]
pub fn image_data(path: String, project: Option<String>) -> Result<String, String> {
    use base64::Engine;
    let raw = PathBuf::from(path.trim());
    let file = if raw.is_absolute() {
        raw
    } else {
        let root = root_of(project.as_deref().unwrap_or(""))?;
        join_rel(&root, &path)?
    };
    let mime = image_mime(&file).ok_or("no es una imagen")?;
    let meta = std::fs::metadata(&file).map_err(|_| "la imagen no existe".to_string())?;
    if !meta.is_file() {
        return Err("no es un archivo".into());
    }
    if meta.len() > IMAGE_CAP {
        return Err("la imagen es demasiado grande".into());
    }
    let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
    Ok(format!(
        "data:{};base64,{}",
        mime,
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// Guarda en el proyecto una imagen que pegaste o arrastraste al compositor
/// (`.lienzo/capturas/captura-<ms>.<ext>`) y devuelve su ruta absoluta, para pasársela
/// a los agentes: así ven lo mismo que tú.
#[tauri::command]
pub fn project_save_image(path: String, data: String, ext: Option<String>) -> Result<String, String> {
    use base64::Engine;
    let root = root_of(&path)?;
    let ext = match ext.as_deref().map(str::to_lowercase).as_deref() {
        Some("jpg") | Some("jpeg") => "jpg",
        Some("gif") => "gif",
        Some("webp") => "webp",
        _ => "png",
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|_| "la imagen no se pudo leer".to_string())?;
    if bytes.is_empty() || bytes.len() as u64 > IMAGE_CAP {
        return Err("la imagen está vacía o es demasiado grande".into());
    }
    let dir = root.join(".lienzo").join("capturas");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ms = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let file = dir.join(format!("captura-{ms}.{ext}"));
    std::fs::write(&file, bytes).map_err(|e| e.to_string())?;
    // `canonicalize` deja el prefijo `\\?\` de Windows: los agentes no lo esperan en una ruta.
    let shown = file.display().to_string();
    Ok(shown.strip_prefix(r"\\?\").unwrap_or(&shown).to_string())
}
