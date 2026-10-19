//! «App en vivo»: arranca el proyecto (su `npm run dev`, o un servidor de archivos si es una web
//! suelta) y da la dirección para verlo dentro de lienzo. Una app a la vez.

use serde::Serialize;
use std::io::{BufRead, BufReader, Read};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

const LOG_CAP: usize = 400;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Detect {
    /// npm | static | none
    pub kind: String,
    /// Lo que se ejecuta («npm run dev») o la página que se abre («index.html»).
    pub cmd: String,
    /// Falta `npm install` antes de arrancar.
    pub install: bool,
}

#[derive(Serialize, Clone, Default)]
pub struct Status {
    pub project: String,
    pub kind: String,
    pub cmd: String,
    pub running: bool,
    pub url: Option<String>,
    pub log: Vec<String>,
    pub exit: Option<i32>,
    pub started_ms: u64,
}

#[derive(Default)]
struct App {
    epoch: u64,
    status: Status,
    child: Option<Child>,
    server: Option<Arc<tiny_http::Server>>,
}

static APP: Mutex<Option<App>> = Mutex::new(None);

fn with<R>(f: impl FnOnce(&mut App) -> R) -> R {
    let mut g = APP.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(App::default))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn no_window(c: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    let _ = c;
}

/// Cómo se arranca este proyecto.
pub fn detect(root: &Path) -> Detect {
    let pkg = root.join("package.json");
    if let Ok(text) = std::fs::read_to_string(&pkg) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            let scripts = &v["scripts"];
            let cmd = if scripts["dev"].is_string() {
                Some("npm run dev")
            } else if scripts["start"].is_string() {
                Some("npm start")
            } else if scripts["serve"].is_string() {
                Some("npm run serve")
            } else {
                None
            };
            if let Some(cmd) = cmd {
                return Detect { kind: "npm".into(), cmd: cmd.into(), install: !root.join("node_modules").is_dir() };
            }
        }
    }
    if root.join("index.html").is_file() {
        return Detect { kind: "static".into(), cmd: "index.html".into(), install: false };
    }
    let mut pages: Vec<String> = std::fs::read_dir(root)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| n.to_lowercase().ends_with(".html") || n.to_lowercase().ends_with(".htm"))
                .collect()
        })
        .unwrap_or_default();
    pages.sort();
    if let Some(p) = pages.into_iter().next() {
        return Detect { kind: "static".into(), cmd: p, install: false };
    }
    Detect { kind: "none".into(), cmd: String::new(), install: false }
}

/// Quita los colores y movimientos de cursor de una línea de la consola.
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\u{1b}' {
            if it.peek() == Some(&'[') {
                it.next();
                while let Some(&n) = it.peek() {
                    it.next();
                    if ('@'..='~').contains(&n) {
                        break;
                    }
                }
            }
            continue;
        }
        if c == '\r' || (c.is_control() && c != '\t') {
            continue;
        }
        out.push(c);
    }
    out
}

/// La dirección local que anuncia un servidor de desarrollo («Local: http://localhost:5173/»).
pub fn find_url(line: &str) -> Option<String> {
    for pre in ["http://localhost:", "http://127.0.0.1:", "http://[::1]:", "https://localhost:"] {
        if let Some(i) = line.find(pre) {
            let url: String = line[i..].chars().take_while(|c| !c.is_whitespace() && *c != ',' && *c != ')').collect();
            if url.len() > pre.len() {
                return Some(url);
            }
        }
    }
    None
}

fn push_log(epoch: u64, line: String) {
    with(|a| {
        if a.epoch != epoch {
            return;
        }
        if a.status.url.is_none() {
            if let Some(u) = find_url(&line) {
                a.status.url = Some(u);
            }
        }
        a.status.log.push(line);
        let n = a.status.log.len();
        if n > LOG_CAP {
            a.status.log.drain(..n - LOG_CAP);
        }
    });
}

