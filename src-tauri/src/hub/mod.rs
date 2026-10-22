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
pub mod mirror;
pub mod redact;
pub mod review;
pub mod schedule;
pub mod server;
mod ask;
mod commands;
mod director;
mod feed;
mod inbox;
mod usage;
#[cfg(test)]
mod tests;
pub use ask::*;
pub use commands::*;
pub use director::*;
pub use feed::*;
pub use inbox::*;
pub use usage::*;

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
    /// Última telemetría que reportó el puente (uso real de contexto).
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub ctx_tokens: Option<u64>,
    #[serde(default)]
    pub ctx_window: Option<u64>,
    #[serde(default)]
    pub ctx_ms: Option<u64>,
    /// Id de la conversación del propio CLI (Claude Code, Codex), que mandan sus hooks:
    /// lienzo lo usa para retomar esa conversación al reabrir el agente.
    #[serde(default)]
    pub cli_session: Option<String>,
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
    /// Tarea a la que pertenece el evento (p.ej. un relevo guardado).
    #[serde(default)]
    pub task_id: Option<u64>,
}

/// Memoria de relevo que un agente guarda pegado a su tarea antes de compactar
/// o pasar el testigo.
#[derive(Clone, Serialize, Deserialize)]
pub struct TaskHandover {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub by: String,
    #[serde(default)]
    pub ts_ms: u64,
    #[serde(default)]
    pub files: Vec<String>,
}

/// Nota en el tablón de una tarea: cómo se pasan datos entre agentes sin ensuciar el feed.
#[derive(Clone, Serialize, Deserialize)]
pub struct TaskComment {
    #[serde(default)]
    pub by: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub ts_ms: u64,
}

/// Entrada de la memoria del proyecto: la cura el líder (o tú); los demás proponen.
#[derive(Clone, Serialize, Deserialize)]
pub struct MemoryEntry {
    pub id: u64,
    #[serde(default)]
    pub text: String,
    /// decision | hecho | convencion | aviso
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub by: String,
    #[serde(default)]
    pub ts_ms: u64,
    /// active (guardada) | proposed (pendiente de que el líder la acepte)
    #[serde(default)]
    pub status: String,
}

/// Entrega estructurada de una tarea: lo que su dueño deja al cerrarla para que
/// las tareas que dependen de ella (y tú) sepan qué se hizo, dónde y con qué prueba.
#[derive(Clone, Serialize, Deserialize)]
pub struct TaskResult {
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub files: Vec<String>,
    /// Cómo se comprobó (tests, comando, captura…).
    #[serde(default)]
    pub evidence: String,
    #[serde(default)]
    pub by: String,
    #[serde(default)]
    pub ts_ms: u64,
    /// Cambios de la entrega frente a la copia de cada archivo al reservarlo (modo director).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub diff: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: u64,
    pub title: String,
    #[serde(default)]
    pub status: String, // open | claimed | review | done
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub notes: String,
    pub created_ms: u64,
    /// Último relevo guardado por su dueño (qué hizo, decisiones, qué falta).
    #[serde(default)]
    pub handover: Option<TaskHandover>,
    /// Tareas que deben estar hechas antes de poder reclamar esta.
    #[serde(default)]
    pub parents: Vec<u64>,
    /// Entrega al cerrarla (resumen, archivos y evidencia).
    #[serde(default)]
    pub result: Option<TaskResult>,
    /// Tablón de la tarea: notas de los agentes y tuyas.
    #[serde(default)]
    pub comments: Vec<TaskComment>,
    /// Dificultad que le puso quien la creó: simple | media | dificil (vacío = sin indicar).
    #[serde(default)]
    pub level: String,
    /// Agente al que va dirigida (vacío = a quien esté libre).
    #[serde(default)]
    pub assign: String,
    /// Rondas de corrección que lleva en modo director.
    #[serde(default)]
    pub fix_rounds: u32,
    /// Tokens gastados en esta tarea por cada agente (quien la hace y quien la revisa).
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub cost: HashMap<String, Usage>,
    /// Investigación a la que pertenece (`.lienzo/investigaciones/<id>`). Sus entregas no pasan
    /// por la revisión del director: la investigación profunda ya tiene su propio verificador.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub research: String,
    /// Carpeta aislada donde se trabaja (opción «carpetas aisladas»), vacía si se trabaja en el
    /// proyecto. Lo hecho allí se une al proyecto al entregar (o al aprobarse en modo director).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub workspace: String,
    /// Programación que la creó (P<n>), 0 si no viene de ninguna.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub schedule: u64,
    /// Modelo con el que debe ejecutarse (de su programación), vacío = el del agente.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub model: String,
}

