//! PTY session manager for Lienzo.
//!
//! Sessions survive frontend reloads: the backend keeps each pseudo-terminal
//! alive together with a scrollback ring buffer, so the UI can re-attach and
//! repaint an existing session instead of spawning a new one.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

/// Maximum bytes kept per session for re-attach repaints.
const SCROLLBACK_LIMIT: usize = 512 * 1024;

pub struct PtySession {
    pub writer: Box<dyn Write + Send>,
    pub master: Box<dyn MasterPty + Send>,
    pub child: Box<dyn Child + Send + Sync>,
    pub buffer: Arc<Mutex<VecDeque<u8>>>,
    pub running: Arc<AtomicBool>,
    pub title: String,
}

#[derive(Default)]
pub struct PtyManager(pub Mutex<HashMap<String, PtySession>>);

#[derive(Serialize)]
pub struct SessionInfo {
    pub id: String,
    pub title: String,
    pub running: bool,
}

#[derive(Serialize, Clone)]
struct DataPayload {
    id: String,
    data: String,
}

#[derive(Serialize, Clone)]
struct ExitPayload {
    id: String,
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn next_id() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("t{:x}{:x}", ms, COUNTER.fetch_add(1, Ordering::Relaxed))
}

fn which(program: &str) -> bool {
    std::process::Command::new("cmd")
        .args(["/C", "where", program])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn default_shell() -> String {
    for candidate in ["pwsh.exe", "powershell.exe", "cmd.exe"] {
        if which(candidate) {
            return candidate.to_string();
        }
    }
    "cmd.exe".to_string()
}

fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE")
        .ok()
        .or_else(|| std::env::var("HOME").ok())
}

fn append_scrollback(buffer: &Arc<Mutex<VecDeque<u8>>>, bytes: &[u8]) {
    if let Ok(mut b) = buffer.lock() {
        b.extend(bytes.iter().copied());
        while b.len() > SCROLLBACK_LIMIT {
            b.pop_front();
        }
    }
}

/// Spawn a new terminal session. Returns its id; the frontend subscribes to
/// `pty://data` and `pty://exit` events afterwards.
#[tauri::command]
pub fn term_spawn(
    app: AppHandle,
    state: State<'_, PtyManager>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<SessionInfo, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = default_shell();
    let mut cmd = CommandBuilder::new(shell.clone());
    cmd.env("TERM", "xterm-256color");
    // Any agent launched inside a lienzo terminal can find the team hub.
    for (key, value) in crate::hub::terminal_env_vars() {
        cmd.env(key, value);
    }
    let dir = cwd
        .filter(|d| std::path::Path::new(d).is_dir())
        .or_else(crate::hub::default_terminal_dir)
        .or_else(home_dir);
    if let Some(dir) = dir {
        cmd.cwd(dir);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = next_id();
    let buffer: Arc<Mutex<VecDeque<u8>>> = Arc::new(Mutex::new(VecDeque::new()));
    let running = Arc::new(AtomicBool::new(true));

    let thread_id = id.clone();
    let thread_buf = buffer.clone();
    let thread_running = running.clone();
    let thread_app = app.clone();
    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = &chunk[..n];
                    append_scrollback(&thread_buf, data);
                    let _ = thread_app.emit(
                        "pty://data",
                        DataPayload {
                            id: thread_id.clone(),
                            data: B64.encode(data),
                        },
                    );
                }
            }
        }
        thread_running.store(false, Ordering::SeqCst);
        let _ = thread_app.emit("pty://exit", ExitPayload { id: thread_id.clone() });
    });

    let info = SessionInfo {
        id: id.clone(),
        title: shell.clone(),
        running: true,
    };
    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(
            id,
            PtySession {
                writer,
                master: pair.master,
                child,
                buffer,
                running,
                title: shell,
            },
        );
    Ok(info)
}

/// Send keyboard input from the terminal view to the session.
#[tauri::command]
pub fn term_write(state: State<'_, PtyManager>, id: String, data: String) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    let session = map.get_mut(&id).ok_or("session not found")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    let _ = session.writer.flush();
    Ok(())
}

#[tauri::command]
pub fn term_resize(
    state: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = state.0.lock().map_err(|e| e.to_string())?;
    let session = map.get(&id).ok_or("session not found")?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn term_kill(state: State<'_, PtyManager>, id: String) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut session) = map.remove(&id) {
        let _ = session.child.kill();
    }
    Ok(())
}

#[tauri::command]
pub fn term_list(state: State<'_, PtyManager>) -> Result<Vec<SessionInfo>, String> {
    let map = state.0.lock().map_err(|e| e.to_string())?;
    Ok(map
        .iter()
        .map(|(id, s)| SessionInfo {
            id: id.clone(),
            title: s.title.clone(),
            running: s.running.load(Ordering::SeqCst),
        })
        .collect())
}

/// Full scrollback (base64) used to repaint a re-attached terminal.
#[tauri::command]
pub fn term_scrollback(state: State<'_, PtyManager>, id: String) -> Result<String, String> {
    let map = state.0.lock().map_err(|e| e.to_string())?;
    let session = map.get(&id).ok_or("session not found")?;
    let buffer = session.buffer.lock().map_err(|e| e.to_string())?;
    let bytes: Vec<u8> = buffer.iter().copied().collect();
    Ok(B64.encode(&bytes))
}