fn pump(epoch: u64, r: impl Read + Send + 'static) {
    std::thread::spawn(move || {
        let mut br = BufReader::new(r);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match br.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = strip_ansi(&String::from_utf8_lossy(&buf));
                    if !line.trim().is_empty() {
                        push_log(epoch, line.trim_end().to_string());
                    }
                }
            }
        }
    });
}

fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).as_deref() {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("wasm") => "application/wasm",
        Some("glb") => "model/gltf-binary",
        Some("gltf") => "model/gltf+json",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("ogg") => "audio/ogg",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("txt" | "md") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Archivo del proyecto para una URL del servidor de archivos (None si se sale de la carpeta).
fn file_for(root: &Path, url: &str) -> Option<PathBuf> {
    let path = url.split(['?', '#']).next().unwrap_or("");
    let rel = percent_decode(path.trim_start_matches('/'));
    let mut out = root.to_path_buf();
    for c in Path::new(&rel).components() {
        match c {
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            _ => return None,
        }
    }
    if out.is_dir() {
        out.push("index.html");
    }
    Some(out)
}

fn serve_static(epoch: u64, root: PathBuf, page: String) -> Result<(), String> {
    let server = Arc::new(tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?);
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
    let page = if page == "index.html" { String::new() } else { page };
    with(|a| {
        a.server = Some(server.clone());
        a.status.url = Some(format!("http://127.0.0.1:{port}/{page}"));
        a.status.log.push(format!("Sirviendo {} en http://127.0.0.1:{port}/", root.display()));
    });
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            let url = req.url().to_string();
            let file = file_for(&root, &url).filter(|f| f.is_file());
            let resp = match file.and_then(|f| std::fs::read(&f).ok().map(|d| (f, d))) {
                Some((f, data)) => {
                    let h = tiny_http::Header::from_bytes(&b"Content-Type"[..], mime(&f).as_bytes()).unwrap();
                    let nc = tiny_http::Header::from_bytes(&b"Cache-Control"[..], &b"no-store"[..]).unwrap();
                    tiny_http::Response::from_data(data).with_header(h).with_header(nc)
                }
                None => {
                    push_log(epoch, format!("404 {url}"));
                    tiny_http::Response::from_data(b"No encontrado".to_vec()).with_status_code(404)
                }
            };
            let _ = req.respond(resp);
        }
    });
    Ok(())
}

fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let mut c = Command::new("taskkill");
        c.args(["/PID", &child.id().to_string(), "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null());
        no_window(&mut c);
        let _ = c.status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Para la app que esté en marcha (si hay).
pub fn stop() {
    let (child, server) = with(|a| {
        a.epoch += 1;
        a.status.running = false;
        (a.child.take(), a.server.take())
    });
    if let Some(mut c) = child {
        kill_tree(&mut c);
    }
    if let Some(s) = server {
        s.unblock();
    }
}

pub fn start(project: &str) -> Result<Status, String> {
    stop();
    let root = PathBuf::from(project.trim());
    if !root.is_dir() {
        return Err("la carpeta del proyecto no existe".into());
    }
    let d = detect(&root);
    if d.kind == "none" {
        return Err("no sé cómo arrancar este proyecto: no tiene package.json con «dev»/«start» ni un .html".into());
    }
    let epoch = with(|a| {
        a.epoch += 1;
        a.status = Status {
            project: project.trim().to_string(),
            kind: d.kind.clone(),
            cmd: if d.install { format!("npm install && {}", d.cmd) } else { d.cmd.clone() },
            running: true,
            started_ms: now_ms(),
            ..Status::default()
        };
        a.epoch
    });
    if d.kind == "static" {
        serve_static(epoch, root, d.cmd)?;
        return Ok(status());
    }
    let line = if d.install { format!("npm install && {}", d.cmd) } else { d.cmd.clone() };
    push_log(epoch, format!("> {line}"));
    let mut c = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/D", "/C", &line]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", &line]);
        c
    };
    c.current_dir(&root)
        .env("BROWSER", "none")
        .env("FORCE_COLOR", "0")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    no_window(&mut c);
    let mut child = c.spawn().map_err(|e| format!("no pude arrancar «{line}»: {e}"))?;
    if let Some(o) = child.stdout.take() {
        pump(epoch, o);
    }
    if let Some(e) = child.stderr.take() {
        pump(epoch, e);
    }
    with(|a| a.child = Some(child));
    // Vigila cuándo termina (sin quedarse con el candado mientras espera).
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let done = with(|a| {
            if a.epoch != epoch {
                return true;
            }
            let Some(ch) = a.child.as_mut() else { return true };
            match ch.try_wait() {
                Ok(Some(st)) => {
                    a.status.running = false;
                    a.status.exit = Some(st.code().unwrap_or(-1));
                    a.child = None;
                    true
                }
                Ok(None) => false,
                Err(_) => true,
            }
        });
        if done {
            break;
        }
    });
    Ok(status())
}