fn is_zero(n: &u64) -> bool {
    *n == 0
}

impl Task {
    pub fn new(id: u64, title: String, notes: String, parents: Vec<u64>) -> Task {
        Task {
            id,
            title,
            status: "open".into(),
            owner: String::new(),
            notes,
            created_ms: now_ms(),
            handover: None,
            parents,
            result: None,
            comments: vec![],
            level: String::new(),
            assign: String::new(),
            fix_rounds: 0,
            cost: HashMap::new(),
            research: String::new(),
            workspace: String::new(),
            schedule: 0,
            model: String::new(),
        }
    }
}

/// Padres de `task` que aún no están hechos (un padre que ya no existe cuenta como cumplido).
pub fn unmet_parents(tasks: &[Task], task: &Task) -> Vec<u64> {
    task.parents
        .iter()
        .copied()
        .filter(|p| tasks.iter().any(|t| t.id == *p && t.status != "done"))
        .collect()
}

pub const MAX_MEMORY: usize = 40;
pub const MAX_PROPOSALS: usize = 20;
const MEMORY_KINDS: [&str; 4] = ["decision", "hecho", "convencion", "aviso"];

/// Aplana espacios y recorta a `max` caracteres.
fn clean_text(text: &str, max: usize) -> String {
    redact::redact(text).split_whitespace().collect::<Vec<_>>().join(" ").chars().take(max).collect()
}

pub fn memory_kind(kind: &str) -> String {
    let low = kind.trim().to_lowercase();
    if MEMORY_KINDS.contains(&low.as_str()) {
        low
    } else {
        "hecho".to_string()
    }
}

/// ¿Puede guardar memoria directamente? Tú y el líder; sin líder elegido, cualquiera
/// (para no dejar el equipo sin memoria). El resto propone.
pub fn can_curate(inner: &HubInner, agent: &str) -> bool {
    agent == "tú" || inner.leader.as_deref().map(|l| l == agent).unwrap_or(true)
}

/// Añade una entrada (guardada o propuesta). El llamador persiste y avisa a la UI.
pub fn memory_add(
    inner: &mut HubInner,
    by: &str,
    text: &str,
    kind: &str,
    active: bool,
) -> Result<MemoryEntry, String> {
    let text = clean_text(text, 400);
    if text.is_empty() {
        return Err("la memoria necesita un texto".into());
    }
    let low = text.to_lowercase();
    if inner.memory.iter().any(|m| m.text.to_lowercase() == low) {
        return Err("eso ya está en la memoria o en las propuestas".into());
    }
    let (act, prop) = inner
        .memory
        .iter()
        .fold((0, 0), |(a, p), m| if m.status == "active" { (a + 1, p) } else { (a, p + 1) });
    if active && act >= MAX_MEMORY {
        return Err(format!("la memoria está llena ({MAX_MEMORY}): olvida algo antes de guardar más"));
    }
    if !active && prop >= MAX_PROPOSALS {
        return Err("hay demasiadas propuestas pendientes: que el líder las revise primero".into());
    }
    inner.memory_seq += 1;
    let entry = MemoryEntry {
        id: inner.memory_seq,
        text: text.clone(),
        kind: memory_kind(kind),
        by: by.to_string(),
        ts_ms: now_ms(),
        status: if active { "active" } else { "proposed" }.to_string(),
    };
    inner.memory.push(entry.clone());
    let what = if active { "guardó en la memoria" } else { "propone para la memoria" };
    push_event(inner, by, "", "memory", &format!("{what}: {}", clean_text(&text, 140)), vec![], None);
    Ok(entry)
}

