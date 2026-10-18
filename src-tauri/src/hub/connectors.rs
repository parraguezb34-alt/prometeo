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
        Ok(candidate.display().to_string())
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
    match agent {
        "claude" => connect_claude(project, &exe),
        "codex" => connect_codex(project, &exe),
        "opencode" => connect_opencode(project, &exe),
        "antigravity" => connect_antigravity(project, &exe),
        _ => Err(format!("agente desconocido: {agent}")),
    }
}

fn project_of(app: &tauri::AppHandle) -> Option<String> {
    app.try_state::<Hub>()
        .and_then(|hub| hub.0.lock().ok().and_then(|i| i.project.clone()))
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

fn read_json(path: &Path) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}))
}

fn write_json_pretty(path: &Path, v: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    std::fs::write(path, raw).map_err(|e| e.to_string())
}

fn team_block() -> String {
    format!(
        "{BLOCK_START}\n## Protocolo de equipo (lienzo)\n\n\
Trabajas junto a otros agentes de IA en el mismo proyecto, coordinados por la app lienzo.\n\
Tus herramientas del equipo llegan por MCP (servidor `lienzo-team`):\n\n\
- `team_context`: ANTES de empezar, mira compañeros, tareas y archivos reservados.\n\
- `team_update`: al terminar un paso importante, publica un resumen de 1 línea.\n\
- `team_claim_files` / `team_release_files`: reserva los archivos antes de editarlos para no pisar a otros; libéralos al acabar.\n\
- `team_feed` / `team_message`: consulta la actividad y habla con los demás agentes.\n\
- `team_task_create` / `team_task_list` / `team_task_claim` / `team_task_done`: tareas compartidas. Usa `parents` al crear para ordenar el trabajo: una tarea espera a que sus padres estén hechas. \
Al cerrar una tarea entrega `summary`, `files` y `evidence`: quien dependa de ella los recibe al reclamarla.\n\n\
You work alongside other AI agents on this project, coordinated by lienzo. Use the `lienzo-team` MCP tools \
(`team_context`, `team_update`, `team_feed`, `team_message`, `team_task_*`, `team_claim_files`, `team_release_files`) \
to coordinate: check context before starting, claim files before editing, and post updates when you finish a step.\n\
{BLOCK_END}"
    )
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
        ("PostToolUse", "tool", Some("Edit|Write|MultiEdit|NotebookEdit|Bash")),
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
    let mut mcp = read_json(&mcp_path);
    if !mcp.is_object() {
        mcp = json!({});
    }
    mcp.as_object_mut()
        .unwrap()
        .entry("mcpServers")
        .or_insert_with(|| json!({}))["lienzo-team"] = mcp_server_entry(exe, "claude");
    write_json_pretty(&mcp_path, &mcp)?;
    files.push(mcp_path.display().to_string());
    notes.push("Claude pedirá una vez aprobar el servidor MCP del proyecto.".into());

    // Hooks (activity + team context injection) + auto-approve project MCP.
    let settings_path = project.join(".claude").join("settings.json");
    let mut settings = read_json(&settings_path);
    if !settings.is_object() {
        settings = json!({});
    }
    settings
        .as_object_mut()
        .unwrap()
        .insert("enableAllProjectMcpServers".into(), json!(true));
    merge_hooks(&mut settings, exe, "claude");
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

fn connect_codex(project: &Path, exe: &str) -> Result<(Vec<String>, Vec<String>), String> {
    let mut files = vec![];
    let notes = vec!["Codex lee su MCP global; reinícialo si estaba abierto.".to_string()];

    // Global MCP config (~/.codex/config.toml).
    let cfg = home().join(".codex").join("config.toml");
    let existing = std::fs::read_to_string(&cfg).unwrap_or_default();
    if !existing.contains("mcp_servers.lienzo-team") {
        if let Some(parent) = cfg.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let block = format!(
            "\n# lienzo team (auto-generado)\n[mcp_servers.lienzo-team]\ncommand = \"{}\"\nargs = []\n\n[mcp_servers.lienzo-team.env]\nLIENZO_AGENT = \"codex\"\n",
            exe.replace('\\', "\\\\")
        );
        let merged = if existing.trim().is_empty() {
            block.trim_start().to_string()
        } else {
            format!("{}\n{}", existing.trim_end(), block)
        };
        std::fs::write(&cfg, merged).map_err(|e| e.to_string())?;
    }
    files.push(cfg.display().to_string());

    // Project hooks (same shape as Claude Code).
    let hooks_path = project.join(".codex").join("hooks.json");
    let mut hooks = read_json(&hooks_path);
    merge_hooks(&mut hooks, exe, "codex");
    write_json_pretty(&hooks_path, &hooks)?;
    files.push(hooks_path.display().to_string());

    let p = project.join("AGENTS.md");
    write_managed_block(&p, &team_block())?;
    files.push(p.display().to_string());
    Ok((files, notes))
}

fn connect_opencode(project: &Path, exe: &str) -> Result<(Vec<String>, Vec<String>), String> {
    let mut files = vec![];
    let notes = vec![
        "OpenCode v2: el servidor queda bajo mcp.servers.".to_string(),
        "Reinicia la sesión de OpenCode para que lo cargue.".to_string(),
    ];

    let cfg_path = project.join("opencode.json");
    let mut cfg = read_json(&cfg_path);
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
    Ok((files, notes))
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
    let mut ws = read_json(&ws_path);
    if !ws.is_object() {
        ws = json!({});
    }
    ws.as_object_mut()
        .unwrap()
        .entry("mcpServers")
        .or_insert_with(|| json!({}))["lienzo-team"] = entry.clone();
    write_json_pretty(&ws_path, &ws)?;
    files.push(ws_path.display().to_string());

    // Global config (~/.gemini/config/mcp_config.json) as a fallback.
    let global_path = home().join(".gemini").join("config").join("mcp_config.json");
    if global_path.exists() || global_path.parent().map(|p| p.exists()).unwrap_or(false) {
        let mut global = read_json(&global_path);
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

fn is_connected(id: &str, project: Option<&Path>) -> bool {
    match id {
        "claude" => project
            .map(|p| {
                std::fs::read_to_string(p.join(".mcp.json"))
                    .map(|s| s.contains("lienzo-team"))
                    .unwrap_or(false)
            })
            .unwrap_or(false),
        "codex" => std::fs::read_to_string(home().join(".codex").join("config.toml"))
            .map(|s| s.contains("mcp_servers.lienzo-team"))
            .unwrap_or(false),
        "opencode" => project
            .map(|p| {
                std::fs::read_to_string(p.join("opencode.json"))
                    .map(|s| s.contains("lienzo-team"))
                    .unwrap_or(false)
            })
            .unwrap_or(false),
        "antigravity" => project
            .map(|p| {
                std::fs::read_to_string(p.join(".agents").join("mcp_config.json"))
                    .map(|s| s.contains("lienzo-team"))
                    .unwrap_or(false)
            })
            .unwrap_or(false),
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn team_detect(app: tauri::AppHandle) -> Result<Value, String> {
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
pub fn team_connect(app: tauri::AppHandle, agent: String, project: Option<String>) -> Result<Value, String> {
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
    let mut cfg = read_json(&cfg_path);
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
pub fn team_open(
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
                    if let Ok(mut child) = Command::new(cli)
                        .arg("reload")
                        .current_dir(&dir)
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
        Ok(spec)
    }
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
pub fn opencode_compact(project: String) -> Result<String, String> {
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

/// Ejecuta un CLI sin ventana y devuelve su stdout, con tope de espera.
fn run_capture(exe: &Path, args: &[&str], wait_ms: u64) -> Option<String> {
    let mut cmd = Command::new(exe);
    cmd.args(args)
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
pub fn team_models(agent: String) -> Result<Value, String> {
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
            let local = std::env::var("LOCALAPPDATA").map(PathBuf::from).unwrap_or_default();
            let agy = local.join(r"agy\bin\agy.exe");
            let exe = if agy.exists() { agy } else { PathBuf::from("agy") };
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
