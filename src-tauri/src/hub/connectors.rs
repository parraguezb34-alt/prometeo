//! One-click connectors: detect installed agents (Claude Code, Codex, OpenCode,
//! Antigravity) and write their configuration so they join the lienzo team
//! through `lienzo-mcp.exe`.

use crate::hub::{self, Hub};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use tauri::Manager;

struct AgentDef {
    id: &'static str,
    label: &'static str,
    cli: &'static str,
    dirs: &'static [&'static str], // home-relative dirs that indicate presence
    extra_bins: &'static [&'static str], // LOCALAPPDATA-relative binaries that indicate presence
}

const AGENTS: &[AgentDef] = &[
    AgentDef { id: "claude", label: "Claude Code", cli: "claude", dirs: &[".claude"], extra_bins: &[] },
    AgentDef { id: "codex", label: "Codex", cli: "codex", dirs: &[".codex"], extra_bins: &[] },
    AgentDef {
        id: "opencode",
        label: "OpenCode",
        cli: "opencode",
        dirs: &[".config/opencode"],
        extra_bins: &[
            r"Programs\@opencode-aidesktop\resources\opencode-cli.exe",
            r"Programs\@opencode-aidesktop\OpenCode.exe",
        ],
    },
    AgentDef {
        id: "antigravity",
        label: "Antigravity",
        cli: "agy",
        dirs: &[".gemini"],
        extra_bins: &[
            r"agy\bin\agy.exe",
            r"Programs\antigravity\Antigravity.exe",
        ],
    },
];

const BLOCK_START: &str = "<!-- lienzo-team:start -->";
const BLOCK_END: &str = "<!-- lienzo-team:end -->";

fn home() -> PathBuf {
    std::env::var("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn which(name: &str) -> bool {
    let mut cmd = Command::new("where.exe");
    cmd.arg(name);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
}

fn cli_installed(def: &AgentDef) -> bool {
    if which(def.cli) {
        return true;
    }
    let npm = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join("npm");
    if ["cmd", "exe", "ps1", "bat"]
        .iter()
        .any(|ext| npm.join(format!("{}.{}", def.cli, ext)).exists())
    {
        return true;
    }
    let local = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_default();
    def.extra_bins.iter().any(|p| local.join(p).exists())
}

/// La copia `<name>.locked-<ts>` más reciente que build.rs apartó en `dir`.
fn newest_locked_copy(dir: &Path, name: &str) -> Option<PathBuf> {
    let prefix = format!("{name}.locked-");
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix))
        .max_by_key(|e| e.metadata().and_then(|m| m.modified()).ok())
        .map(|e| e.path())
}

/// La ruta de verdad en el disco. Si Prometeo se instaló desde una app empaquetada (MSIX, p. ej.
/// la de Claude), Windows guarda sus archivos en `AppData\Local\Packages\…\LocalCache` aunque
/// dentro de esa app se vean en `AppData\Local\Prometeo`: escrita así en la config de un agente,
/// fuera de esa app la ruta no existe y el agente no se conecta.
fn real_path(p: &Path) -> PathBuf {
    match std::fs::canonicalize(p) {
        Ok(c) => {
            let s = c.display().to_string();
            match s.strip_prefix(r"\\?\") {
                Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
                _ => c,
            }
        }
        Err(_) => p.to_path_buf(),
    }
}

/// ¿La config de un agente arranca este mismo puente? (cruda, o escapada como en JSON/TOML).
fn uses_bridge(text: &str, exe: &str) -> bool {
    let low = text.to_lowercase();
    let exe = exe.to_lowercase();
    low.contains(&exe) || low.contains(&exe.replace('\\', "\\\\")) || low.contains(&exe.replace('\\', "/"))
}

fn mcp_exe_path() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("sin directorio de la app")?;
    let candidate = dir.join("lienzo-mcp.exe");
    if !candidate.exists() {
        // build.rs aparta (renombra) el puente cuando está en uso por agentes vivos y,
        // si ese build no lo regenera (p. ej. un `cargo check`), la config de los
        // agentes quedaría apuntando a un archivo que ya no existe. Se restaura la
        // copia apartada más reciente: es el mismo binario.
        if let Some(saved) = newest_locked_copy(dir, "lienzo-mcp.exe") {
            let _ = std::fs::copy(&saved, &candidate);
        }
    }
    if candidate.exists() {
        Ok(real_path(&candidate).display().to_string())
    } else {
        Err(format!(
            "no se encontró lienzo-mcp.exe junto a la app ({})",
            candidate.display()
        ))
    }
}

/// Write an agent's configuration into `project`. Shared by the UI command and
/// the hub's HTTP API (so scripts can connect agents too).
pub fn connect_agent(agent: &str, project: &Path) -> Result<(Vec<String>, Vec<String>), String> {
    let exe = mcp_exe_path()?;
    // Prometeo Dev no se queda los proyectos del Prometeo normal: reescribiría su puente y los
    // agentes de ese proyecto dejarían de llegar a su equipo.
    if crate::hub::IS_DEV && foreign_bridge(project, &exe) {
        return Err(format!(
            "{} ya está conectada al Prometeo normal: en Prometeo Dev abre una carpeta de pruebas.",
            project.display()
        ));
    }
    let (mut files, notes) = match agent {
        "claude" => connect_claude(project, &exe),
        "codex" => connect_codex(project, &exe),
        "opencode" => connect_opencode(project, &exe),
        "antigravity" => connect_antigravity(project, &exe),
        _ => Err(format!("agente desconocido: {agent}")),
    }?;
    files.extend(crate::skills::sync_files(project));
    Ok((files, notes))
}

/// ¿Las configuraciones del proyecto apuntan a otro puente de lienzo (el de otro Prometeo)?
fn foreign_bridge(project: &Path, exe: &str) -> bool {
    [
        project.join(".mcp.json"),
        project.join("opencode.json"),
        project.join(".agents").join("mcp_config.json"),
        project.join(".codex").join("config.toml"),
        project.join(".codex").join("hooks.json"),
        project.join(".claude").join("settings.json"),
    ]
    .iter()
    .filter_map(|p| std::fs::read_to_string(p).ok())
    .any(|s| s.contains("lienzo-mcp") && !uses_bridge(&s, exe))
}