/// Resuelve una propuesta: aceptarla (opcionalmente reescrita) o descartarla.
pub fn memory_resolve(
    inner: &mut HubInner,
    id: u64,
    accept: bool,
    new_text: Option<&str>,
    by: &str,
) -> Result<(), String> {
    let Some(pos) = inner.memory.iter().position(|m| m.id == id && m.status == "proposed") else {
        return Err(format!("no hay una propuesta #{id} pendiente"));
    };
    if !accept {
        let gone = inner.memory.remove(pos);
        push_event(inner, by, "", "memory", &format!("descartó la propuesta de {}: {}", gone.by, clean_text(&gone.text, 100)), vec![], None);
        return Ok(());
    }
    let active = inner.memory.iter().filter(|m| m.status == "active").count();
    if active >= MAX_MEMORY {
        return Err(format!("la memoria está llena ({MAX_MEMORY}): olvida algo antes de aceptar más"));
    }
    if let Some(t) = new_text.map(|t| clean_text(t, 400)).filter(|t| !t.is_empty()) {
        inner.memory[pos].text = t;
    }
    inner.memory[pos].status = "active".to_string();
    inner.memory[pos].ts_ms = now_ms();
    let text = clean_text(&inner.memory[pos].text, 140);
    push_event(inner, by, "", "memory", &format!("aceptó en la memoria: {text}"), vec![], None);
    Ok(())
}

pub fn memory_forget(inner: &mut HubInner, id: u64, by: &str) -> Result<(), String> {
    let Some(pos) = inner.memory.iter().position(|m| m.id == id) else {
        return Err(format!("no existe la entrada #{id}"));
    };
    let gone = inner.memory.remove(pos);
    push_event(inner, by, "", "memory", &format!("olvidó: {}", clean_text(&gone.text, 100)), vec![], None);
    Ok(())
}

/// Borra una tarea. Las que dependían de ella dejan de esperarla (si no, quedarían bloqueadas para
/// siempre) y se avisa en el feed.
pub fn delete_task(inner: &mut HubInner, id: u64) -> Result<(), String> {
    let Some(pos) = inner.tasks.iter().position(|t| t.id == id) else {
        return Err("tarea no encontrada".into());
    };
    let gone = inner.tasks.remove(pos);
    for t in inner.tasks.iter_mut() {
        t.parents.retain(|p| *p != id);
    }
    // Su carpeta aislada ya no sirve: fuera (sin frenar al hub con git).
    if !gone.workspace.is_empty() {
        if let Some(project) = inner.project.clone() {
            std::thread::spawn(move || {
                let _ = crate::workspace::discard(&project, id);
            });
        }
    }
    push_event(
        inner,
        "tú",
        "ui",
        "task",
        &format!("#{} borrada: {}", id, clean_text(&gone.title, 100)),
        vec![],
        None,
    );
    Ok(())
}

/// Añade una nota al tablón de una tarea.
pub fn add_task_comment(
    inner: &mut HubInner,
    id: u64,
    by: &str,
    session_id: &str,
    text: &str,
) -> Result<TaskComment, String> {
    let text = clean_text(text, 800);
    if text.is_empty() {
        return Err("la nota está vacía".into());
    }
    let Some(task) = inner.tasks.iter_mut().find(|t| t.id == id) else {
        return Err("tarea no encontrada".into());
    };
    let comment = TaskComment { by: by.to_string(), text: text.clone(), ts_ms: now_ms() };
    task.comments.push(comment.clone());
    if task.comments.len() > 60 {
        task.comments.remove(0);
    }
    push_event_full(
        inner,
        by,
        session_id,
        "task",
        &format!("nota en #{id}: {}", clean_text(&text, 140)),
        vec![],
        None,
        Some(id),
    );
    Ok(comment)
}

