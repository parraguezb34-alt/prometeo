//! Team hub: shared activity feed, tasks, file claims and messages so multiple
//! AI agents (Claude Code, Codex, OpenCode, Antigravity, ...) can work as a team.
//!
//! Architecture:
//! - The hub lives inside the app (this module): state + local HTTP server.
//! - `lienzo-mcp.exe` (companion binary) connects agents to the hub:
//!   it speaks MCP over stdio and forwards to the hub's HTTP API.
//! - Terminal sessions spawned by the app inherit `LIENZO_HUB` / `LIENZO_TOKEN`
//!   so any process running inside a lienzo terminal can reach the hub.

pub mod client;
pub mod connectors;
pub mod server;

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

pub const MAX_EVENTS: usize = 500;
/// Agents are considered online when they checked in this recently.
pub const AGENT_TTL_MS: u64 = 75_000;
/// A task claimed by an agent with no session heartbeating this long is released.
pub const TASK_ORPHAN_MS: u64 = AGENT_TTL_MS * 2;

#[derive(Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub session_id: String,
    pub name: String,
    pub project: String,
    pub pid: u32,
    pub last_seen_ms: u64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Event {
    pub seq: u64,
    pub ts_ms: u64,
    pub agent: String,
    pub session_id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub to: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: u64,
    pub title: String,
    #[serde(default)]
    pub status: String, // open | claimed | done
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub notes: String,
    pub created_ms: u64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Claim {
    pub path: String,
    pub session_id: String,
    pub agent: String,
    pub ts_ms: u64,
}

/// A prompt the user sent to the whole team (delivered to hooks on demand).
#[derive(Clone)]
pub struct Broadcast {
    pub seq: u64,
    pub ts_ms: u64,
    pub text: String,
}

#[derive(Serialize, Deserialize, Default)]
pub struct PersistedState {
    #[serde(default)]
    pub events: Vec<Event>,
    #[serde(default)]
    pub tasks: Vec<Task>,
    #[serde(default)]
    pub claims: Vec<Claim>,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub charter: Option<String>,
    #[serde(default)]
    pub leader: Option<String>,
    #[serde(default)]
    pub seq: u64,
    #[serde(default)]
    pub task_seq: u64,
}

pub struct HubInner {
    pub token: String,
    pub port: u16,
    pub agents: HashMap<String, AgentInfo>,
    pub events: VecDeque<Event>,
    pub tasks: Vec<Task>,
    pub claims: HashMap<String, Claim>,
    pub project: Option<String>,
    pub charter: Option<String>,
    pub leader: Option<String>,
    pub broadcasts: VecDeque<Broadcast>,
    /// Broadcast delivery marks: `session:<id>` (hooks) or `agent:<name>` (terminals).
    pub broadcast_marks: HashMap<String, u64>,
    pub seq: u64,
    pub task_seq: u64,
}

pub struct Hub(pub Mutex<HubInner>);

static APP: OnceLock<AppHandle> = OnceLock::new();
static HUB_INFO: OnceLock<(String, String)> = OnceLock::new(); // (url, token)

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn data_dir() -> std::path::PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    let dir = std::path::PathBuf::from(base).join("lienzo");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

pub fn state_file() -> std::path::PathBuf {
    data_dir().join("team-state.json")
}

pub fn discovery_file() -> std::path::PathBuf {
    data_dir().join("hub.json")
}

pub fn random_token() -> String {
    let mut bytes = [0u8; 16];
    let _ = getrandom::fill(&mut bytes);
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// URL + token of the running hub (set during `init`).
pub fn hub_info() -> Option<(String, String)> {
    HUB_INFO.get().cloned()
}

/// Environment variables injected into every terminal spawned by the app.
pub fn terminal_env_vars() -> Vec<(String, String)> {
    match hub_info() {
        Some((url, token)) => vec![
            ("LIENZO_HUB".to_string(), url),
            ("LIENZO_TOKEN".to_string(), token),
        ],
        None => vec![],
    }
}

/// Default working directory for new terminals: the team project if set.
pub fn default_terminal_dir() -> Option<String> {
    APP.get()
        .and_then(|app| app.try_state::<Hub>())
        .and_then(|hub| hub.0.lock().ok().and_then(|i| i.project.clone()))
        .filter(|p| std::path::Path::new(p).is_dir())
}

pub fn load_persisted() -> PersistedState {
    std::fs::read_to_string(state_file())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn persist(inner: &HubInner) {
    let state = PersistedState {
        events: inner.events.iter().cloned().collect(),
        tasks: inner.tasks.clone(),
        claims: inner.claims.values().cloned().collect(),
        project: inner.project.clone(),
        charter: inner.charter.clone(),
        leader: inner.leader.clone(),
        seq: inner.seq,
        task_seq: inner.task_seq,
    };
    if let Ok(raw) = serde_json::to_string(&state) {
        let _ = std::fs::write(state_file(), raw);
    }
}

/// Notify the UI that team state changed.
pub fn notify_ui() {
    if let Some(app) = APP.get() {
        let _ = app.emit("team://update", ());
    }
}

/// Push an event into the feed. Caller is responsible for persist/notify.
pub fn push_event(
    inner: &mut HubInner,
    agent: &str,
    session_id: &str,
    kind: &str,
    text: &str,
    files: Vec<String>,
    to: Option<String>,
) -> Event {
    inner.seq += 1;
    let event = Event {
        seq: inner.seq,
        ts_ms: now_ms(),
        agent: agent.to_string(),
        session_id: session_id.to_string(),
        kind: kind.to_string(),
        text: text.to_string(),
        files,
        to,
    };
    inner.events.push_back(event.clone());
    while inner.events.len() > MAX_EVENTS {
        inner.events.pop_front();
    }
    event
}

/// Resolve (agent display name, session id) for an incoming event.
pub fn agent_label(inner: &HubInner, session_id: &str, fallback: Option<&str>) -> (String, String) {
    if let Some(agent) = inner.agents.get(session_id) {
        return (agent.name.clone(), session_id.to_string());
    }
    (
        fallback.unwrap_or("agente").to_string(),
        if session_id.is_empty() {
            "hook".to_string()
        } else {
            session_id.to_string()
        },
    )
}

/// Full state snapshot shared by the UI command and the HTTP API.
pub fn snapshot(inner: &HubInner, limit: usize) -> serde_json::Value {
    let now = now_ms();
    let agents: Vec<serde_json::Value> = inner
        .agents
        .values()
        .map(|a| {
            serde_json::json!({
                "session_id": a.session_id,
                "name": a.name,
                "project": a.project,
                "pid": a.pid,
                "last_seen_ms": a.last_seen_ms,
                "online": now.saturating_sub(a.last_seen_ms) < AGENT_TTL_MS,
            })
        })
        .collect();
    let events: Vec<&Event> = inner.events.iter().rev().take(limit).collect();
    serde_json::json!({
        "seq": inner.seq,
        "project": inner.project,
        "charter": inner.charter.clone().unwrap_or_else(default_charter),
        "leader": inner.leader,
        "agents": agents,
        "events": events,
        "tasks": inner.tasks,
        "claims": inner.claims.values().collect::<Vec<&Claim>>(),
        "now_ms": now,
    })
}

/// Team rules shared with every agent (customizable from the UI).
pub fn default_charter() -> String {
    "Trabajas en equipo con otros agentes de IA sobre el mismo proyecto dentro de la app lienzo, y hablas español.\n\
     1) Empieza con team_context y revisa team_feed antes de tocar nada.\n\
     2) Reserva los archivos con team_claim_files antes de editarlos y libéralos al terminar.\n\
     3) Publica cada avance en 1 línea con team_update; usa team_message para hablar con otro agente.\n\
     4) No repitas trabajo ya hecho (revisa feed y reservas); si algo está bloqueado, avísalo en el feed y sigue con otra parte.\n\
     5) Jerarquía: el líder coordina y reparte; los demás proponen y ejecutan su parte sin pelearse por el mando. Si no hay líder, decide quien reservó primero el archivo."
        .to_string()
}

/// Push a user broadcast into the feed and the pending-delivery queue.
pub fn broadcast(inner: &mut HubInner, text: &str) -> Event {
    let event = push_event(inner, "tú", "ui", "broadcast", text, vec![], None);
    inner.broadcasts.push_back(Broadcast {
        seq: event.seq,
        ts_ms: event.ts_ms,
        text: text.to_string(),
    });
    while inner.broadcasts.len() > 30 {
        inner.broadcasts.pop_front();
    }
    event
}

/// Broadcasts a session (or its whole agent) has not received yet.
pub fn pending_broadcasts(inner: &HubInner, session_id: &str, agent: &str) -> Vec<(u64, String)> {
    let session_mark = if session_id.is_empty() {
        0
    } else {
        inner.broadcast_marks.get(session_id).copied().unwrap_or(0)
    };
    let agent_mark = if agent.is_empty() {
        0
    } else {
        inner
            .broadcast_marks
            .get(&format!("agent:{}", agent))
            .copied()
            .unwrap_or(0)
    };
    let mark = session_mark.max(agent_mark);
    inner
        .broadcasts
        .iter()
        .filter(|b| b.seq > mark)
        .map(|b| (b.seq, b.text.clone()))
        .collect()
}

pub fn ack_broadcast(inner: &mut HubInner, key: &str, seq: u64) {
    let entry = inner.broadcast_marks.entry(key.to_string()).or_insert(0);
    if seq > *entry {
        *entry = seq;
    }
}

pub fn last_broadcast_seq(inner: &HubInner) -> u64 {
    inner.broadcasts.back().map(|b| b.seq).unwrap_or(0)
}

pub fn touch_agent(inner: &mut HubInner, session_id: &str) {
    if let Some(agent) = inner.agents.get_mut(session_id) {
        agent.last_seen_ms = now_ms();
    }
}

/// Drop agents that stopped heartbeating (and their file claims). Also releases
/// tasks whose owner no longer has any live session (orphaned work).
pub fn expire_agents(inner: &mut HubInner) -> bool {
    let now = now_ms();
    let stale: Vec<String> = inner
        .agents
        .iter()
        .filter(|(_, a)| now.saturating_sub(a.last_seen_ms) > AGENT_TTL_MS * 4)
        .map(|(k, _)| k.clone())
        .collect();
    let mut changed = !stale.is_empty();
    for id in stale {
        if let Some(agent) = inner.agents.remove(&id) {
            push_event(inner, &agent.name, &id, "leave", "desconectado", vec![], None);
            inner.claims.retain(|_, c| c.session_id != id);
        }
    }

    // Orphan tasks: a claimed task whose owner has no live session would stay
    // claimed forever if the agent died mid-work (seen in the wild). Release it
    // so another agent (or the user) can pick it up.
    let live: std::collections::HashSet<String> = inner
        .agents
        .values()
        .filter(|a| now.saturating_sub(a.last_seen_ms) < TASK_ORPHAN_MS)
        .map(|a| a.name.clone())
        .collect();
    let mut released: Vec<(u64, String, String)> = Vec::new();
    for task in inner.tasks.iter_mut() {
        if task.status == "claimed"
            && !task.owner.is_empty()
            && task.owner != "tú"
            && !live.contains(&task.owner)
        {
            released.push((task.id, task.owner.clone(), task.title.clone()));
            task.status = "open".into();
            task.owner = String::new();
        }
    }
    for (id, owner, title) in released {
        push_event(
            inner,
            &owner,
            "hub",
            "release",
            &format!("tarea #{} liberada (el agente dejó de responder): {}", id, title),
            vec![],
            None,
        );
        changed = true;
    }
    changed
}

// ---------------------------------------------------------------------------
// Tauri commands (UI side)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn team_state(hub: tauri::State<'_, Hub>) -> Result<serde_json::Value, String> {
    let inner = hub.0.lock().map_err(|e| e.to_string())?;
    Ok(snapshot(&inner, 200))
}

#[tauri::command]
pub fn team_details(hub: tauri::State<'_, Hub>) -> Result<serde_json::Value, String> {
    let inner = hub.0.lock().map_err(|e| e.to_string())?;
    let exe = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("lienzo-mcp.exe")))
        .map(|p| p.display().to_string());
    Ok(serde_json::json!({
        "url": format!("http://127.0.0.1:{}", inner.port),
        "token": inner.token,
        "mcp_exe": exe,
        "state_file": state_file().display().to_string(),
    }))
}