pub fn status() -> Status {
    with(|a| a.status.clone())
}

#[tauri::command]
pub async fn app_detect(path: String) -> Result<Detect, String> {
    let root = PathBuf::from(path.trim());
    if !root.is_dir() {
        return Err("la carpeta del proyecto no existe".into());
    }
    Ok(detect(&root))
}

#[tauri::command]
pub async fn app_start(path: String) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || start(&path)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn app_stop() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(stop).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn app_status() -> Result<Status, String> {
    Ok(status())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lee_la_direccion_de_vite() {
        let l = strip_ansi("  \u{1b}[32m➜\u{1b}[39m  \u{1b}[1mLocal\u{1b}[22m:   \u{1b}[36mhttp://localhost:\u{1b}[1m5173\u{1b}[22m/\u{1b}[39m");
        assert_eq!(find_url(&l).as_deref(), Some("http://localhost:5173/"));
        assert_eq!(find_url("Network: use --host to expose"), None);
        assert_eq!(find_url("ready on http://127.0.0.1:3000, ok").as_deref(), Some("http://127.0.0.1:3000"));
    }

    #[test]
    fn sabe_como_arrancar() {
        let d = std::env::temp_dir().join(format!("lienzo-app-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        assert_eq!(detect(&d).kind, "none");
        std::fs::write(d.join("juego.html"), "<p>hola</p>").unwrap();
        assert_eq!(detect(&d), Detect { kind: "static".into(), cmd: "juego.html".into(), install: false });
        std::fs::write(d.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#).unwrap();
        assert_eq!(detect(&d), Detect { kind: "npm".into(), cmd: "npm run dev".into(), install: true });
        std::fs::create_dir_all(d.join("node_modules")).unwrap();
        assert!(!detect(&d).install);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Arranca de verdad un proyecto (LIENZO_APP_TEST=carpeta) y lo para.
    #[test]
    #[ignore]
    fn arranca_y_para_de_verdad() {
        let dir = std::env::var("LIENZO_APP_TEST").expect("LIENZO_APP_TEST");
        start(&dir).unwrap();
        let mut url = None;
        for _ in 0..120 {
            std::thread::sleep(std::time::Duration::from_millis(250));
            let s = status();
            if s.url.is_some() || !s.running {
                url = s.url.clone();
                eprintln!("{}", s.log.join("\n"));
                break;
            }
        }
        let url = url.expect("sin dirección");
        eprintln!("URL {url}");
        stop();
        std::thread::sleep(std::time::Duration::from_millis(1500));
        let port = url.rsplit(':').next().unwrap().trim_end_matches('/').to_string();
        let still = std::net::TcpStream::connect(format!("127.0.0.1:{port}")).is_ok()
            || std::net::TcpStream::connect(format!("[::1]:{port}")).is_ok();
        assert!(!still, "el servidor sigue vivo en {port}");
    }

    #[test]
    fn el_servidor_no_sale_de_la_carpeta() {
        let root = PathBuf::from(r"C:\proy");
        assert_eq!(file_for(&root, "/src/a%20b.js?v=1"), Some(root.join("src").join("a b.js")));
        assert_eq!(file_for(&root, "/../secreto.txt"), None);
        assert_eq!(file_for(&root, "/%2e%2e/secreto.txt"), None);
    }
}
