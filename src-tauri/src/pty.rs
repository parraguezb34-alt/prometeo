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
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

/// Maximum bytes kept per session for re-attach repaints.
const SCROLLBACK_LIMIT: usize = 512 * 1024;
/// Tiempo para repintar una terminal terminada tras recargar la interfaz.
const EXIT_RETAIN: Duration = Duration::from_secs(60);

/// Cada cuánto, como mucho, se manda a la interfaz lo que escribió una terminal (~60 por segundo).
const FLUSH_MS: u64 = 16;
/// Cada cuánto se mira si el hijo murió: en reposo cada terminal despierta solo esto.
const EXIT_POLL: Duration = Duration::from_millis(2500);

/// Lo que una terminal escribió y aún no se mandó a la interfaz.
#[derive(Default)]
struct Outbox {
    state: Mutex<(Vec<u8>, bool)>,
    ready: std::sync::Condvar,
}

impl Outbox {
    fn push(&self, data: &[u8]) {
        if let Ok(mut s) = self.state.lock() {
            s.0.extend_from_slice(data);
        }
        self.ready.notify_one();
    }

    /// La terminal terminó: lo que quede se manda y se acaba.
    fn close(&self) {
        if let Ok(mut s) = self.state.lock() {
            s.1 = true;
        }
        self.ready.notify_one();
    }

    /// Espera a que haya algo, deja `gather` para que se junte lo que viene detrás y lo devuelve
    /// todo de una vez. None cuando la terminal terminó y no queda nada.
    fn next_batch(&self, gather: std::time::Duration) -> Option<Vec<u8>> {
        {
            let mut s = self.state.lock().ok()?;
            while s.0.is_empty() && !s.1 {
                s = self.ready.wait(s).ok()?;
            }
            if s.0.is_empty() {
                return None;
            }
        }
        std::thread::sleep(gather);
        let mut s = self.state.lock().ok()?;
        Some(std::mem::take(&mut s.0))
    }
}

pub struct PtySession {
    pub writer: Mutex<Box<dyn Write + Send>>,
    pub master: Mutex<Box<dyn MasterPty + Send>>,
    pub child: Mutex<Box<dyn Child + Send + Sync>>,
    pub buffer: Arc<Mutex<VecDeque<u8>>>,
    pub running: Arc<AtomicBool>,
    pub title: String,
}

#[derive(Default)]
pub struct PtyManager(pub Arc<Mutex<HashMap<String, Arc<PtySession>>>>);

/// Obtiene una sesión sin retener el cerrojo del mapa durante operaciones de PTY.
fn session_for<T>(map: &Mutex<HashMap<String, Arc<T>>>, id: &str) -> Result<Arc<T>, String> {
    map.lock().map_err(|e| e.to_string())?.get(id).cloned().ok_or("session not found".into())
}

/// Si falla cualquier preparación posterior al spawn, el llamador mata y espera al hijo.
fn cleanup_on_error<T, E>(result: Result<T, E>, cleanup: impl FnOnce()) -> Result<T, E> {
    if result.is_err() {
        cleanup();
    }
    result
}

/// Retira una sesión después del plazo de reenganche; libera el mapa antes de esperar al hijo.
fn retire_after<T: Send + Sync + 'static>(
    map: Arc<Mutex<HashMap<String, Arc<T>>>>,
    id: &str,
    delay: Duration,
    cleanup: impl FnOnce(Arc<T>),
) {
    std::thread::sleep(delay);
    let session = map.lock().ok().and_then(|mut sessions| sessions.remove(id));
    if let Some(session) = session {
        cleanup(session);
    }
}

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
    let mut c = std::process::Command::new("cmd");
    c.args(["/C", "where", program])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    // Sin ventana de consola: en la app instalada (sin consola propia) saldría un parpadeo.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c.status()
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