#[tauri::command]
pub fn team_project_set(hub: tauri::State<'_, Hub>, path: Option<String>) -> Result<(), String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    inner.project = path.filter(|p| !p.trim().is_empty());
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(())
}

/// Send a prompt to the whole team: feed event + pending deliveries for hooks.
#[tauri::command]
pub fn team_broadcast(hub: tauri::State<'_, Hub>, text: String) -> Result<u64, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("el mensaje está vacío".into());
    }
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    let seq = broadcast(&mut inner, &text).seq;
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(seq)
}

/// Mark broadcasts as already delivered to whole agents (typed into lienzo terminals).
#[tauri::command]
pub fn team_broadcast_ack(hub: tauri::State<'_, Hub>, agents: Vec<String>) -> Result<(), String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    let seq = last_broadcast_seq(&inner);
    for agent in agents {
        let name = agent.trim();
        if name.is_empty() {
            continue;
        }
        ack_broadcast(&mut inner, &format!("agent:{}", name), seq);
    }
    Ok(())
}

/// Set the shared team rules and/or the current leader.
#[tauri::command]
pub fn team_charter(
    hub: tauri::State<'_, Hub>,
    charter: Option<String>,
    leader: Option<String>,
) -> Result<(), String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    inner.charter = charter.and_then(|c| {
        let t = c.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    inner.leader = leader.and_then(|l| {
        let t = l.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(())
}

#[tauri::command]
pub fn team_add_task(hub: tauri::State<'_, Hub>, title: String) -> Result<(), String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    inner.task_seq += 1;
    let id = inner.task_seq;
    inner.tasks.push(Task {
        id,
        title: title.trim().to_string(),
        status: "open".into(),
        owner: String::new(),
        notes: String::new(),
        created_ms: now_ms(),
    });
    push_event(
        &mut inner,
        "tú",
        "ui",
        "task",
        &format!("#{} creada: {}", id, title.trim()),
        vec![],
        None,
    );
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(())
}

#[tauri::command]
pub fn team_task_op(hub: tauri::State<'_, Hub>, id: u64, op: String) -> Result<(), String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    {
        let task = inner
            .tasks
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| "tarea no encontrada".to_string())?;
        match op.as_str() {
            "done" => {
                task.status = "done".into();
                if task.owner.is_empty() {
                    task.owner = "tú".into();
                }
            }
            "claim" => {
                task.status = "claimed".into();
                task.owner = "tú".into();
            }
            "reopen" => {
                task.status = "open".into();
                task.owner = String::new();
            }
            _ => return Err("operación desconocida".into()),
        }
    }
    push_event(
        &mut inner,
        "tú",
        "ui",
        "task",
        &format!("tarea #{} -> {}", id, op),
        vec![],
        None,
    );
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(())
}

/// Log a direct user message to one agent in the feed (the text itself is typed
/// into its terminal by the UI, so the agent receives it as a prompt).
#[tauri::command]
pub fn team_dm(hub: tauri::State<'_, Hub>, agent: String, text: String) -> Result<(), String> {
    let agent = agent.trim().to_string();
    let text = text.trim().to_string();
    if agent.is_empty() || text.is_empty() {
        return Err("el mensaje está vacío".into());
    }
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    push_event(&mut inner, "tú", "ui", "message", &text, vec![], Some(agent));
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(())
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

pub fn init(app: AppHandle) -> Result<(), String> {
    let _ = APP.set(app.clone());

    let persisted = load_persisted();
    let token = random_token();

    let (server, port) = server::bind()?;

    let inner = HubInner {
        token: token.clone(),
        port,
        agents: HashMap::new(),
        events: persisted.events.into_iter().collect(),
        tasks: persisted.tasks,
        claims: persisted
            .claims
            .into_iter()
            .map(|c| (c.path.clone(), c))
            .collect(),
        project: persisted.project,
        charter: persisted.charter,
        leader: persisted.leader,
        broadcasts: VecDeque::new(),
        broadcast_marks: HashMap::new(),
        seq: persisted.seq,
        task_seq: persisted.task_seq,
    };

    // Publish hub address for terminal env injection + discovery file.
    let url = format!("http://127.0.0.1:{}", port);
    let _ = HUB_INFO.set((url.clone(), token.clone()));
    let _ = std::fs::write(
        discovery_file(),
        serde_json::json!({ "url": url, "token": token, "pid": std::process::id() }).to_string(),
    );

    app.manage(Hub(Mutex::new(inner)));

    let app2 = app.clone();
    std::thread::spawn(move || {
        server::serve(server, app2);
    });

    // Housekeeping: drop agents that stopped heartbeating.
    let app3 = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(15));
        let changed = with_inner(&app3, |inner| {
            if expire_agents(inner) {
                persist(inner);
                true
            } else {
                false
            }
        })
        .unwrap_or(false);
        if changed {
            notify_ui();
        }
    });

    Ok(())
}

/// Access the hub state from anywhere with an `AppHandle`.
pub fn with_inner<R>(app: &AppHandle, f: impl FnOnce(&mut HubInner) -> R) -> Option<R> {
    let hub = app.try_state::<Hub>()?;
    let mut inner = hub.0.lock().ok()?;
    Some(f(&mut inner))
}