/// Valida los padres de una tarea nueva: deben existir y no repetirse.
pub fn check_parents(tasks: &[Task], parents: &[u64]) -> Result<Vec<u64>, String> {
    let mut out: Vec<u64> = vec![];
    for p in parents {
        if !tasks.iter().any(|t| t.id == *p) {
            return Err(format!("la tarea padre #{p} no existe"));
        }
        if !out.contains(p) {
            out.push(*p);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Un proyecto por carpeta: cada uno con sus tareas, memoria, normas, reservas y actividad
// ---------------------------------------------------------------------------

/// Lo que es de un proyecto y se aparta al cambiar de carpeta (y vuelve al volver).
#[derive(Serialize, Deserialize, Default, Clone)]
pub struct ProjectSlot {
    /// La carpeta tal cual (la clave va en minúsculas).
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub events: Vec<Event>,
    #[serde(default)]
    pub tasks: Vec<Task>,
    #[serde(default)]
    pub claims: Vec<Claim>,
    #[serde(default)]
    pub charter: Option<String>,
    #[serde(default)]
    pub memory: Vec<MemoryEntry>,
    #[serde(default)]
    pub memory_seq: u64,
    #[serde(default)]
    pub questions: Vec<Question>,
    /// Cuándo se usó por última vez (para listar los proyectos recientes).
    #[serde(default)]
    pub last_ms: u64,
}

/// Clave de una carpeta: sin mayúsculas, con «/» y sin barra final (C:\A\b\ = c:/a/b).
pub fn project_key(path: &str) -> String {
    path.trim().replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// Clave de una reserva: la misma para un archivo se escriba como se escriba
/// (`C:\A\b.md`, `c:/a//b.md`, `C:\A\.\b.md` → `c:/a/b.md`).
pub fn claim_key(path: &str) -> String {
    let p = project_key(path);
    let mut parts: Vec<&str> = Vec::new();
    for (i, seg) in p.split('/').enumerate() {
        // Un «//» al principio es una ruta de red: se conserva.
        if seg.is_empty() && i > 0 && !(i == 1 && p.starts_with("//")) {
            continue;
        }
        if seg == "." {
            continue;
        }
        if seg == ".." && parts.len() > 1 {
            parts.pop();
            continue;
        }
        parts.push(seg);
    }
    parts.join("/")
}

/// Cambia la carpeta del equipo. Lo del proyecto actual se guarda en su estante y se trae lo del
/// nuevo (vacío si es la primera vez). Devuelve si cambió de proyecto.
pub fn switch_project(inner: &mut HubInner, path: Option<String>) -> bool {
    let path = path.map(|p| p.trim().trim_end_matches(['\\', '/']).to_string()).filter(|p| !p.is_empty());
    let cur = inner.project.as_deref().map(project_key).unwrap_or_default();
    let next = path.as_deref().map(project_key).unwrap_or_default();
    if cur == next {
        inner.project = path;
        return false;
    }
    let slot = ProjectSlot {
        path: inner.project.clone().unwrap_or_default(),
        events: inner.events.drain(..).collect(),
        tasks: std::mem::take(&mut inner.tasks),
        claims: inner.claims.drain().map(|(_, c)| c).collect(),
        charter: inner.charter.take(),
        memory: std::mem::take(&mut inner.memory),
        memory_seq: inner.memory_seq,
        questions: std::mem::take(&mut inner.questions),
        last_ms: now_ms(),
    };
    inner.projects.insert(cur, slot);
    let s = inner.projects.remove(&next).unwrap_or_default();
    inner.events = s.events.into_iter().collect();
    inner.tasks = s.tasks;
    inner.claims = s.claims.into_iter().map(|c| (claim_key(&c.path), c)).collect();
    inner.charter = s.charter;
    inner.memory = s.memory;
    inner.memory_seq = s.memory_seq;
    inner.questions = s.questions;
    // Un plan a medias se queda en su proyecto: sus tareas siguen en «plan» hasta que lo apruebes.
    inner.plan_hold = false;
    // Lo de las entregas en curso era del otro proyecto.
    inner.bases.clear();
    inner.focus.clear();
    inner.project = path;
    true
}

/// La carpeta de un proyecto cambió de nombre en el disco: lo suyo (el abierto o su estante)
/// pasa a la ruta nueva. Devuelve si había algo que mover.
pub fn rename_project(inner: &mut HubInner, old: &str, new: &str) -> bool {
    let new = new.trim().trim_end_matches(['\\', '/']).to_string();
    let (ko, kn) = (project_key(old), project_key(&new));
    if inner.project.as_deref().map(project_key).as_deref() == Some(ko.as_str()) {
        inner.project = Some(new);
        // Si quedaba un estante viejo con el nombre nuevo, ya no corresponde a nada.
        if ko != kn {
            inner.projects.remove(&kn);
        }
        return true;
    }
    match inner.projects.remove(&ko) {
        Some(mut slot) => {
            slot.path = new;
            inner.projects.insert(kn, slot);
            true
        }
        None => false,
    }
}

/// Los otros proyectos (con carpeta), del usado más recientemente al más antiguo.
pub fn project_list(inner: &HubInner) -> Vec<serde_json::Value> {
    let mut list: Vec<&ProjectSlot> = inner.projects.values().filter(|s| !s.path.is_empty()).collect();
    list.sort_by(|a, b| b.last_ms.cmp(&a.last_ms));
    list.iter()
        .map(|s| {
            serde_json::json!({
                "path": s.path,
                "last_ms": s.last_ms,
                "open_tasks": s.tasks.iter().filter(|t| t.status != "done").count(),
            })
        })
        .collect()
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
    #[serde(default)]
    pub memory: Vec<MemoryEntry>,
    #[serde(default)]
    pub memory_seq: u64,
    #[serde(default)]
    pub usage: HashMap<String, Usage>,
    #[serde(default)]
    pub usage_since: u64,
    #[serde(default)]
    pub director: bool,
    #[serde(default)]
    pub fix_limit: u32,
    #[serde(default)]
    pub plan_hold: bool,
    #[serde(default)]
    pub isolate: bool,
    #[serde(default)]
    pub strengths: HashMap<String, String>,
    #[serde(default)]
    pub questions: Vec<Question>,
    #[serde(default)]
    pub question_seq: u64,
    #[serde(default)]
    pub schedules: Vec<schedule::Schedule>,
    #[serde(default)]
    pub schedule_seq: u64,
    /// Lo de los otros proyectos (carpetas), guardado mientras trabajas en este.
    #[serde(default)]
    pub projects: HashMap<String, ProjectSlot>,
    /// Último límite de uso visto de cada agente (ver `set_limits`).
    #[serde(default)]
    pub limits: HashMap<String, serde_json::Value>,
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
    pub memory: Vec<MemoryEntry>,
    pub memory_seq: u64,
    /// Broadcast delivery marks: `session:<id>` (hooks) or `agent:<name>` (terminals).
    pub broadcast_marks: HashMap<String, u64>,
    /// Último mensaje leído del buzón de cada agente (por nombre).
    pub inbox_marks: HashMap<String, u64>,
    /// Los mensajes anteriores al arranque del hub cuentan como leídos.
    pub inbox_floor: u64,
    pub usage: HashMap<String, Usage>,
    pub usage_since: u64,
    /// Mensajes de la telemetría ya sumados (para no contar dos veces un mismo turno).
    pub usage_seen: VecDeque<String>,
    /// Modo director: las entregas de los demás pasan por la revisión del líder.
    pub director: bool,
    /// Rondas de corrección antes de que el líder tenga que asumir la tarea (0 = las de por defecto).
    pub fix_limit: u32,
    /// Modo plan: pediste un plan y aún no lo apruebas. Las tareas que se creen mientras tanto
    /// quedan en «plan» (nadie las toma ni se despachan) hasta tu OK.
    pub plan_hold: bool,
    /// Carpetas aisladas: cada tarea tomada trabaja en su copia del proyecto (ver `workspace.rs`).
    pub isolate: bool,
    /// Copia de cada archivo al reservarlo (clave de `review::rel_key`), para el diff de la entrega.
    pub bases: HashMap<String, review::FileBase>,
    /// Tarea en la que trabaja cada agente (en minúsculas): a ella va el gasto de sus turnos.
    pub focus: HashMap<String, u64>,
    /// Qué se le da bien a cada agente (lo escribes tú): el líder lo usa para repartir.
    pub strengths: HashMap<String, String>,
    /// Preguntas de los agentes al usuario (team_ask_user).
    pub questions: Vec<Question>,
    pub question_seq: u64,
    /// Tareas programadas (ver `schedule.rs`).
    pub schedules: Vec<schedule::Schedule>,
    pub schedule_seq: u64,
    /// Lo de los otros proyectos, por carpeta (ver `switch_project`).
    pub projects: HashMap<String, ProjectSlot>,
    /// Límites de uso de cada agente: sesión, semana… (ver `set_limits`).
    pub limits: HashMap<String, serde_json::Value>,
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

pub fn data_dir() -> std::path::PathBuf {
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
    let (state, warning) = load_state_from(&state_file());
    if let Some((message, detail)) = warning {
        crate::errlog::log("hub", &message, &detail);
    }
    state
}

/// Copia de la última versión buena del estado, al lado del principal (`team-state.json.bak`).
fn backup_path(main: &std::path::Path) -> std::path::PathBuf {
    let mut name = main.file_name().unwrap_or_default().to_os_string();
    name.push(".bak");
    main.with_file_name(name)
}

/// Lee un archivo de estado: `Ok(None)` si no existe, `Err` si existe pero no sirve.
fn read_state(path: &std::path::Path) -> Result<Option<PersistedState>, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).map(Some).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Aparta un archivo de estado roto (`team-state.corrupt-<ts>.json`) para que nadie lo pise.
fn set_aside(path: &std::path::Path, ts: u64) -> String {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let (base, ext) = match name.strip_suffix(".json.bak") {
        Some(b) => (b.to_string(), "bak.json"),
        None => (name.trim_end_matches(".json").to_string(), "json"),
    };
    let dest = path.with_file_name(format!("{base}.corrupt-{ts}.{ext}"));
    match std::fs::rename(path, &dest) {
        Ok(()) => format!("apartado en {}", dest.display()),
        Err(e) => format!("no se pudo apartar ({e})"),
    }
}

/// Carga el estado de `main`, con `.bak` de respaldo. Un archivo roto nunca se deja donde la
/// siguiente escritura lo pisaría: se aparta. Devuelve además el aviso para el registro de
/// errores (mensaje, detalle) si hubo que recuperar o apartar algo.
fn load_state_from(main: &std::path::Path) -> (PersistedState, Option<(String, String)>) {
    let bak = backup_path(main);
    let main_err = match read_state(main) {
        Ok(Some(state)) => return (state, None),
        Ok(None) => None,
        Err(e) => Some(e),
    };
    let ts = now_ms();
    let bak_err = match read_state(&bak) {
        Ok(Some(state)) => {
            let detail = match main_err {
                Some(e) => format!("{}: {e}; {}", main.display(), set_aside(main, ts)),
                None => format!("{} no existe", main.display()),
            };
            let msg = "El estado del equipo estaba dañado; se recuperó de la copia .bak";
            return (state, Some((msg.into(), detail)));
        }
        Ok(None) => None,
        Err(e) => Some(e),
    };
    let mut detail = Vec::new();
    if let Some(e) = main_err {
        detail.push(format!("{}: {e}; {}", main.display(), set_aside(main, ts)));
    }
    if let Some(e) = bak_err {
        detail.push(format!("{}: {e}; {}", bak.display(), set_aside(&bak, ts)));
    }
    if detail.is_empty() {
        return (PersistedState::default(), None); // primera vez: no hay nada que cargar
    }
    let msg = "El estado del equipo no se pudo leer; se empieza de cero y el archivo roto se ha apartado";
    (PersistedState::default(), Some((msg.into(), detail.join("\n"))))
}

/// Escribe el estado sin dejarlo nunca a medias: primero a un temporal en la misma carpeta,
/// luego copia el actual a `.bak` y renombra el temporal encima. En Windows `rename` ya
/// reemplaza un destino existente, pero puede fallar un momento si otro proceso (antivirus,
/// indexador) lo tiene abierto, así que se reintenta.
fn write_state_to(main: &std::path::Path, raw: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut name = main.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".tmp{}", std::process::id()));
    let tmp = main.with_file_name(name);
    let written = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(raw.as_bytes())?;
        f.sync_all()
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if main.exists() {
        let _ = std::fs::copy(main, backup_path(main));
    }
    let mut result = std::fs::rename(&tmp, main);
    for _ in 0..5 {
        if result.is_ok() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
        result = std::fs::rename(&tmp, main);
    }
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
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
        memory: inner.memory.clone(),
        memory_seq: inner.memory_seq,
        usage: inner.usage.clone(),
        usage_since: inner.usage_since,
        director: inner.director,
        fix_limit: inner.fix_limit,
        plan_hold: inner.plan_hold,
        isolate: inner.isolate,
        strengths: inner.strengths.clone(),
        questions: inner.questions.clone(),
        question_seq: inner.question_seq,
        schedules: inner.schedules.clone(),
        schedule_seq: inner.schedule_seq,
        projects: inner.projects.clone(),
        limits: inner.limits.clone(),
    };
    if let Ok(raw) = serde_json::to_string(&state) {
        if let Err(e) = write_state_to(&state_file(), &raw) {
            crate::errlog::log("hub", "No se pudo guardar el estado del equipo", &e.to_string());
        }
    }
}

/// Notify the UI that team state changed.
pub fn notify_ui() {
    if let Some(app) = APP.get() {
        let _ = app.emit("team://update", ());
    }
}

/// Guarda el límite de uso de un agente: ventanas `{key, label, used_pct, resets_at}`.
/// `exact` = lo dijo el propio CLI (Claude); si no, es una estimación o una lectura de pantalla.
/// Devuelve si cambió algo que se vea (para no avisar a la interfaz a cada línea de estado).
pub fn set_limits(inner: &mut HubInner, agent: &str, windows: &serde_json::Value, exact: bool, note: &str) -> bool {
    let agent = agent.trim().to_lowercase();
    if agent.is_empty() || agent.len() > 40 {
        return false;
    }
    let clean: Vec<serde_json::Value> = windows
        .as_array()
        .map(|a| {
            a.iter()
                .take(6)
                .filter_map(|w| {
                    let pct = w["used_pct"].as_f64()?.clamp(0.0, 100.0);
                    Some(serde_json::json!({
                        "key": clean_text(w["key"].as_str().unwrap_or(""), 24),
                        "label": clean_text(w["label"].as_str().unwrap_or(""), 40),
                        "used_pct": (pct * 10.0).round() / 10.0,
                        "resets_at": w["resets_at"].as_u64(),
                    }))
                })
                .collect()
        })
        .unwrap_or_default();
    if clean.is_empty() {
        return false;
    }
    let changed = inner.limits.get(&agent).map(|old| old["windows"] != serde_json::json!(clean)).unwrap_or(true);
    inner.limits.insert(
        agent,
        serde_json::json!({ "windows": clean, "exact": exact, "note": clean_text(note, 200), "ts_ms": now_ms() }),
    );
    changed
}

/// Límites que la interfaz calcula o lee (OpenCode Go estimado, Antigravity por su /usage).
#[tauri::command]
pub fn team_limits_set(
    hub: tauri::State<'_, Hub>,
    agent: String,
    windows: serde_json::Value,
    exact: bool,
    note: Option<String>,
) -> Result<(), String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    // Sin ventanas se borra su lectura (p. ej. una mal leída).
    let empty = windows.as_array().is_none_or(|a| a.is_empty());
    let changed = if empty {
        inner.limits.remove(&agent.trim().to_lowercase()).is_some()
    } else {
        set_limits(&mut inner, &agent, &windows, exact, note.as_deref().unwrap_or(""))
    };
    if changed {
        persist(&inner);
        drop(inner);
        notify_ui();
    }
    Ok(())
}