fn project_of(app: &tauri::AppHandle) -> Option<String> {
    app.try_state::<Hub>()
        .and_then(|hub| hub.0.lock().ok().and_then(|i| i.project.clone()))
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

fn read_json(path: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        // Vacío o con BOM (Bloc de notas, PowerShell) sigue siendo válido.
        Ok(s) if s.trim_start_matches('\u{feff}').trim().is_empty() => Ok(json!({})),
        Ok(s) => serde_json::from_str(s.trim_start_matches('\u{feff}')).map_err(|e| {
            format!(
                "El archivo {} no es un JSON válido; arréglalo o bórralo y vuelve a conectar: {e}",
                path.display()
            )
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(format!(
            "No se pudo leer el archivo {}: {e}",
            path.display()
        )),
    }
}

fn write_text(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, text).map_err(|e| e.to_string())
}

fn write_json_pretty(path: &Path, v: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    std::fs::write(path, raw).map_err(|e| e.to_string())
}

fn team_block() -> String {
    // Este bloque se carga en cada mensaje: va lo imprescindible. El detalle vive en las
    // skills, que solo se leen cuando hacen falta (salvo las obligatorias).
    let (always, auto) = crate::skills::protocol_lists();
    let mut skills = String::new();
    if !always.is_empty() {
        skills.push_str(&format!(
            "**Skills obligatorias** (léelas al empezar y síguelas en todo lo que hagas): {}.\n",
            always.join(", ")
        ));
    }
    if !auto.is_empty() {
        skills.push_str(&format!("Guías (skills, léelas cuando toquen): {}. ", auto.join(", ")));
    }
    format!(
        "{BLOCK_START}\n## Protocolo de equipo (lienzo)\n\n\
Trabajas con otros agentes de IA en este proyecto, coordinados por lienzo con las herramientas MCP `team_*` (servidor `lienzo-team`).\n\n\
- Al empezar: `team_context`. Reserva con `team_claim_files` antes de editar y libera al acabar.\n\
- Tareas: `team_task_claim` (trae las entregas previas) y `team_task_done` con `summary`, `files` y `evidence`.\n\
- 📬 Buzón: cuando una herramienta avise de mensajes, léelos con `team_inbox` y contesta con `team_message` (`to`, `reply_to`). `to: \"líder\"` llega al líder.\n\
- Avances en 1 línea con `team_update`; notas de una tarea con `team_task_comment`.\n\
- ¿Dudas sobre lo que quiere el usuario? Pregúntale con `team_ask_user` (preguntas con opciones concretas) en vez de suponer. Usa las rutas exactas de la tarea.\n\
- ¿Te falta una guía para el trabajo (diseño, pruebas…)? Propón una skill con `team_skill_propose`; el usuario decide.\n\
- Ahorro de tokens: llamadas independientes en un mismo turno (varias lecturas o búsquedas a la vez); busca antes de leer y lee solo el tramo necesario; acota la salida de los comandos; respuesta final breve.\n\n\
{skills}Si tu CLI no tiene skills, léelas en `.claude/skills/<nombre>/SKILL.md`.\n\
{BLOCK_END}"
    )
}

/// Reescribe el protocolo del equipo en los archivos del proyecto que ya lo tienen (al cambiar
/// las skills). Devuelve los que cambiaron.
pub fn refresh_protocol(project: &Path) -> Vec<String> {
    let block = team_block();
    let mut out = Vec::new();
    for name in ["CLAUDE.md", "AGENTS.md"] {
        let p = project.join(name);
        let Ok(cur) = std::fs::read_to_string(&p) else { continue };
        if !cur.contains(BLOCK_START) {
            continue;
        }
        if write_managed_block(&p, &block).is_ok() && std::fs::read_to_string(&p).ok().as_deref() != Some(cur.as_str()) {
            out.push(p.display().to_string());
        }
    }
    out
}

fn write_managed_block(path: &Path, block: &str) -> Result<(), String> {
    let existing = std::fs::read_to_string(path).unwrap_or_default();
    let updated = if let (Some(s), Some(e)) = (existing.find(BLOCK_START), existing.find(BLOCK_END)) {
        let end = e + BLOCK_END.len();
        format!("{}{}{}", &existing[..s], block, &existing[end..])
    } else if existing.trim().is_empty() {
        format!("{}\n", block)
    } else {
        format!("{}\n\n{}\n", existing.trim_end(), block)
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    std::fs::write(path, updated).map_err(|e| e.to_string())
}

fn hook_command(exe: &str, agent: &str, event: &str) -> String {
    format!("\"{}\" hook --agent {} --event {}", exe, agent, event)
}

fn hook_entry(exe: &str, agent: &str, event: &str, matcher: Option<&str>) -> Value {
    let mut group = json!({
        "hooks": [ {
            "type": "command",
            "command": hook_command(exe, agent, event),
            "timeout": 15
        } ]
    });
    // Codex en Windows ejecuta los hooks con PowerShell, que no lanza `"ruta" args` (lo toma por un
    // texto suelto y falla): con `commandWindows` y el operador `&` sí. Comprobado con Codex 0.164.
    if agent == "codex" {
        group["hooks"][0]["commandWindows"] = json!(format!("& {}", hook_command(exe, agent, event)));
    }
    if let Some(m) = matcher {
        group["matcher"] = json!(m);
    }
    group
}

/// Merge lienzo hooks into a Claude-Code-shaped settings object (idempotent).
fn merge_hooks(settings: &mut Value, exe: &str, agent: &str) {
    if !settings.is_object() {
        *settings = json!({});
    }
    let root = settings.as_object_mut().unwrap();
    let hooks = root.entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let hooks = hooks.as_object_mut().unwrap();
    let mut defs: Vec<(&str, &str, Option<&str>)> = vec![
        ("SessionStart", "session", None),
        ("UserPromptSubmit", "prompt", None),
        // Read y las capturas de pantalla solo llegan al chat cuando son imágenes (ver hook_mode).
        (
            "PostToolUse",
            "tool",
            Some("Edit|Write|MultiEdit|NotebookEdit|Bash|Read|.*[Ss]creenshot.*"),
        ),
        ("Stop", "stop", None),
    ];
    // Claude avisa cuando un agente se queda esperando permiso o respuesta:
    // eso alimenta la bandeja de bloqueos del centro de mando.
    if agent == "claude" {
        defs.push(("Notification", "waiting", None));
    }
    for (event, flag, matcher) in defs {
        let arr = hooks.entry(event).or_insert_with(|| json!([]));
        if !arr.is_array() {
            *arr = json!([]);
        }
        let arr = arr.as_array_mut().unwrap();
        arr.retain(|group| !group.to_string().contains("lienzo-mcp"));
        arr.push(hook_entry(exe, agent, flag, matcher));
    }
}

fn mcp_server_entry(exe: &str, agent: &str) -> Value {
    json!({
        "command": exe,
        "args": [],
        "env": { "LIENZO_AGENT": agent }
    })
}

// ---------------------------------------------------------------------------
// Per-agent connectors
// ---------------------------------------------------------------------------

fn connect_claude(project: &Path, exe: &str) -> Result<(Vec<String>, Vec<String>), String> {
    let mut files = vec![];
    let mut notes = vec![];

    // MCP server (project scope).
    let mcp_path = project.join(".mcp.json");
    let mut mcp = read_json(&mcp_path)?;
    if !mcp.is_object() {
        mcp = json!({});
    }
    // `alwaysLoad`: las herramientas del equipo van siempre cargadas. Si no, Claude Code las deja
    // tras su buscador y cada sesión gasta varias peticiones enteras (con todo su contexto) solo en
    // ToolSearch. Las que se usan poco las sigue dejando diferidas el propio servidor (`_meta`).
    let mut entry = mcp_server_entry(exe, "claude");
    entry["alwaysLoad"] = json!(true);
    mcp.as_object_mut()
        .unwrap()
        .entry("mcpServers")
        .or_insert_with(|| json!({}))["lienzo-team"] = entry;

    // Hooks (activity + team context injection) + auto-approve project MCP.
    let settings_path = project.join(".claude").join("settings.json");
    let mut settings = read_json(&settings_path)?;
    if !settings.is_object() {
        settings = json!({});
    }
    settings
        .as_object_mut()
        .unwrap()
        .insert("enableAllProjectMcpServers".into(), json!(true));
    merge_hooks(&mut settings, exe, "claude");
    // La «status line» trae el uso de la suscripción (sesión de 5 h y semana): la leemos con el
    // puente. Si el proyecto ya tenía una propia, se respeta.
    let ours = settings["statusLine"].is_null() || settings["statusLine"].to_string().contains("lienzo-mcp");
    if ours {
        settings.as_object_mut().unwrap().insert(
            "statusLine".into(),
            json!({ "type": "command", "command": format!("\"{exe}\" statusline"), "padding": 0 }),
        );
    }

    write_json_pretty(&mcp_path, &mcp)?;
    files.push(mcp_path.display().to_string());
    notes.push("Claude pedirá una vez aprobar el servidor MCP del proyecto.".into());

    write_json_pretty(&settings_path, &settings)?;
    files.push(settings_path.display().to_string());
    notes.push("Los hooks inyectan la actividad del equipo en cada prompt.".into());

    let block = team_block();
    for name in ["CLAUDE.md", "AGENTS.md"] {
        let p = project.join(name);
        write_managed_block(&p, &block)?;
        files.push(p.display().to_string());
    }
    Ok((files, notes))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CodexConfigPlan {
    /// Contenido que debe escribirse en ~/.codex/config.toml (None si no debe tocarse).
    pub global_write: Option<String>,
    /// Contenido que debe escribirse en <project>/.codex/config.toml (None si no debe tocarse).
    pub local_write: Option<String>,
    /// Nota informativa sobre la confianza de la carpeta en Codex.
    pub note: Option<String>,
}

/// Decide qué cambios aplicar a la configuración de Codex según estemos en Prometeo Dev o no.
/// En Dev, nunca se toca el config.toml global ni el bloque de confianza global.
pub(crate) fn plan_codex_config(
    is_dev: bool,
    global_existing: &str,
    local_existing: &str,
    exe: &str,
    project: &Path,
) -> CodexConfigPlan {
    if is_dev {
        let needed = !local_existing.contains("mcp_servers.lienzo-team") || !uses_bridge(local_existing, exe);
        let local_write = if needed {
            Some(codex_config(local_existing, exe))
        } else {
            None
        };
        CodexConfigPlan {
            global_write: None,
            local_write,
            note: Some("En Prometeo Dev, confía en la carpeta desde Codex para que ejecute sus hooks y herramientas.".to_string()),
        }
    } else {
        let mut text = if !global_existing.contains("mcp_servers.lienzo-team") || !uses_bridge(global_existing, exe) {
            codex_config(global_existing, exe)
        } else {
            global_existing.to_string()
        };
        if !codex_project_listed(&text, project) {
            text = format!("{}\n\n{}", text.trim_end(), codex_trust_block(project));
        }
        let global_write = if text != global_existing {
            Some(text)
        } else {
            None
        };
        CodexConfigPlan {
            global_write,
            local_write: None,
            note: None,
        }
    }
}

fn connect_codex(project: &Path, exe: &str) -> Result<(Vec<String>, Vec<String>), String> {
    let mut files = vec![];

    // Global MCP config (~/.codex/config.toml) y local del proyecto (<project>/.codex/config.toml).
    // Prometeo Dev nunca escribe el config global ni añade bloques de confianza globales.
    let cfg = home().join(".codex").join("config.toml");
    let global_existing = std::fs::read_to_string(&cfg).unwrap_or_default();
    let local = project.join(".codex").join("config.toml");
    let local_existing = std::fs::read_to_string(&local).unwrap_or_default();

    let plan = plan_codex_config(crate::hub::IS_DEV, &global_existing, &local_existing, exe, project);

    if let Some(text) = plan.global_write {
        write_text(&cfg, &text)?;
        files.push(cfg.display().to_string());
    } else if !crate::hub::IS_DEV {
        files.push(cfg.display().to_string());
    }

    if let Some(text) = plan.local_write {
        write_text(&local, &text)?;
        files.push(local.display().to_string());
    } else if crate::hub::IS_DEV {
        files.push(local.display().to_string());
    }

    let mut notes = vec![];
    if crate::hub::IS_DEV {
        if let Some(n) = plan.note {
            notes.push(n);
        }
    } else {
        notes.push("Codex lee su MCP global; reinícialo si estaba abierto.".to_string());
    }

    // Project hooks (same shape as Claude Code).
    let hooks_path = project.join(".codex").join("hooks.json");
    let mut hooks = read_json(&hooks_path)?;
    merge_hooks(&mut hooks, exe, "codex");
    write_json_pretty(&hooks_path, &hooks)?;
    files.push(hooks_path.display().to_string());

    // Codex no ejecuta un hook nuevo o cambiado hasta que alguien lo aprueba en su pantalla; los
    // nuestros los aprueba Prometeo con el propio Codex (su firma, en su config).
    let mut notes = notes;
    match codex_trust_hooks(project, exe) {
        Ok(_) => {}
        Err(e) => notes.push(format!("Codex te pedirá aprobar los avisos de Prometeo al abrirlo ({e}).")),
    }

    let p = project.join("AGENTS.md");
    write_managed_block(&p, &team_block())?;
    files.push(p.display().to_string());
    Ok((files, notes))
}

/// El ejecutable de Codex para hablar con su servidor (`codex app-server`): el binario nativo que
/// instala npm si está; si no, el `codex` del PATH a través de cmd.
fn codex_app_server() -> std::process::Command {
    let native = std::env::var("APPDATA").map(PathBuf::from).unwrap_or_default().join(
        r"npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe",
    );
    let mut cmd = if native.is_file() {
        std::process::Command::new(native)
    } else {
        let mut c = std::process::Command::new("cmd");
        c.args(["/D", "/C", "codex"]);
        c
    };
    cmd.arg("app-server");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Aprueba en Codex los hooks de Prometeo de `project` que aún no lo estén. Pregunta a Codex por
/// ellos (`hooks/list`, que da la firma de cada uno) y guarda esa firma como aprobada con
/// `config/batchWrite`, igual que hace su pantalla cuando el usuario los aprueba. Solo toca los
/// hooks cuyo comando es el puente `exe`. Devuelve cuántos aprobó.
fn codex_trust_hooks(project: &Path, exe: &str) -> Result<usize, String> {
    use std::io::{BufRead, Write};
    let mut child = codex_app_server()
        .current_dir(project)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("no se pudo abrir Codex: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("sin stdin")?;
    let stdout = child.stdout.take().ok_or("sin stdout")?;
    let (tx, rx) = std::sync::mpsc::channel::<Value>();
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if tx.send(v).is_err() {
                    break;
                }
            }
        }
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(25);
    let mut call = |id: u64, method: &str, params: Value| -> Result<Value, String> {
        // id 0: notificación (sin respuesta que esperar).
        let msg = if id == 0 {
            json!({ "jsonrpc": "2.0", "method": method })
        } else {
            json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
        };
        writeln!(stdin, "{msg}").and_then(|_| stdin.flush()).map_err(|e| e.to_string())?;
        if id == 0 {
            return Ok(Value::Null);
        }
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            let v = rx.recv_timeout(left).map_err(|_| format!("Codex no contestó a {method}"))?;
            if v["id"].as_u64() == Some(id) {
                if let Some(err) = v.get("error") {
                    return Err(format!("{method}: {}", err["message"].as_str().unwrap_or("error")));
                }
                return Ok(v["result"].clone());
            }
        }
    };
    let result = (|| {
        call(1, "initialize", json!({ "clientInfo": { "name": "prometeo", "title": "Prometeo", "version": env!("CARGO_PKG_VERSION") } }))?;
        call(0, "initialized", Value::Null)?;
        let dir = project.display().to_string();
        let list = call(2, "hooks/list", json!({ "cwds": [dir] }))?;
        let state = codex_untrusted_ours(&list, exe);
        let n = state.as_object().map(|o| o.len()).unwrap_or(0);
        if n > 0 {
            call(3, "config/batchWrite", json!({ "edits": [ { "keyPath": "hooks.state", "value": state, "mergeStrategy": "upsert" } ] }))?;
        }
        Ok(n)
    })();
    // Sin entrada, el servidor se cierra solo; si no, se le corta.
    drop(stdin);
    for _ in 0..30 {
        if child.try_wait().ok().flatten().is_some() {
            return result;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let _ = child.kill();
    result
}

/// De la respuesta de `hooks/list`, los hooks del puente `exe` sin aprobar, como la tabla
/// `hooks.state` que los aprueba: `{ "<clave>": { "trusted_hash": "<firma>" } }`.
fn codex_untrusted_ours(list: &Value, exe: &str) -> Value {
    let mut state = serde_json::Map::new();
    for group in list["data"].as_array().into_iter().flatten() {
        for h in group["hooks"].as_array().into_iter().flatten() {
            let ours = h["command"].as_str().is_some_and(|c| uses_bridge(c, exe));
            let trusted = h["trustStatus"].as_str() == Some("trusted");
            if let (true, false, Some(key), Some(hash)) = (ours, trusted, h["key"].as_str(), h["currentHash"].as_str()) {
                state.insert(key.to_string(), json!({ "trusted_hash": hash }));
            }
        }
    }
    Value::Object(state)
}

/// La carpeta como la guarda Codex en `[projects.'…']` (en Windows, en minúsculas).
fn codex_project_key(project: &Path) -> String {
    let s = project.display().to_string();
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

/// ¿Tiene la carpeta su tabla `[projects.…]` en la config de Codex (confiada o no)?
fn codex_project_listed(cfg: &str, project: &Path) -> bool {
    let key = codex_project_key(project).to_lowercase();
    cfg.lines().any(|l| {
        let t = l.trim().to_lowercase();
        t.starts_with("[projects.")
            && (t.contains(&format!("'{key}'")) || t.contains(&format!("\"{}\"", key.replace('\\', "\\\\"))))
    })
}

fn codex_trust_block(project: &Path) -> String {
    let key = codex_project_key(project);
    let quoted = if key.contains('\'') {
        format!("\"{}\"", key.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        format!("'{key}'")
    };
    format!("# Prometeo: carpeta del equipo (sin confianza, Codex no ejecuta sus hooks)\n[projects.{quoted}]\ntrust_level = \"trusted\"\n")
}

/// `config.toml` de Codex con el bloque de lienzo-team apuntando a `exe`: quita el anterior
/// (sus tablas `[mcp_servers.lienzo-team…]` y el comentario de encima) y pone el nuevo al final.
fn codex_config(existing: &str, exe: &str) -> String {
    let mut kept: Vec<&str> = vec![];
    let mut ours = false;
    for line in existing.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            let name = t.trim_start_matches('[').trim_end_matches(']').trim();
            ours = name == "mcp_servers.lienzo-team" || name.starts_with("mcp_servers.lienzo-team.");
            if ours && kept.last().is_some_and(|l| l.trim() == "# lienzo team (auto-generado)") {
                kept.pop();
            }
        }
        if !ours {
            kept.push(line);
        }
    }
    let rest = kept.join("\n");
    let block = format!(
        "# lienzo team (auto-generado)\n[mcp_servers.lienzo-team]\ncommand = \"{}\"\nargs = []\n\n[mcp_servers.lienzo-team.env]\nLIENZO_AGENT = \"codex\"\n",
        exe.replace('\\', "\\\\")
    );
    if rest.trim().is_empty() {
        block
    } else {
        format!("{}\n\n{}", rest.trim_end(), block)
    }
}

fn connect_opencode(project: &Path, exe: &str) -> Result<(Vec<String>, Vec<String>), String> {
    let mut files = vec![];
    let notes = vec![
        "OpenCode v2: el servidor queda bajo mcp.servers.".to_string(),
        "Recargo su puente en el servicio de OpenCode para que use la versión nueva.".to_string(),
    ];

    let cfg_path = project.join("opencode.json");
    let mut cfg = read_json(&cfg_path)?;
    if !cfg.is_object() {
        cfg = json!({});
    }
    let root = cfg.as_object_mut().unwrap();
    // Drop v1-style leftovers (a direct entry under `mcp` breaks v2 configs).
    if let Some(mcp_obj) = root.get_mut("mcp").and_then(|m| m.as_object_mut()) {
        mcp_obj.remove("lienzo-team");
    }
    let mcp = root.entry("mcp").or_insert_with(|| json!({}));
    if !mcp.is_object() {
        *mcp = json!({});
    }
    let servers = mcp
        .as_object_mut()
        .unwrap()
        .entry("servers")
        .or_insert_with(|| json!({}));
    if !servers.is_object() {
        *servers = json!({});
    }
    servers.as_object_mut().unwrap().insert(
        "lienzo-team".to_string(),
        json!({
            "type": "local",
            "command": [exe],
            "environment": { "LIENZO_AGENT": "opencode" }
        }),
    );
    write_json_pretty(&cfg_path, &cfg)?;
    files.push(cfg_path.display().to_string());

    let p = project.join("AGENTS.md");
    write_managed_block(&p, &team_block())?;
    files.push(p.display().to_string());

    // El servicio de OpenCode mantiene vivo el puente aunque cierres su terminal: sin esto
    // seguiría con el binario viejo (sin las herramientas nuevas) hasta reiniciar el servicio.
    let dir = project.display().to_string();
    std::thread::spawn(move || reload_opencode_mcp(&dir));
    Ok((files, notes))
}

/// Desconecta y vuelve a conectar `lienzo-team` en el servicio de OpenCode de esa carpeta.
fn reload_opencode_mcp(dir: &str) {
    let Some(cli) = opencode_cli() else { return };
    let header = format!("x-opencode-directory:{dir}");
    for op in ["disconnect", "connect"] {
        let mut cmd = Command::new(&cli);
        cmd.args(["api", "POST", &format!("/api/experimental/mcp/lienzo-team/{op}"), "-H", &header])
            .current_dir(dir)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let Ok(mut child) = cmd.spawn() else { return };
        let mut waited = 0;
        while waited < 15_000 {
            if let Ok(Some(_)) = child.try_wait() {
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
            waited += 200;
        }
        let _ = child.kill();
    }
}

fn connect_antigravity(project: &Path, exe: &str) -> Result<(Vec<String>, Vec<String>), String> {
    let mut files = vec![];
    let notes = vec![
        "Antigravity usa la config del workspace; reábrelo para que la lea.".to_string(),
        "Los tools del equipo pedirán permiso la primera vez (modo Ask/permisos).".to_string(),
    ];

    let entry = mcp_server_entry(exe, "antigravity");

    // Workspace config (active project).
    let ws_path = project.join(".agents").join("mcp_config.json");
    let mut ws = read_json(&ws_path)?;
    if !ws.is_object() {
        ws = json!({});
    }
    ws.as_object_mut()
        .unwrap()
        .entry("mcpServers")
        .or_insert_with(|| json!({}))["lienzo-team"] = entry.clone();
    write_json_pretty(&ws_path, &ws)?;
    files.push(ws_path.display().to_string());

    // Global config (~/.gemini/config/mcp_config.json) as a fallback. Prometeo Dev no la toca:
    // es del Prometeo normal.
    let global_path = home().join(".gemini").join("config").join("mcp_config.json");
    if !crate::hub::IS_DEV && (global_path.exists() || global_path.parent().map(|p| p.exists()).unwrap_or(false)) {
        let mut global = read_json(&global_path)?;
        if !global.is_object() {
            global = json!({});
        }
        global
            .as_object_mut()
            .unwrap()
            .entry("mcpServers")
            .or_insert_with(|| json!({}))["lienzo-team"] = entry;
        write_json_pretty(&global_path, &global)?;
        files.push(global_path.display().to_string());
    }

    let p = project.join("AGENTS.md");
    write_managed_block(&p, &team_block())?;
    files.push(p.display().to_string());
    Ok((files, notes))
}

/// Conectado = su config tiene `lienzo-team` y arranca el puente de ESTA Prometeo. Si apunta a
/// otro (una compilación de desarrollo, una ruta que ya no existe…), cuenta como desconectado y
/// al abrir Prometeo se vuelve a escribir.
fn is_connected(id: &str, project: Option<&Path>) -> bool {
    let exe = mcp_exe_path().ok();
    let ok = |path: PathBuf, marker: &str| {
        std::fs::read_to_string(path)
            .map(|s| s.contains(marker) && exe.as_deref().is_none_or(|e| uses_bridge(&s, e)))
            .unwrap_or(false)
    };
    match id {
        // Sin `alwaysLoad` (conectado con una versión anterior) se vuelve a conectar una vez.
        "claude" => project.is_some_and(|p| ok(p.join(".mcp.json"), "lienzo-team") && ok(p.join(".mcp.json"), "\"alwaysLoad\"")),
        "codex" if crate::hub::IS_DEV => project.is_some_and(|p| {
            ok(p.join(".codex").join("config.toml"), "mcp_servers.lienzo-team") && ok(p.join(".codex").join("hooks.json"), "commandWindows")
        }),
        "codex" => {
            let cfg = home().join(".codex").join("config.toml");
            let listed = project.is_none_or(|p| std::fs::read_to_string(&cfg).is_ok_and(|s| codex_project_listed(&s, p)));
            // Hooks de antes de `commandWindows` (PowerShell no los ejecutaba): se vuelven a escribir.
            let hooks_ok = project.is_none_or(|p| ok(p.join(".codex").join("hooks.json"), "commandWindows"));
            listed && hooks_ok && ok(cfg, "mcp_servers.lienzo-team")
        }
        "opencode" => project.is_some_and(|p| ok(p.join("opencode.json"), "lienzo-team")),
        "antigravity" => {
            // Antigravity también lee la config global: si existe, tiene que ir bien.
            let global = home().join(".gemini").join("config").join("mcp_config.json");
            let global_ok = crate::hub::IS_DEV || !std::fs::read_to_string(&global).is_ok_and(|s| s.contains("lienzo-team")) || ok(global, "lienzo-team");
            global_ok && project.is_some_and(|p| ok(p.join(".agents").join("mcp_config.json"), "lienzo-team"))
        }
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn team_detect(app: tauri::AppHandle) -> Result<Value, String> {
    let project = project_of(&app);
    let project_path = project
        .as_deref()
        .filter(|p| std::path::Path::new(p).is_dir())
        .map(PathBuf::from);
    let exe_ok = mcp_exe_path().is_ok();

    let list: Vec<Value> = AGENTS
        .iter()
        .map(|def| {
            let dir_found = def.dirs.iter().any(|d| home().join(d).exists());
            json!({
                "id": def.id,
                "label": def.label,
                "cli_found": cli_installed(def),
                "config_dir_found": dir_found,
                "connected": is_connected(def.id, project_path.as_deref()),
                "mcp_exe_ok": exe_ok,
            })
        })
        .collect();

    Ok(json!({ "agents": list, "project": project }))
}

#[tauri::command]
pub async fn team_connect(app: tauri::AppHandle, agent: String, project: Option<String>) -> Result<Value, String> {
    let project = project
        .filter(|p| !p.trim().is_empty())
        .or_else(|| project_of(&app))
        .ok_or("define primero la carpeta del proyecto del equipo")?;
    let project_path = PathBuf::from(project.trim());
    if !project_path.is_dir() {
        return Err(format!("la carpeta no existe: {}", project_path.display()));
    }

    let (files, notes) = connect_agent(&agent, &project_path)?;

    // Remember the project so new terminals start there.
    let _ = hub::with_inner(&app, |inner| {
        if inner.project.as_deref() != Some(project_path.display().to_string().as_str()) {
            inner.project = Some(project_path.display().to_string());
            hub::persist(inner);
        }
    });
    hub::notify_ui();

    Ok(json!({ "files": files, "notes": notes }))
}

/// Opciones al abrir un agente: modo plan, modelo, esfuerzo y si debe retomar
/// la conversación anterior de la carpeta (al reiniciar para cambiar de modelo).
#[derive(Default, Clone)]
pub struct LaunchOpts {
    pub plan: bool,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub resume: bool,
}

/// Valores que acaban en una línea de comandos: solo caracteres inocuos.
fn safe_token(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() || t.len() > 120 {
        return None;
    }
    if t.chars().all(|c| c.is_ascii_alphanumeric() || "._:/#@+-".contains(c)) {
        Some(t.to_string())
    } else {
        None
    }
}

/// El CLI de Codex: solo el instalado de verdad (PATH o npm). El `codex.exe` que trae la app de
/// escritorio no sirve para la TUI («this CLI has no complete local package»), así que no cuenta.
fn codex_cli() -> Option<PathBuf> {
    if which("codex") {
        return Some(PathBuf::from("codex"));
    }
    let npm = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join("npm");
    if ["cmd", "exe", "ps1", "bat"]
        .iter()
        .any(|ext| npm.join(format!("codex.{ext}")).exists())
    {
        return Some(PathBuf::from("codex"));
    }
    None
}

fn quoted(p: &Path) -> String {
    let s = p.display().to_string();
    if s.contains([' ', '\\', '/']) {
        format!("\"{s}\"")
    } else {
        s
    }
}

/// Where to open an agent: a terminal command (`pty`) or its desktop app (`app`).
/// `opts.plan` starts the CLI read-only in its planning mode when it has one;
/// `model` / `effort` / `resume` se traducen a las flags de cada CLI.
pub fn launch_target(agent: &str, opts: &LaunchOpts) -> Option<Value> {
    let local = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_default();
    let model = opts.model.as_deref().and_then(safe_token);
    let effort = opts.effort.as_deref().and_then(safe_token);
    match agent {
        "claude" => {
            let def = AGENTS.iter().find(|d| d.id == agent)?;
            if !cli_installed(def) {
                return None;
            }
            // Claude Code: `--permission-mode plan` lo arranca en plan.
            let mut cmd = String::from("claude");
            if opts.plan {
                cmd.push_str(" --permission-mode plan");
            }
            if let Some(m) = &model {
                cmd.push_str(&format!(" --model {m}"));
            }
            if let Some(e) = &effort {
                cmd.push_str(&format!(" --effort {e}"));
            }
            if opts.resume {
                cmd.push_str(" --continue");
            }
            Some(json!({ "kind": "pty", "cmd": cmd }))
        }
        "codex" => {
            let exe = codex_cli()?;
            let mut cmd = quoted(&exe);
            if let Some(m) = &model {
                cmd.push_str(&format!(" -m {m}"));
            }
            if let Some(e) = &effort {
                cmd.push_str(&format!(" -c model_reasoning_effort={e}"));
            }
            if opts.resume {
                cmd.push_str(" resume --last");
            }
            Some(json!({ "kind": "pty", "cmd": cmd }))
        }
        "opencode" => {
            let bundled = local.join(r"Programs\@opencode-aidesktop\resources\opencode-cli.exe");
            let mut cmd = if bundled.exists() {
                quoted(&bundled)
            } else if which("opencode") {
                "opencode".to_string()
            } else {
                return None;
            };
            if opts.resume {
                cmd.push_str(" --continue");
            }
            Some(json!({ "kind": "pty", "cmd": cmd }))
        }
        "antigravity" => {
            // Prefer the Antigravity CLI (`agy`) so it runs inside a lienzo
            // terminal; fall back to opening its desktop app.
            // `--dangerously-skip-permissions` stops the constant tool
            // permission prompts — remove the flag here to get them back.
            let mut flags = String::from("--dangerously-skip-permissions");
            if opts.plan {
                flags.push_str(" --mode plan");
            }
            if let Some(m) = &model {
                flags.push_str(&format!(" --model {m}"));
            }
            if let Some(e) = &effort {
                flags.push_str(&format!(" --effort {e}"));
            }
            if opts.resume {
                flags.push_str(" --continue");
            }
            let agy = local.join(r"agy\bin\agy.exe");
            if agy.exists() {
                Some(json!({ "kind": "pty", "cmd": format!("{} {}", quoted(&agy), flags) }))
            } else if which("agy") {
                Some(json!({ "kind": "pty", "cmd": format!("agy {}", flags) }))
            } else {
                let app_exe = local.join(r"Programs\antigravity\Antigravity.exe");
                if app_exe.exists() {
                    Some(json!({ "kind": "app", "exe": app_exe.display().to_string() }))
                } else {
                    None
                }
            }
        }
        _ => None,
    }
}

/// OpenCode no acepta modelo por flag al abrir la TUI: se fija en la config del
/// proyecto (`model`, con la variante tras `#`, p. ej. `proveedor/modelo#alto`).
fn set_opencode_model(project: &Path, model: &str) -> Result<(), String> {
    let cfg_path = project.join("opencode.json");
    let mut cfg = read_json(&cfg_path)?;
    if !cfg.is_object() {
        cfg = json!({});
    }
    cfg.as_object_mut()
        .unwrap()
        .insert("model".into(), json!(model));
    write_json_pretty(&cfg_path, &cfg)
}

/// Open an agent: returns `{kind:"pty", cmd}` for the frontend to spawn in a
/// terminal panel, or launches its desktop app (`kind:"app"`) directly.
/// `mode = "plan"` starts the CLI in its read-only planning mode when it
/// supports one.
#[tauri::command]
pub async fn team_open(
    app: tauri::AppHandle,
    agent: String,
    mode: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    resume: Option<bool>,
) -> Result<Value, String> {
    let opts = LaunchOpts {
        plan: mode.as_deref() == Some("plan"),
        model,
        effort,
        resume: resume.unwrap_or(false),
    };
    // OpenCode: el modelo va en la config del proyecto, no en la línea de comandos.
    if agent == "opencode" {
        if let (Some(m), Some(dir)) = (
            opts.model.as_deref().and_then(safe_token),
            project_of(&app).filter(|p| !p.trim().is_empty()),
        ) {
            let _ = set_opencode_model(Path::new(dir.trim()), &m);
        }
    }
    let spec = launch_target(&agent, &opts)
        .ok_or_else(|| format!("no encontré cómo abrir «{}» — ¿está instalado?", agent))?;
    if spec.get("kind").and_then(|k| k.as_str()) == Some("app") {
        let exe = spec
            .get("exe")
            .and_then(|e| e.as_str())
            .ok_or("ruta de la app no encontrada")?;
        let mut cmd = Command::new(exe);
        if let Some(project) = project_of(&app).filter(|p| !p.trim().is_empty()) {
            cmd.arg(project);
        }
        // Si el lanzador fuera de consola, que no deje una ventana negra (a una app con
        // ventana propia no le afecta).
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        cmd.spawn()
            .map_err(|e| format!("no se pudo abrir {}: {e}", exe))?;
        Ok(json!({ "kind": "app" }))
    } else {
        // The OpenCode background service caches its MCP connections: if lienzo
        // restarted while a bridge was alive, it can be left with a dead
        // `lienzo-team` connection and no session gets the team tools. A quick
        // `opencode reload` makes it re-spawn the bridge before we open the TUI.
        if agent == "opencode" {
            if let Some(dir) = project_of(&app).filter(|p| !p.trim().is_empty()) {
                let local = std::env::var("LOCALAPPDATA")
                    .map(PathBuf::from)
                    .unwrap_or_default();
                let cli = local.join(r"Programs\@opencode-aidesktop\resources\opencode-cli.exe");
                if cli.exists() {
                    let mut reload = Command::new(cli);
                    reload.arg("reload").current_dir(&dir);
                    #[cfg(windows)]
                    {
                        use std::os::windows::process::CommandExt;
                        reload.creation_flags(0x08000000); // CREATE_NO_WINDOW
                    }
                    if let Ok(mut child) = reload
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .spawn()
                    {
                        // Best-effort: give it a moment, never block the UI for long.
                        for _ in 0..20 {
                            match child.try_wait() {
                                Ok(Some(_)) | Err(_) => break,
                                Ok(None) => std::thread::sleep(Duration::from_millis(150)),
                            }
                        }
                        let _ = child.kill();
                    }
                }
            }
        }
        // Con carpetas aisladas fuera del proyecto (proyecto en OneDrive), Claude Code necesita
        // permiso para trabajar allí: se la añade como carpeta de trabajo.
        let mut spec = spec;
        if agent == "claude" {
            if let Some(dir) = isolated_outside(&app) {
                if let Some(cmd) = spec["cmd"].as_str().map(|c| format!("{c} --add-dir {}", quoted(&dir))) {
                    spec["cmd"] = json!(cmd);
                }
            }
        }
        Ok(spec)
    }
}

/// La carpeta de las copias de las tareas, si las carpetas aisladas están activas y quedan fuera
/// del proyecto (la crea, para que el CLI la acepte).
fn isolated_outside(app: &tauri::AppHandle) -> Option<PathBuf> {
    let (on, project) = app.try_state::<Hub>().and_then(|hub| hub.0.lock().ok().map(|i| (i.isolate, i.project.clone())))?;
    let root = PathBuf::from(project?.trim());
    if !on || !root.is_dir() {
        return None;
    }
    let dir = crate::workspace::tasks_root(&root.canonicalize().unwrap_or(root.clone()));
    if crate::hub::project_key(&dir.display().to_string()).starts_with(&crate::hub::project_key(&root.display().to_string())) {
        return None;
    }
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// El CLI de OpenCode: el incluido con su app de escritorio o el del PATH.
fn opencode_cli() -> Option<PathBuf> {
    let local = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_default();
    let bundled = local.join(r"Programs\@opencode-aidesktop\resources\opencode-cli.exe");
    if bundled.exists() {
        return Some(bundled);
    }
    if which("opencode") {
        return Some(PathBuf::from("opencode"));
    }
    None
}

/// Sesión viva de OpenCode para un directorio (la más reciente en su db).
fn opencode_session_for(dir: &str) -> Result<String, String> {
    let db = home().join(".local/share/opencode/opencode.db");
    if !db.is_file() {
        return Err("no encontré opencode.db (¿se usó OpenCode en este equipo?)".into());
    }
    let con = rusqlite::Connection::open_with_flags(
        &db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("no pude abrir opencode.db: {e}"))?;
    let want = dir.replace('\\', "/").trim_end_matches('/').to_lowercase();
    let sid: Option<String> = con
        .query_row(
            "select id from session_v2 where lower(replace(directory, '\\', '/')) = ?1 \
             order by time_updated desc limit 1",
            [&want],
            |r| r.get(0),
        )
        .ok();
    sid.ok_or_else(|| "OpenCode no tiene sesión registrada para esta carpeta".into())
}

/// Compacta la sesión de OpenCode de una carpeta con la API de su servidor
/// local (`POST /api/session/:id/compact`): la vía fiable para el relevo con
/// memoria, sin teclear nada en su TUI. La petición es duradera: aunque la
/// respuesta tarde, el servidor la ejecuta al llegar al siguiente límite de paso.
#[tauri::command]
pub async fn opencode_compact(project: String) -> Result<String, String> {
    let dir = project.trim().to_string();
    if dir.is_empty() {
        return Err("sin carpeta de proyecto".into());
    }
    let sid = opencode_session_for(&dir)?;
    let cli = opencode_cli().ok_or("no encontré el CLI de OpenCode")?;
    let mut cmd = Command::new(&cli);
    cmd.arg("api")
        .arg("POST")
        .arg(format!("/api/session/{sid}/compact"))
        .current_dir(&dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("no pude invocar el CLI de OpenCode: {e}"))?;
    let mut waited = 0u64;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) => {
                if waited >= 8000 {
                    break None;
                }
                std::thread::sleep(Duration::from_millis(200));
                waited += 200;
            }
            Err(e) => return Err(format!("error esperando al CLI de OpenCode: {e}")),
        }
    };
    let short = sid.chars().take(14).collect::<String>();
    match status {
        None => {
            let _ = child.kill();
            Ok(format!("compactación aceptada por OpenCode ({short}…) — se aplicará en su siguiente límite de paso"))
        }
        Some(s) if s.success() => Ok(format!("contexto de OpenCode compactado ({short}…)")),
        Some(_) => {
            let out = child.wait_with_output().ok();
            let msg = out
                .as_ref()
                .map(|o| {
                    let so = String::from_utf8_lossy(&o.stdout).trim().to_string();
                    let se = String::from_utf8_lossy(&o.stderr).trim().to_string();
                    if so.is_empty() { se } else { so }
                })
                .unwrap_or_default();
            Err(format!(
                "OpenCode rechazó la compactación: {}",
                msg.chars().take(300).collect::<String>()
            ))
        }
    }
}

// ---------------------------------------------------------------------------
// Catálogo de modelos y esfuerzo por agente
// ---------------------------------------------------------------------------

const EFFORTS_STD: &[&str] = &["low", "medium", "high", "xhigh", "max"];

/// Sin esto Antigravity, al arrancar, lanza su buscador de actualizaciones con una consola
/// propia (una ventana que parpadea). Solo vale «true»: con «1» lo ignora.
pub const AGY_NO_UPDATE: (&str, &str) = ("AGY_CLI_DISABLE_AUTO_UPDATE", "true");

fn agy_exe() -> PathBuf {
    let local = std::env::var("LOCALAPPDATA").map(PathBuf::from).unwrap_or_default();
    let agy = local.join(r"agy\bin\agy.exe");
    if agy.exists() { agy } else { PathBuf::from("agy") }
}

/// Como Antigravity ya no se actualiza solo (ver `AGY_NO_UPDATE`), Prometeo lo hace sin ventana
/// una vez al día, en segundo plano. Un fallo solo se anota en el registro de errores.
pub fn update_agy_daily() {
    const EVERY: std::time::Duration = std::time::Duration::from_secs(24 * 3600);
    let stamp = super::data_dir().join("agy-update.stamp");
    let recent = std::fs::metadata(&stamp)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age < EVERY);
    let exe = agy_exe();
    if recent || !exe.is_absolute() {
        return;
    }
    let _ = std::fs::write(&stamp, super::now_ms().to_string());
    let mut cmd = Command::new(&exe);
    cmd.arg("update")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let Ok(mut child) = cmd.spawn() else { return };
    for _ in 0..(10 * 60) {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    let mut err = String::new();
                    if let Some(mut e) = child.stderr.take() {
                        use std::io::Read;
                        let _ = e.read_to_string(&mut err);
                    }
                    let detail = err.trim().chars().take(600).collect::<String>();
                    crate::errlog::log("antigravity", "No se pudo actualizar Antigravity", &detail);
                }
                return;
            }
            Ok(None) => std::thread::sleep(Duration::from_secs(1)),
            Err(_) => return,
        }
    }
    let _ = child.kill();
    crate::errlog::log("antigravity", "La actualización de Antigravity tardó demasiado", "");
}

/// Ejecuta un CLI sin ventana y devuelve su stdout, con tope de espera.
fn run_capture(exe: &Path, args: &[&str], wait_ms: u64) -> Option<String> {
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .env(AGY_NO_UPDATE.0, AGY_NO_UPDATE.1)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().ok()?;
    let mut waited = 0u64;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if waited >= wait_ms {
                    let _ = child.kill();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(100));
                waited += 100;
            }
            Err(_) => return None,
        }
    }
    let out = child.wait_with_output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