/// `claude … --resume <id>` con una conversación que no está en disco fallaría con «No
/// conversation found» y dejaría la terminal sin agente (pasa si Claude estrenó id al retomar y
/// lienzo se reinició antes del primer mensaje). Mejor que empiece una conversación nueva.
fn drop_missing_claude_resume(line: &str, dir: Option<&str>, home: Option<&str>) -> String {
    let words: Vec<&str> = line.split_whitespace().collect();
    let Some(i) = words.iter().position(|w| *w == "--resume") else { return line.to_string() };
    let Some(id) = words.get(i + 1) else { return line.to_string() };
    if !line.to_lowercase().contains("claude") {
        return line.to_string();
    }
    let (Some(dir), Some(home)) = (dir, home) else { return line.to_string() };
    // Claude Code guarda cada carpeta en ~/.claude/projects con todo lo que no es alfanumérico como «-».
    let slug: String = dir.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let file = std::path::Path::new(home)
        .join(".claude")
        .join("projects")
        .join(slug)
        .join(format!("{id}.jsonl"));
    if file.is_file() {
        return line.to_string();
    }
    line.replacen(&format!(" --resume {id}"), "", 1)
}

/// Compose a PowerShell `-Command` line for a launch command like
/// `"C:\...\agy.exe" --dangerously-skip-permissions` (executable + flags).
/// Only the executable part gets the call operator/quotes — wrapping the whole
/// line in `& '...'` broke any command carrying arguments.
fn ps_command_line(line: &str) -> String {
    let t = line.trim();
    // Split head (executable) from rest (arguments): explicit quotes, an
    // executable suffix (`.exe`, `.cmd`, …) or the first space.
    let (head, rest) = if t.starts_with('\'') || t.starts_with('"') {
        let q = t.chars().next().unwrap();
        match t[1..].find(q) {
            Some(i) => (&t[..i + 2], t[i + 2..].trim()),
            None => (t, ""),
        }
    } else {
        let lower = t.to_ascii_lowercase();
        let exe_end = [".exe", ".cmd", ".bat", ".ps1"]
            .iter()
            .filter_map(|ext| {
                lower.find(ext).and_then(|i| {
                    let end = i + ext.len();
                    let after = &lower[end..];
                    (after.is_empty() || after.starts_with(' ')).then_some(end)
                })
            })
            .min();
        match exe_end {
            Some(end) => (&t[..end], t[end..].trim()),
            None => match t.split_once(' ') {
                Some((h, r)) => (h, r.trim()),
                None => (t, ""),
            },
        }
    };
    let bare = head.trim_matches(|c| c == '\'' || c == '"');
    if bare.contains(['\\', '/']) {
        // A path needs the call operator (`&`) so PowerShell runs it literally.
        let quoted = format!("& '{}'", bare.replace('\'', "''"));
        if rest.is_empty() {
            quoted
        } else {
            format!("{} {}", quoted, rest)
        }
    } else if rest.is_empty() {
        bare.to_string()
    } else {
        format!("{} {}", bare, rest)
    }
}

/// Parte una línea en palabras respetando comillas simples y dobles (sin escapes).
fn split_words(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    for c in line.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => cur.push(c),
            None if c == '"' || c == '\'' => {
                quote = Some(c);
                started = true;
            }
            None if c.is_whitespace() => {
                if started {
                    out.push(std::mem::take(&mut cur));
                    started = false;
                }
            }
            None => {
                cur.push(c);
                started = true;
            }
        }
    }
    if started {
        out.push(cur);
    }
    out
}

/// Una línea de agente sencilla (programa + argumentos, sin tuberías, variables ni varias
/// órdenes) se puede lanzar sin shell. Si trae algo de eso, sigue yendo por PowerShell.
fn is_plain_command(line: &str) -> bool {
    !line.contains([';', '|', '&', '>', '<', '$', '`', '(', ')', '%', '\n', '\r'])
}

/// Lo que se lanza en el PTY: programa y argumentos.
#[derive(Debug, PartialEq)]
struct Launch {
    program: String,
    args: Vec<String>,
}

