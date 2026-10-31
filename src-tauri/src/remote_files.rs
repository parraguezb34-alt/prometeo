//! Descargas del acceso remoto: `GET /files?path=…&t=TOKEN` baja al iPad un archivo del proyecto.
//!
//! Solo archivos que estén dentro de la carpeta del proyecto abierto (tras resolver `..`,
//! enlaces y mayúsculas); nada de carpetas ni rutas de fuera. El token va en la consulta porque
//! un enlace de descarga del navegador no puede llevar cabeceras; remote.rs lo comprueba antes.
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tiny_http::{Header, Request, Response, StatusCode};

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name, value).expect("valid HTTP header")
}

fn error(req: Request, status: u16, msg: &str) {
    let body = serde_json::json!({ "error": msg }).to_string();
    let _ = req.respond(
        Response::from_data(body.into_bytes())
            .with_status_code(StatusCode(status))
            .with_header(header("Content-Type", "application/json; charset=utf-8")),
    );
}

fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = |b: u8| (b as char).to_digit(16);
                if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                    out.push((h * 16 + l) as u8);
                    i += 3;
                    continue;
                }
                out.push(b'%');
            }
            b'+' => out.push(b' '),
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn query_param(url: &str, key: &str) -> Option<String> {
    url.split_once('?')?.1.split('&').find_map(|p| {
        let (k, v) = p.split_once('=').unwrap_or((p, ""));
        (k == key).then(|| decode(v))
    })
}

/// La ruta real de `raw` si es un archivo dentro de `project`. `raw` puede ser absoluta o
/// relativa al proyecto, con `/` o `\`.
pub fn resolve_in_project(project: &Path, raw: &str) -> Result<PathBuf, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("falta la ruta".into());
    }
    let p = Path::new(raw);
    let full = if p.is_absolute() { p.to_path_buf() } else { project.join(p) };
    let real = full.canonicalize().map_err(|_| "no existe".to_string())?;
    let root = project.canonicalize().map_err(|_| "el proyecto no existe".to_string())?;
    if !real.starts_with(&root) {
        return Err("fuera del proyecto".into());
    }
    if !real.is_file() {
        return Err("solo se pueden descargar archivos".into());
    }
    Ok(real)
}

fn mime_of(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "heic" => "image/heic",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "json" => "application/json",
        "csv" => "text/csv; charset=utf-8",
        "txt" | "md" | "log" | "rs" | "ts" | "tsx" | "js" | "py" | "html" | "css" | "toml" | "yaml" | "yml" => {
            "text/plain; charset=utf-8"
        }
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    }
}

/// `attachment; filename="…"; filename*=UTF-8''…` con el nombre real (acentos incluidos).
fn disposition(name: &str, inline: bool) -> String {
    let ascii: String = name
        .chars()
        .map(|c| if c.is_ascii_graphic() && c != '"' && c != '\\' || c == ' ' { c } else { '_' })
        .collect();
    let mut enc = String::new();
    for b in name.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            enc.push(b as char);
        } else {
            enc.push_str(&format!("%{b:02X}"));
        }
    }
    let kind = if inline { "inline" } else { "attachment" };
    format!("{kind}; filename=\"{ascii}\"; filename*=UTF-8''{enc}")
}

/// Atiende `GET /files`. El token ya lo comprobó remote.rs.
pub fn serve(app: &AppHandle, url: &str, req: Request) {
    let Some(project) = crate::hub::with_inner(app, |i| i.project.clone()).flatten() else {
        return error(req, 409, "no hay proyecto abierto en el PC");
    };
    let raw = query_param(url, "path").unwrap_or_default();
    let path = match resolve_in_project(Path::new(&project), &raw) {
        Ok(p) => p,
        Err(e) => return error(req, if e == "no existe" { 404 } else { 403 }, &e),
    };
    let file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(e) => return error(req, 404, &e.to_string()),
    };
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("archivo");
    let inline = query_param(url, "inline").is_some_and(|v| v == "1");
    let _ = req.respond(
        Response::from_file(file)
            .with_header(header("Content-Type", mime_of(&path)))
            .with_header(header("Content-Disposition", &disposition(name, inline)))
            .with_header(header("Cache-Control", "no-store"))
            .with_header(header("X-Content-Type-Options", "nosniff")),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_project() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lienzo-files-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("proj/sub")).unwrap();
        std::fs::write(dir.join("proj/sub/a.txt"), "hola").unwrap();
        std::fs::write(dir.join("secreto.txt"), "no").unwrap();
        dir
    }

    #[test]
    fn only_files_inside_the_project_are_served() {
        let dir = tmp_project();
        let proj = dir.join("proj");
        assert!(resolve_in_project(&proj, "sub/a.txt").is_ok());
        assert!(resolve_in_project(&proj, r"sub\a.txt").is_ok());
        let abs = proj.join("sub/a.txt");
        assert!(resolve_in_project(&proj, abs.to_str().unwrap()).is_ok());
        assert_eq!(resolve_in_project(&proj, "../secreto.txt").unwrap_err(), "fuera del proyecto");
        assert_eq!(resolve_in_project(&proj, "sub/../../secreto.txt").unwrap_err(), "fuera del proyecto");
        let outside = dir.join("secreto.txt");
        assert_eq!(resolve_in_project(&proj, outside.to_str().unwrap()).unwrap_err(), "fuera del proyecto");
        assert_eq!(resolve_in_project(&proj, "sub").unwrap_err(), "solo se pueden descargar archivos");
        assert_eq!(resolve_in_project(&proj, "nada.txt").unwrap_err(), "no existe");
        assert!(resolve_in_project(&proj, "").is_err());
        // Un proyecto hermano con el mismo prefijo no cuela («proj» vs «proj2»).
        std::fs::create_dir_all(dir.join("proj2")).unwrap();
        std::fs::write(dir.join("proj2/b.txt"), "x").unwrap();
        assert_eq!(resolve_in_project(&proj, "../proj2/b.txt").unwrap_err(), "fuera del proyecto");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn query_and_header_encoding() {
        assert_eq!(
            query_param("/files?path=C%3A%5Cx%5Cinforme%20final.pdf&t=abc", "path").as_deref(),
            Some(r"C:\x\informe final.pdf")
        );
        assert_eq!(query_param("/files?t=abc&inline=1", "inline").as_deref(), Some("1"));
        assert_eq!(query_param("/files?t=abc", "path"), None);
        let d = disposition("presentación \"v2\".pdf", false);
        assert!(d.starts_with("attachment; filename=\"presentaci_n _v2_.pdf\""), "{d}");
        assert!(d.ends_with("filename*=UTF-8''presentaci%C3%B3n%20%22v2%22.pdf"), "{d}");
        assert!(d.is_ascii());
        assert!(disposition("a.png", true).starts_with("inline;"));
        assert_eq!(mime_of(Path::new("X.PDF")), "application/pdf");
        assert_eq!(mime_of(Path::new("raro.bin")), "application/octet-stream");
    }
}