fn model_entry(id: &str, label: &str, efforts: &[String]) -> Value {
    json!({ "id": id, "label": label, "efforts": efforts })
}

fn std_efforts() -> Vec<String> {
    EFFORTS_STD.iter().map(|s| s.to_string()).collect()
}

/// Valor de una clave de primer nivel en un TOML sencillo (`key = "valor"`).
fn toml_top_value(text: &str, key: &str) -> Option<String> {
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with('[') {
            break; // solo las claves anteriores a la primera tabla
        }
        if let Some(rest) = l.strip_prefix(key) {
            let rest = rest.trim_start();
            if let Some(v) = rest.strip_prefix('=') {
                return Some(v.trim().trim_matches('"').to_string());
            }
        }
    }
    None
}

/// Modelos y niveles de esfuerzo que admite cada agente, para el selector del
/// modal de equipo. `current` es lo que el propio agente tiene configurado.
#[tauri::command]
pub async fn team_models(agent: String) -> Result<Value, String> {
    match agent.as_str() {
        "claude" => {
            let efforts = std_efforts();
            Ok(json!({
                "models": [
                    model_entry("opus", "Opus", &efforts),
                    model_entry("sonnet", "Sonnet", &efforts),
                    model_entry("haiku", "Haiku", &efforts),
                    model_entry("fable", "Fable", &efforts),
                ],
                "efforts": efforts,
                "current": { "model": null, "effort": null },
                "live": true,
            }))
        }
        "codex" => {
            let cfg = std::fs::read_to_string(home().join(".codex").join("config.toml")).unwrap_or_default();
            let current_model = toml_top_value(&cfg, "model");
            let current_effort = toml_top_value(&cfg, "model_reasoning_effort");
            let mut models: Vec<Value> = vec![];
            let cache = std::fs::read_to_string(home().join(".codex").join("models_cache.json")).unwrap_or_default();
            if let Ok(v) = serde_json::from_str::<Value>(&cache) {
                if let Some(list) = v.get("models").and_then(|m| m.as_array()) {
                    for m in list {
                        if m.get("visibility").and_then(|x| x.as_str()) != Some("list") {
                            continue;
                        }
                        let slug = m.get("slug").and_then(|x| x.as_str()).unwrap_or("");
                        if slug.is_empty() {
                            continue;
                        }
                        let label = m.get("display_name").and_then(|x| x.as_str()).unwrap_or(slug);
                        let efforts: Vec<String> = m
                            .get("supported_reasoning_levels")
                            .and_then(|x| x.as_array())
                            .map(|a| {
                                a.iter()
                                    .filter_map(|e| e.get("effort").and_then(|x| x.as_str()))
                                    .map(|s| s.to_string())
                                    .collect()
                            })
                            .unwrap_or_default();
                        models.push(model_entry(slug, label, &efforts));
                    }
                }
            }
            if models.is_empty() {
                if let Some(m) = &current_model {
                    models.push(model_entry(m, m, &["low", "medium", "high", "xhigh"].map(String::from)));
                }
            }
            Ok(json!({
                "models": models,
                "efforts": ["low", "medium", "high", "xhigh"],
                "current": { "model": current_model, "effort": current_effort },
                "live": false,
            }))
        }
        "antigravity" => {
            let exe = agy_exe();
            let efforts = std_efforts();
            let mut models: Vec<Value> = vec![];
            if let Some(out) = run_capture(&exe, &["models"], 12_000) {
                for line in out.lines() {
                    let mut it = line.splitn(2, '\t');
                    let (Some(id), Some(label)) = (it.next(), it.next()) else { continue };
                    let id = id.trim();
                    if id.is_empty() || id.contains(' ') {
                        continue;
                    }
                    models.push(model_entry(id, label.trim(), &efforts));
                }
            }
            Ok(json!({ "models": models, "efforts": efforts, "current": { "model": null, "effort": null }, "live": false }))
        }
        "opencode" => {
            let mut models: Vec<Value> = vec![];
            if let Some(cli) = opencode_cli() {
                if let Some(out) = run_capture(&cli, &["models"], 12_000) {
                    for line in out.lines() {
                        let id = line.trim();
                        if id.is_empty() || id.contains(' ') || !id.contains('/') {
                            continue;
                        }
                        models.push(model_entry(id, id, &[]));
                    }
                }
            }
            Ok(json!({ "models": models, "efforts": [], "current": { "model": null, "effort": null }, "live": false }))
        }
        other => Err(format!("agente desconocido: {other}")),
    }
}