/// Lee un lanzador `.cmd` de npm y devuelve lo que ejecuta de verdad: el `.exe` del paquete
/// (claude) o `node` + el `.js` (codex). `dp0` es la carpeta del `.cmd`.
fn npm_shim_target(text: &str, dp0: &str) -> Option<(Option<String>, String)> {
    let dp0 = dp0.trim_end_matches(['\\', '/']);
    for raw in text.lines().rev() {
        let mut rest = raw;
        while let Some(i) = rest.find("\"%dp0%\\") {
            let tail = &rest[i + 1..];
            let Some(end) = tail.find('"') else { break };
            let target = tail[..end].replacen("%dp0%", dp0, 1);
            let lower = target.to_ascii_lowercase();
            if lower.ends_with(".exe") {
                return Some((None, target));
            }
            if lower.ends_with(".js") || lower.ends_with(".mjs") || lower.ends_with(".cjs") {
                let local_node = format!("{dp0}\\node.exe");
                let node = if std::path::Path::new(&local_node).is_file() { local_node } else { "node.exe".to_string() };
                return Some((Some(node), target));
            }
            rest = &tail[end + 1..];
        }
    }
    None
}

/// Busca `name` en el PATH como `.exe`, `.cmd` o `.bat` (en ese orden por carpeta).
fn find_in_path(name: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for ext in [".exe", ".cmd", ".bat"] {
            let p = dir.join(format!("{name}{ext}"));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// Resuelve una orden de agente a un programa que el PTY puede lanzar sin PowerShell
/// (unos 70 MB menos por agente). `None` = no se pudo: se usa PowerShell como antes.
fn direct_launch(line: &str) -> Option<Launch> {
    if !is_plain_command(line) {
        return None;
    }
    let mut words = split_words(line);
    if words.is_empty() {
        return None;
    }
    let head = words.remove(0);
    let path = if head.contains(['\\', '/']) {
        let p = std::path::PathBuf::from(&head);
        p.is_file().then_some(p)?
    } else {
        find_in_path(&head)?
    };
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let full = path.to_string_lossy().to_string();
    match ext.as_str() {
        "exe" => Some(Launch { program: full, args: words }),
        "cmd" | "bat" => {
            let dp0 = path.parent()?.to_string_lossy().to_string();
            let shim = std::fs::read_to_string(&path).ok().and_then(|t| npm_shim_target(&t, &dp0));
            match shim {
                Some((None, exe)) if std::path::Path::new(&exe).is_file() => Some(Launch { program: exe, args: words }),
                Some((Some(node), js)) if std::path::Path::new(&js).is_file() => {
                    let node = if node.contains('\\') { node } else { find_in_path("node")?.to_string_lossy().to_string() };
                    let mut args = vec![js];
                    args.extend(words);
                    Some(Launch { program: node, args })
                }
                // Un .cmd que no es de npm: cmd.exe /d /c pesa ~5 MB frente a ~70 de PowerShell.
                _ => {
                    let mut args = vec!["/d".to_string(), "/c".to_string(), full];
                    args.extend(words);
                    Some(Launch { program: "cmd.exe".to_string(), args })
                }
            }
        }
        _ => None,
    }
}

#[cfg(test)]
mod direct_tests {
    use super::{is_plain_command, npm_shim_target, split_words};

    #[test]
    fn splits_words_with_quotes() {
        assert_eq!(split_words("codex --x resume 01a"), vec!["codex", "--x", "resume", "01a"]);
        assert_eq!(
            split_words("\"C:\\Program Files\\a b\\agy.exe\" --skip"),
            vec!["C:\\Program Files\\a b\\agy.exe", "--skip"]
        );
        assert_eq!(split_words("'C:\\x y\\o.exe'"), vec!["C:\\x y\\o.exe"]);
        assert!(split_words("   ").is_empty());
    }

    #[test]
    fn shell_syntax_keeps_powershell() {
        assert!(is_plain_command("claude --resume abc"));
        assert!(!is_plain_command("npm run dev; echo hi"));
        assert!(!is_plain_command("$env:X=1"));
        assert!(!is_plain_command("a | b"));
    }

    #[test]
    fn reads_npm_shims() {
        let claude = ":start\r\nSETLOCAL\r\n\"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\"   %*\r\n";
        assert_eq!(
            npm_shim_target(claude, "C:\\npm\\"),
            Some((None, "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe".to_string()))
        );
        let codex = "IF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n";
        let (node, js) = npm_shim_target(codex, "C:\\npm").unwrap();
        assert_eq!(js, "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js");
        assert!(node.unwrap().to_ascii_lowercase().ends_with("node.exe"));
        assert_eq!(npm_shim_target("@echo off\r\nrem nada\r\n", "C:\\x"), None);
    }

    /// Manual: `cargo test real_agents -- --ignored --nocapture` muestra cómo se lanzaría cada agente instalado.
    #[test]
    #[ignore]
    fn real_agents() {
        for line in ["claude --resume x", "codex resume y", "opencode", "agy --dangerously-skip-permissions", "npm run dev"] {
            println!("{line} => {:?}", super::direct_launch(line));
        }
        // Lanza de verdad cada agente en un PTY con `--version` y muestra lo que escribe.
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::Read;
        for line in ["claude --version", "codex --version", "C:\\Users\\parra\\AppData\\Local\\agy\\bin\\agy.exe --version"] {
            let Some(l) = super::direct_launch(line) else { println!("{line}: sin lanzamiento directo"); continue };
            let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 100, pixel_width: 0, pixel_height: 0 }).unwrap();
            let mut c = CommandBuilder::new(&l.program);
            c.args(&l.args);
            let mut child = pair.slave.spawn_command(c).unwrap();
            drop(pair.slave);
            let mut reader = pair.master.try_clone_reader().unwrap();
            // ConPTY pregunta la posición del cursor (ESC[6n) al arrancar; xterm contesta en la app.
            let mut writer = pair.master.take_writer().unwrap();
            let _ = std::io::Write::write_all(&mut writer, b"\x1b[1;1R");
            let out = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
            let sink = out.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                while let Ok(n) = reader.read(&mut buf) {
                    if n == 0 { break }
                    sink.lock().unwrap().extend_from_slice(&buf[..n]);
                }
            });
            let mut status = None;
            for _ in 0..200 {
                if let Ok(Some(s)) = child.try_wait() { status = Some(s); break }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            if status.is_none() { let _ = child.kill(); }
            let bytes = out.lock().unwrap().clone();
            let clean: String = String::from_utf8_lossy(&bytes).chars().filter(|c| c.is_ascii_graphic() || *c == ' ').collect();
            println!("PTY {line}: exit={status:?} out={}", &clean[..clean.len().min(160)]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ps_command_line;

    #[test]
    fn ps_line_path_with_flag_uses_call_operator() {
        assert_eq!(
            ps_command_line("\"C:\\tools\\agy.exe\" --dangerously-skip-permissions"),
            "& 'C:\\tools\\agy.exe' --dangerously-skip-permissions"
        );
    }

    #[test]
    fn ps_line_bare_path_is_quoted() {
        assert_eq!(
            ps_command_line("C:\\tools\\opencode-cli.exe"),
            "& 'C:\\tools\\opencode-cli.exe'"
        );
    }

    #[test]
    fn ps_line_spaced_path_with_args_splits_at_exe() {
        assert_eq!(
            ps_command_line("C:\\Program Files\\My App\\app.exe --x 1"),
            "& 'C:\\Program Files\\My App\\app.exe' --x 1"
        );
    }

    #[test]
    fn ps_line_plain_command_passthrough() {
        assert_eq!(ps_command_line("claude"), "claude");
        assert_eq!(
            ps_command_line("agy --dangerously-skip-permissions"),
            "agy --dangerously-skip-permissions"
        );
        assert_eq!(ps_command_line("npm run dev"), "npm run dev");
    }

    #[test]
    fn claude_resume_of_a_missing_conversation_starts_fresh() {
        use super::drop_missing_claude_resume as drop;
        let home = std::env::temp_dir().join(format!("lienzo-home-{}", std::process::id()));
        let dir = r"C:\Proj\Mi App";
        let convs = home.join(".claude").join("projects").join("C--Proj-Mi-App");
        std::fs::create_dir_all(&convs).unwrap();
        std::fs::write(convs.join("aaa.jsonl"), "{}").unwrap();
        let h = home.to_str();
        assert_eq!(drop("claude --resume aaa --x", Some(dir), h), "claude --resume aaa --x");
        assert_eq!(drop("claude --resume zzz --x", Some(dir), h), "claude --x");
        assert_eq!(drop("opencode --session zzz", Some(dir), h), "opencode --session zzz");
        let _ = std::fs::remove_dir_all(&home);
    }
}

fn append_scrollback(buffer: &Arc<Mutex<VecDeque<u8>>>, bytes: &[u8]) {
    if let Ok(mut b) = buffer.lock() {
        b.extend(bytes.iter().copied());
        while b.len() > SCROLLBACK_LIMIT {
            b.pop_front();
        }
    }
}

/// Variables que identifican a una sesión concreta de Claude Code y no deben heredarse a los
/// agentes que abre lienzo. Se conservan las de configuración del usuario (proveedor, token…).
fn is_foreign_session_var(key: &str) -> bool {
    const KEEP: [&str; 6] = [
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_GIT_BASH_PATH",
        "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
    ];
    if KEEP.contains(&key) {
        return false;
    }
    key == "CLAUDECODE"
        || key == "CLAUDE_PID"
        || key.starts_with("CLAUDE_CODE_")
        || key.starts_with("CLAUDE_AGENT_SDK_")
}

/// Spawn a new terminal session. Returns its id; the frontend subscribes to
/// `pty://data` and `pty://exit` events afterwards.
///
/// When `command` is set, the shell starts already running it (used by the
/// team panel to open agent sessions like `claude` or the OpenCode CLI).
#[tauri::command]
pub async fn term_spawn(
    app: AppHandle,
    state: State<'_, PtyManager>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    command: Option<String>,
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

    let dir = cwd
        .filter(|d| std::path::Path::new(d).is_dir())
        .or_else(crate::hub::default_terminal_dir)
        .or_else(home_dir);
    let command = command.map(|line| drop_missing_claude_resume(&line, dir.as_deref(), home_dir().as_deref()));

    let line = command.as_deref().map(str::trim).filter(|s| !s.is_empty());
    // Los agentes se lanzan sin PowerShell delante cuando se puede (unos 70 MB menos cada
    // uno). Al salir el agente la terminal termina (`pty://exit`), en vez de quedarse en el prompt.
    let direct = if cfg!(windows) { line.and_then(direct_launch) } else { None };
    let shell = default_shell();
    let mut cmd = match &direct {
        Some(l) => {
            let mut c = CommandBuilder::new(&l.program);
            c.args(&l.args);
            c
        }
        None => CommandBuilder::new(shell.clone()),
    };
    if let Some(line) = line.filter(|_| direct.is_none()) {
        let sh = shell.to_ascii_lowercase();
        let is_ps = sh.contains("pwsh") || sh.contains("powershell");
        let needs_quote = line.contains([' ', '\\', '/']);
        if is_ps {
            cmd.arg("-NoLogo");
            cmd.arg("-NoExit");
            cmd.arg("-Command");
            cmd.arg(ps_command_line(line));
        } else {
            cmd.arg("/K");
            cmd.arg(if needs_quote {
                format!("\"{}\"", line)
            } else {
                line.to_string()
            });
        }
    }
    // Si lienzo se lanzó desde una sesión de Claude Code (p. ej. un terminal del propio
    // Claude), el entorno trae marcadores de esa sesión (CLAUDE_CODE_SESSION_ID,
    // CLAUDE_CODE_CHILD_SESSION…). Los agentes que abrimos aquí deben ser sesiones propias:
    // con esos marcadores Claude se cree hijo de otra sesión y se comporta distinto.
    for (key, _) in std::env::vars() {
        if is_foreign_session_var(&key) {
            cmd.env_remove(&key);
        }
    }
    cmd.env("TERM", "xterm-256color");
    // Antigravity busca actualizaciones al arrancar lanzando un proceso con consola propia: una
    // ventana que parpadea al abrir Prometeo. Prometeo lo actualiza él, sin ventana (ver
    // `connectors::update_agy_daily`).
    cmd.env(crate::hub::connectors::AGY_NO_UPDATE.0, crate::hub::connectors::AGY_NO_UPDATE.1);
    // Any agent launched inside a lienzo terminal can find the team hub.
    for (key, value) in crate::hub::terminal_env_vars() {
        cmd.env(key, value);
    }
    if let Some(dir) = dir {
        cmd.cwd(dir);
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let prepared: Result<_, String> = (|| {
        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        Ok((reader, writer))
    })();
    let (mut reader, writer) = cleanup_on_error(prepared, || {
        let _ = child.kill();
        let _ = child.wait();
    })?;

    let id = next_id();
    let buffer: Arc<Mutex<VecDeque<u8>>> = Arc::new(Mutex::new(VecDeque::new()));
    let running = Arc::new(AtomicBool::new(true));
    let session = Arc::new(PtySession {
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
        buffer: buffer.clone(),
        running: running.clone(),
        title: shell.clone(),
    });
    if let Ok(mut sessions) = state.0.lock() {
        sessions.insert(id.clone(), session.clone());
    } else {
        let mut child = session.child.lock().map_err(|e| e.to_string())?;
        let _ = child.kill();
        let _ = child.wait();
        return Err("no pude registrar la terminal".into());
    }

    let thread_id = id.clone();
    let thread_buf = buffer.clone();
    let thread_running = running.clone();
    let thread_app = app.clone();
    // La salida va a la interfaz en paquetes: un agente escribe a trocitos (su animación de espera,
    // cada línea…) y un mensaje por trozo hacía trabajar a la ventana más que al propio agente.
    // El lector solo acumula; otro hilo lo manda como mucho cada FLUSH_MS (imperceptible).
    let outbox = Arc::new(Outbox::default());
    let reader_box = outbox.clone();
    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = &chunk[..n];
                    append_scrollback(&thread_buf, data);
                    reader_box.push(data);
                }
            }
        }
        thread_running.store(false, Ordering::SeqCst);
        reader_box.close();
    });
    std::thread::spawn(move || {
        while let Some(data) = outbox.next_batch(std::time::Duration::from_millis(FLUSH_MS)) {
            let _ = thread_app.emit("pty://data", DataPayload { id: thread_id.clone(), data: B64.encode(&data) });
        }
        let _ = thread_app.emit("pty://exit", ExitPayload { id: thread_id.clone() });
    });
    // El hijo puede morir aunque un descendiente mantenga abierto el lector del PTY.
    // Se comprueba el proceso aparte y se retira la sesión tras el plazo de reenganche.
    let monitor_id = id.clone();
    let monitor_map = state.0.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(EXIT_POLL);
            let registered = monitor_map.lock().is_ok_and(|sessions| sessions.contains_key(&monitor_id));
            if !registered {
                return;
            }
            let exited = session.child.lock().is_ok_and(|mut child| matches!(child.try_wait(), Ok(Some(_))));
            if exited || !session.running.load(Ordering::SeqCst) {
                session.running.store(false, Ordering::SeqCst);
                break;
            }
        }
        drop(session);
        retire_after(monitor_map, &monitor_id, EXIT_RETAIN, |session| {
            if let Ok(mut child) = session.child.lock()
                && !matches!(child.try_wait(), Ok(Some(_)))
            {
                let _ = child.kill();
                let _ = child.wait();
            }
        });
    });

    let info = SessionInfo {
        id: id.clone(),
        title: shell.clone(),
        running: true,
    };
    Ok(info)
}

