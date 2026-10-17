//! One-click connectors: detect installed agents (Claude Code, Codex, OpenCode,
//! Antigravity) and write their configuration so they join the lienzo team
//! through `lienzo-mcp.exe`.

use crate::hub::{self, Hub};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
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

fn mcp_exe_path() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("sin directorio de la app")?;
    let candidate = dir.join("lienzo-mcp.exe");
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
- `team_task_create` / `team_task_list` / `team_task_claim` / `team_task_done`: tareas compartidas.\n\n\
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
    let defs: [(&str, &str, Option<&str>); 4] = [
        ("SessionStart", "session", None),
        ("UserPromptSubmit", "prompt", None),
        ("PostToolUse", "tool", Some("Edit|Write|MultiEdit|NotebookEdit|Bash")),
        ("Stop", "stop", None),
    ];
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
    let mut notes = vec![
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

/// Where to open an agent: a terminal command (`pty`) or its desktop app (`app`).
pub fn launch_target(agent: &str) -> Option<Value> {
    let local = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_default();
    match agent {
        "claude" | "codex" => {
            let def = AGENTS.iter().find(|d| d.id == agent)?;
            if cli_installed(def) {
                Some(json!({ "kind": "pty", "cmd": agent }))
            } else {
                None
            }
        }
        "opencode" => {
            let bundled = local.join(r"Programs\@opencode-aidesktop\resources\opencode-cli.exe");
            if bundled.exists() {
                Some(json!({ "kind": "pty", "cmd": bundled.display().to_string() }))
            } else if which("opencode") {
                Some(json!({ "kind": "pty", "cmd": "opencode" }))
            } else {
                None
            }
        }
        "antigravity" => {
            // Prefer the Antigravity CLI (`agy`) so it runs inside a lienzo
            // terminal; fall back to opening its desktop app.
            // `--dangerously-skip-permissions` stops the constant tool
            // permission prompts — remove the flag here to get them back.
            let agy = local.join(r"agy\bin\agy.exe");
            if agy.exists() {
                Some(json!({
                    "kind": "pty",
                    "cmd": format!("\"{}\" --dangerously-skip-permissions", agy.display())
                }))
            } else if which("agy") {
                Some(json!({ "kind": "pty", "cmd": "agy --dangerously-skip-permissions" }))
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

/// Open an agent: returns `{kind:"pty", cmd}` for the frontend to spawn in a
/// terminal panel, or launches its desktop app (`kind:"app"`) directly.
#[tauri::command]
pub fn team_open(app: tauri::AppHandle, agent: String) -> Result<Value, String> {
    let spec = launch_target(&agent)
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
        Ok(spec)
    }
}