/// Id de la conversación más reciente de un agente en la carpeta del proyecto, para
/// retomarla al reabrirlo. Antigravity anota cada mensaje en su `history.jsonl` con la
/// carpeta (`workspace`) y la conversación (`conversationId`). Claude Code y Codex lo
/// mandan con sus hooks (ver `AgentInfo::cli_session`), así que aquí no hace falta.
#[tauri::command]
pub async fn team_agent_session(agent: String, project: String) -> Option<String> {
    if agent != "antigravity" {
        return None;
    }
    let path = home().join(".gemini").join("antigravity-cli").join("history.jsonl");
    let meta = std::fs::metadata(&path).ok()?;
    let start = meta.len().saturating_sub(256 * 1024);
    let mut file = std::fs::File::open(&path).ok()?;
    use std::io::{Read, Seek, SeekFrom};
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_lowercase();
    let want = norm(&project);
    // El último mensaje de esta carpeta manda. El primero de una conversación nueva aún no
    // lleva id: entonces no se sabe (y no se devuelve el de la conversación anterior).
    let last = text.lines().rev().find_map(|line| {
        let v: Value = serde_json::from_str(line).ok()?;
        (norm(v["workspace"].as_str()?) == want).then_some(v)
    })?;
    let id = last["conversationId"].as_str()?;
    (!id.is_empty() && id.len() < 100).then(|| id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconoce_el_puente_en_la_config() {
        let exe = r"C:\Users\yo\AppData\Local\Prometeo\lienzo-mcp.exe";
        let json = r#"{"mcpServers":{"lienzo-team":{"command":"C:\Users\yo\AppData\Local\Prometeo\lienzo-mcp.exe"}}}"#;
        assert!(uses_bridge(json, exe));
        assert!(uses_bridge(&format!("command = '{exe}'"), exe));
        // Otro puente (la compilación de desarrollo) no cuenta como conectado.
        let dev = r#"{"command":"C:\Users\yo\Projects\lienzo\src-tauri\target\debug\lienzo-mcp.exe"}"#;
        assert!(!uses_bridge(dev, exe));
    }

    #[test]
    fn codex_cambia_el_puente_viejo() {
        let old = "model = \"gpt\"\n\n# lienzo team (auto-generado)\n[mcp_servers.lienzo-team]\ncommand = \"C:\\\\dev\\\\target\\\\debug\\\\lienzo-mcp.exe\"\nargs = []\n\n[mcp_servers.lienzo-team.env]\nLIENZO_AGENT = \"codex\"\n\n[tui]\nx = true\n";
        let exe = r"C:\Users\yo\AppData\Local\Prometeo\lienzo-mcp.exe";
        let new = codex_config(old, exe);
        assert!(!new.contains("debug"), "{new}");
        assert!(uses_bridge(&new, exe), "{new}");
        assert_eq!(new.matches("[mcp_servers.lienzo-team]").count(), 1);
        assert_eq!(new.matches("# lienzo team").count(), 1);
        assert!(new.contains("model = \"gpt\"") && new.contains("[tui]\nx = true"), "{new}");
        // Lo que ya está bien se queda igual al volver a escribirlo.
        assert_eq!(codex_config(&new, exe), new);
        assert!(codex_config("", exe).starts_with("# lienzo team"));
    }

    /// De punta a punta con un Codex instalado: `LIENZO_TEST_CODEX_DIR` (carpeta de prueba de confianza)
    /// y `LIENZO_TEST_EXE` (el puente). Escribe los hooks como `connect_codex` y los aprueba.
    #[test]
    #[ignore]
    fn codex_aprueba_sus_hooks_de_verdad() {
        let dir = std::env::var("LIENZO_TEST_CODEX_DIR").expect("LIENZO_TEST_CODEX_DIR");
        let exe = std::env::var("LIENZO_TEST_EXE").expect("LIENZO_TEST_EXE");
        let p = Path::new(&dir);
        let hooks_path = p.join(".codex").join("hooks.json");
        let mut hooks = read_json(&hooks_path).unwrap();
        merge_hooks(&mut hooks, &exe, "codex");
        write_json_pretty(&hooks_path, &hooks).unwrap();
        let n = codex_trust_hooks(p, &exe).expect("aprobar");
        assert_eq!(n, 4, "los 4 hooks del puente, aprobados");
        assert_eq!(codex_trust_hooks(p, &exe).expect("otra vez"), 0, "ya estaban aprobados");
    }

    #[test]
    fn codex_hooks_para_powershell_y_su_aprobacion() {
        let exe = r"C:\Users\yo\AppData\Local\Prometeo\lienzo-mcp.exe";
        let mut hooks = json!({});
        merge_hooks(&mut hooks, exe, "codex");
        let h = &hooks["hooks"]["Stop"][0]["hooks"][0];
        assert_eq!(h["commandWindows"], format!("& \"{exe}\" hook --agent codex --event stop"));
        assert_eq!(h["command"], format!("\"{exe}\" hook --agent codex --event stop"));
        // Claude no lo lleva (lo ejecuta con su propia shell).
        let mut c = json!({});
        merge_hooks(&mut c, exe, "claude");
        assert!(c["hooks"]["Stop"][0]["hooks"][0].get("commandWindows").is_none());

        let list = json!({ "data": [ { "hooks": [
            { "key": "a:stop:0:0", "command": format!("\"{exe}\" hook --agent codex --event stop"), "trustStatus": "untrusted", "currentHash": "sha256:1" },
            { "key": "a:stop:0:1", "command": format!("\"{exe}\" hook --agent codex --event tool"), "trustStatus": "trusted", "currentHash": "sha256:2" },
            { "key": "a:stop:1:0", "command": "otro.exe", "trustStatus": "untrusted", "currentHash": "sha256:3" }
        ] } ] });
        assert_eq!(codex_untrusted_ours(&list, exe), json!({ "a:stop:0:0": { "trusted_hash": "sha256:1" } }));
    }

    #[test]
    fn reconoce_un_proyecto_de_otro_prometeo() {
        let dir = std::env::temp_dir().join(format!("lienzo-foreign-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mine = r"C:\Prometeo Dev\lienzo-mcp.exe";
        assert!(!foreign_bridge(&dir, mine), "carpeta nueva: libre");
        std::fs::write(dir.join(".mcp.json"), r#"{"mcpServers":{"lienzo-team":{"command":"C:\\Users\\yo\\AppData\\Local\\Prometeo\\lienzo-mcp.exe"}}}"#).unwrap();
        assert!(foreign_bridge(&dir, mine), "conectada al Prometeo normal");
        assert!(!foreign_bridge(&dir, r"C:\Users\yo\AppData\Local\Prometeo\lienzo-mcp.exe"), "la suya no es ajena");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn codex_confia_en_la_carpeta_del_equipo() {
        let p = Path::new(r"C:\Users\Yo\Escritorio\mejora de skill");
        let block = codex_trust_block(p);
        assert!(codex_project_listed(&block, p), "{block}");
        assert!(!codex_project_listed("[projects.'c:\\otra']\ntrust_level = \"trusted\"\n", p));
        // Una marcada a mano (con comillas dobles o como no confiada) cuenta como ya decidida.
        let manual = "[projects.\"c:\\\\users\\\\yo\\\\escritorio\\\\mejora de skill\"]\ntrust_level = \"untrusted\"\n";
        assert!(codex_project_listed(manual, p), "{manual}");
        if cfg!(windows) {
            assert!(block.contains(r"[projects.'c:\users\yo\escritorio\mejora de skill']"), "{block}");
        }
    }

    #[test]
    fn codex_en_dev_no_escribe_config_global() {
        let exe = r"C:\Users\yo\AppData\Local\Prometeo\lienzo-mcp.exe";
        let project = Path::new(r"C:\Users\yo\Projects\mi-app");
        let global_before = "model = \"o3-mini\"\n";
        let local_before = "";

        // En modo dev (is_dev = true): nunca se escribe en el config global ni se añade el bloque de confianza global.
        let plan_dev = plan_codex_config(true, global_before, local_before, exe, project);
        assert_eq!(
            plan_dev.global_write, None,
            "En dev nunca debe haber escritura en el config global"
        );
        assert!(
            plan_dev.local_write.is_some(),
            "En dev debe prepararse la escritura en el config local del proyecto"
        );
        let local_text = plan_dev.local_write.unwrap();
        assert!(uses_bridge(&local_text, exe));
        assert!(plan_dev.note.is_some());
        assert!(plan_dev.note.unwrap().contains("Codex"));

        // En modo normal (is_dev = false): se actualiza el config global con el puente y la confianza.
        let plan_prod = plan_codex_config(false, global_before, local_before, exe, project);
        assert!(
            plan_prod.global_write.is_some(),
            "En producción se debe actualizar el config global con el puente y la confianza"
        );
        let global_text = plan_prod.global_write.unwrap();
        assert!(uses_bridge(&global_text, exe));
        assert!(codex_project_listed(&global_text, project));
        assert_eq!(plan_prod.local_write, None);
    }

    #[test]
    fn json_invalido_devuelve_error_y_preserva_archivo() {
        let dir = std::env::temp_dir().join(format!("lienzo-test-broken-json-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // 1. Archivo .mcp.json con JSON inválido y contenido reconocible:
        let mcp_path = dir.join(".mcp.json");
        let broken_bytes = b"{\n  \"mcpServers\": {\n    \"otro\": { roto sin cerrar ...\n";
        std::fs::write(&mcp_path, broken_bytes).unwrap();

        // read_json debe fallar con mensaje en español nombrando el archivo
        let res = read_json(&mcp_path);
        assert!(res.is_err(), "debe fallar al leer JSON inválido");
        let err_msg = res.unwrap_err();
        assert!(
            err_msg.contains(".mcp.json"),
            "el mensaje de error debe nombrar el archivo: {err_msg}"
        );

        // connect_claude debe fallar y devolver ese error
        let exe = r"C:\Users\yo\AppData\Local\Prometeo\lienzo-mcp.exe";
        let connect_res = connect_claude(&dir, exe);
        assert!(connect_res.is_err(), "connect_claude debe fallar si .mcp.json es inválido");
        let connect_err = connect_res.unwrap_err();
        assert!(
            connect_err.contains(".mcp.json"),
            "el error de connect_claude debe nombrar el archivo: {connect_err}"
        );

        // El archivo debe quedar con exactamente los mismos bytes (no reemplazado por {})
        let bytes_after = std::fs::read(&mcp_path).unwrap();
        assert_eq!(
            bytes_after, broken_bytes,
            "el archivo con JSON roto debe permanecer intacto sin sobrescribirse"
        );

        // 2. Archivo ausente debe devolver Ok({}) sin error
        let missing = dir.join("no-existe.json");
        let ok_val = read_json(&missing).expect("archivo ausente debe devolver Ok({})");
        assert_eq!(ok_val, json!({}));

        // 3. Vacío o con BOM (Bloc de notas) se lee bien
        let empty = dir.join("vacio.json");
        std::fs::write(&empty, b"  \n").unwrap();
        assert_eq!(read_json(&empty).unwrap(), json!({}));
        let bom = dir.join("bom.json");
        std::fs::write(&bom, "\u{feff}{\"a\": 1}").unwrap();
        assert_eq!(read_json(&bom).unwrap(), json!({"a": 1}));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ruta_real_sin_prefijo_de_windows() {
        let dir = std::env::temp_dir();
        let r = real_path(&dir).display().to_string();
        assert!(!r.starts_with(r"\?\"), "{r}");
        assert!(Path::new(&r).exists());
        // Si no existe, se queda como estaba.
        let missing = dir.join("no-existe-lienzo-xyz");
        assert_eq!(real_path(&missing), missing);
    }
}