/// Avisa a la interfaz de cualquier evento propio (p. ej. un error nuevo en el registro).
pub fn emit_ui<S: serde::Serialize + Clone>(event: &str, payload: S) {
    if let Some(app) = APP.get() {
        let _ = app.emit(event, payload);
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
    push_event_full(inner, agent, session_id, kind, text, files, to, None)
}

#[allow(clippy::too_many_arguments)]
pub fn push_event_full(
    inner: &mut HubInner,
    agent: &str,
    session_id: &str,
    kind: &str,
    text: &str,
    files: Vec<String>,
    to: Option<String>,
    task_id: Option<u64>,
) -> Event {
    inner.seq += 1;
    let event = Event {
        seq: inner.seq,
        ts_ms: now_ms(),
        agent: agent.to_string(),
        session_id: session_id.to_string(),
        kind: kind.to_string(),
        // Todo lo que pasa por el feed se guarda en disco y lo leen los demás: sin secretos.
        text: redact::redact(text),
        files,
        to,
        task_id,
    };
    inner.events.push_back(event.clone());
    let mut old = Vec::new();
    while inner.events.len() > MAX_EVENTS {
        if let Some(e) = inner.events.pop_front() {
            old.push(e);
        }
    }
    // Lo que sale del feed no se pierde: va al archivo del proyecto, donde lo encuentra team_feed_search.
    if !cfg!(test) {
        archive_events(inner.project.as_deref(), &old);
    }
    event
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

pub fn init(app: AppHandle) -> Result<(), String> {
    let _ = APP.set(app.clone());

    let persisted = load_persisted();
    let token = random_token();
    // Historial del proyecto abierto: listo antes de que el equipo entregue nada.
    if let Some(p) = persisted.project.clone().filter(|p| !p.trim().is_empty()) {
        std::thread::spawn(move || {
            if let Err(e) = crate::history::ensure(&p) {
                crate::errlog::log("historial", "No se pudo preparar el historial del proyecto", &e);
            }
        });
    }

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
            .map(|c| (claim_key(&c.path), c))
            .collect(),
        project: persisted.project,
        charter: persisted.charter,
        leader: persisted.leader,
        broadcasts: VecDeque::new(),
        broadcast_marks: HashMap::new(),
        inbox_marks: HashMap::new(),
        inbox_floor: persisted.seq,
        usage: persisted.usage,
        usage_since: if persisted.usage_since > 0 { persisted.usage_since } else { now_ms() },
        usage_seen: VecDeque::new(),
        director: persisted.director,
        fix_limit: persisted.fix_limit,
        plan_hold: persisted.plan_hold,
        isolate: persisted.isolate,
        bases: HashMap::new(),
        focus: HashMap::new(),
        strengths: persisted.strengths,
        questions: persisted.questions,
        question_seq: persisted.question_seq,
        schedules: persisted.schedules,
        schedule_seq: persisted.schedule_seq,
        projects: persisted.projects,
        limits: persisted.limits,
        seq: persisted.seq,
        task_seq: persisted.task_seq,
        memory: persisted.memory,
        memory_seq: persisted.memory_seq,
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

    // Lo que hacen OpenCode y Antigravity (sin hooks), leído de sus conversaciones en disco.
    mirror::start(app.clone());

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