/// Send keyboard input from the terminal view to the session.
#[tauri::command]
pub fn term_write(state: State<'_, PtyManager>, id: String, data: String) -> Result<(), String> {
    let session = session_for(&state.0, &id)?;
    let mut writer = session.writer.lock().map_err(|e| e.to_string())?;
    writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    let _ = writer.flush();
    Ok(())
}

#[tauri::command]
pub fn term_resize(
    state: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = session_for(&state.0, &id)?;
    session
        .master
        .lock()
        .map_err(|e| e.to_string())?
        .resize(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Asíncrono: `taskkill` tarda un momento y no debe frenar la ventana.
#[tauri::command]
pub async fn term_kill(state: State<'_, PtyManager>, id: String) -> Result<(), String> {
    let session = state.0.lock().map_err(|e| e.to_string())?.remove(&id);
    if let Some(session) = session {
        let mut child = session.child.lock().map_err(|e| e.to_string())?;
        // Con todo lo que cuelga de la terminal (el agente y sus puentes): si quedara algo vivo,
        // seguiría usando la carpeta y Windows no dejaría, por ejemplo, renombrarla.
        #[cfg(windows)]
        if let Some(pid) = child.process_id() {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .creation_flags(0x0800_0000)
                .status();
        }
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

#[tauri::command]
pub async fn term_list(state: State<'_, PtyManager>) -> Result<Vec<SessionInfo>, String> {
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

/// Scrollback (base64): entero para repintar una terminal re-adjuntada, o solo los últimos
/// `max` bytes para quien solo mira el final (¿pide login?, ¿qué pregunta?): así no viajan
/// 512 KB por terminal cada pocos segundos.
#[tauri::command]
pub async fn term_scrollback(state: State<'_, PtyManager>, id: String, max: Option<usize>) -> Result<String, String> {
    let session = session_for(&state.0, &id)?;
    let buffer = session.buffer.lock().map_err(|e| e.to_string())?;
    let skip = max.map(|m| buffer.len().saturating_sub(m)).unwrap_or(0);
    let bytes: Vec<u8> = buffer.iter().skip(skip).copied().collect();
    Ok(B64.encode(&bytes))
}

#[cfg(test)]
mod outbox_tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn junta_los_trozos_y_termina_con_lo_que_quede() {
        let ob = Arc::new(Outbox::default());
        let w = ob.clone();
        let writer = std::thread::spawn(move || {
            for i in 0..50u8 {
                w.push(&[i]);
            }
            std::thread::sleep(Duration::from_millis(80));
            w.push(b"fin");
            w.close();
        });
        let mut batches = Vec::new();
        while let Some(b) = ob.next_batch(Duration::from_millis(20)) {
            batches.push(b);
        }
        writer.join().unwrap();
        let all: Vec<u8> = batches.concat();
        let mut want: Vec<u8> = (0..50u8).collect();
        want.extend_from_slice(b"fin");
        assert_eq!(all, want, "nada se pierde ni se desordena");
        assert!(batches.len() <= 3, "50 trozos seguidos salen juntos: {} paquetes", batches.len());
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::{cleanup_on_error, retire_after, session_for};
    use std::collections::HashMap;
    use std::io::{self, Write};
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::Duration;

    #[test]
    fn failed_pty_preparation_cleans_up_child() {
        let mut killed_and_waited = false;
        let result: Result<(), &str> = cleanup_on_error(Err("lector falló"), || {
            killed_and_waited = true;
        });
        assert_eq!(result, Err("lector falló"));
        assert!(killed_and_waited, "el hijo debe matarse y esperarse tras el error");
    }

    #[test]
    fn ended_session_is_removed_after_reattach_grace() {
        let map = Arc::new(Mutex::new(HashMap::from([("muerta".into(), Arc::new(7u8))])));
        let (tx, rx) = mpsc::channel();
        let worker_map = map.clone();
        let worker = std::thread::spawn(move || {
            retire_after(worker_map, "muerta", Duration::from_millis(10), |session| {
                tx.send(*session).unwrap();
            });
        });
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), 7);
        worker.join().unwrap();
        assert!(map.lock().unwrap().is_empty(), "la sesión y sus recursos salen del mapa");
    }

    struct BlockingWriter {
        started: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
    }

    impl Write for BlockingWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.started.send(()).unwrap();
            self.release.recv().unwrap();
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn blocked_writer_does_not_hold_session_map() {
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let slow: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(Box::new(BlockingWriter {
            started: started_tx,
            release: release_rx,
        })));
        let fast: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(Box::new(io::sink())));
        let map = Arc::new(Mutex::new(HashMap::from([
            ("lenta".into(), slow),
            ("rápida".into(), fast),
        ])));
        let slow_map = map.clone();
        let writer = std::thread::spawn(move || {
            let session = session_for(&slow_map, "lenta").unwrap();
            session.lock().unwrap().write_all(b"x").unwrap();
        });
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let fast_map = map.clone();
        let (done_tx, done_rx) = mpsc::channel();
        let other = std::thread::spawn(move || {
            let session = session_for(&fast_map, "rápida").unwrap();
            session.lock().unwrap().write_all(b"y").unwrap();
            done_tx.send(()).unwrap();
        });
        let free = done_rx.recv_timeout(Duration::from_secs(2)).is_ok();
        release_tx.send(()).unwrap();
        writer.join().unwrap();
        other.join().unwrap();
        assert!(free, "la terminal rápida debe seguir respondiendo mientras otra escritura bloquea");
    }
}
