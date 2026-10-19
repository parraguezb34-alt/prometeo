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
pub mod review;
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
    text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(max).collect()
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
// Modo director: el líder reparte, revisa las entregas y manda corregir
// ---------------------------------------------------------------------------

pub const DEFAULT_FIX_LIMIT: u32 = 2;

pub fn fix_limit(inner: &HubInner) -> u32 {
    if inner.fix_limit == 0 { DEFAULT_FIX_LIMIT } else { inner.fix_limit }
}

/// Normaliza la dificultad de una tarea; lo que no se reconoce queda sin indicar.
pub fn task_level(level: &str) -> String {
    match level.trim().to_lowercase().as_str() {
        "simple" | "facil" | "fácil" | "baja" => "simple",
        "media" | "medio" | "normal" => "media",
        "dificil" | "difícil" | "alta" | "compleja" => "dificil",
        _ => "",
    }
    .to_string()
}

/// Nombre de un agente, aceptando el alias del líder.
pub fn resolve_agent(inner: &HubInner, name: &str) -> String {
    resolve_to(inner, name)
}

pub fn is_online(inner: &HubInner, name: &str) -> bool {
    let now = now_ms();
    inner
        .agents
        .values()
        .any(|a| a.name.eq_ignore_ascii_case(name) && now.saturating_sub(a.last_seen_ms) < AGENT_TTL_MS)
}

/// Líder que debe revisar la entrega de `agent`, si la hay: en modo director y cuando no
/// entrega él mismo (ni tú). Si el líder está desconectado, la entrega le espera: al volver
/// recibe un aviso con todo lo pendiente (y tú puedes aprobarla desde la app).
pub fn reviewer_for(inner: &HubInner, agent: &str) -> Option<String> {
    if !inner.director || agent == "tú" {
        return None;
    }
    let leader = inner.leader.clone()?;
    (!leader.eq_ignore_ascii_case(agent)).then_some(leader)
}

/// El líder acaba de conectarse: si hay entregas esperando su revisión, se lo recuerda en un
/// solo mensaje (los avisos de antes de reiniciar el hub cuentan como leídos).
pub fn remind_reviews(inner: &mut HubInner, agent: &str) {
    if !inner.director || !inner.leader.as_deref().is_some_and(|l| l.eq_ignore_ascii_case(agent)) {
        return;
    }
    let pending: Vec<String> = inner
        .tasks
        .iter()
        .filter(|t| t.status == "review")
        .map(|t| format!("#{} «{}»", t.id, clean_text(&t.title, 60)))
        .collect();
    if pending.is_empty() || inbox_unread(inner, agent).iter().any(|e| e.agent == "lienzo") {
        return;
    }
    let text = format!(
        "🔎 Tienes {} entrega(s) esperando tu revisión: {}. Míralas con team_task_list y decide con team_task_review.",
        pending.len(),
        pending.join(", ")
    );
    push_event(inner, "lienzo", "hub", "message", &text, vec![], Some(agent.to_string()));
}

fn project_root(inner: &HubInner) -> Option<std::path::PathBuf> {
    inner.project.as_deref().map(std::path::PathBuf::from).filter(|p| p.is_dir())
}

/// En modo director, guarda cómo estaban los archivos al reservarlos. Solo la primera vez:
/// el diff que verá el líder es el de toda la tarea, también tras una ronda de corrección.
pub fn snapshot_bases(inner: &mut HubInner, files: &[String]) {
    if !inner.director {
        return;
    }
    let Some(root) = project_root(inner) else { return };
    for f in files {
        let key = review::rel_key(&root, f);
        if inner.bases.contains_key(&key) || inner.bases.len() >= 400 {
            continue;
        }
        let base = review::read_base(&root, f);
        inner.bases.insert(key, base);
    }
}

/// Cambios de una entrega para el aviso al líder (recortados para no inflar su contexto).
pub fn delivery_diff(inner: &HubInner, files: &[String]) -> String {
    match project_root(inner) {
        Some(root) if !files.is_empty() => review::delivery_diff(&root, files, &inner.bases, 6000),
        _ => String::new(),
    }
}

/// La tarea quedó cerrada: sus copias ya no hacen falta.
pub fn drop_bases(inner: &mut HubInner, files: &[String]) {
    let Some(root) = project_root(inner) else { return };
    for f in files {
        inner.bases.remove(&review::rel_key(&root, f));
    }
}

/// Pide al líder que revise una entrega: le llega como mensaje directo, así que lo despierta.
pub fn ask_review(inner: &mut HubInner, id: u64, leader: &str) {
    let Some(task) = inner.tasks.iter().find(|t| t.id == id) else { return };
    let Some(r) = task.result.clone() else { return };
    let round = if task.fix_rounds > 0 { format!(" (tras la ronda {} de correcciones)", task.fix_rounds) } else { String::new() };
    let files = if r.files.is_empty() { "—".to_string() } else { r.files.join(", ") };
    let evidence = if r.evidence.is_empty() { "sin evidencia".to_string() } else { clean_text(&r.evidence, 300) };
    let diff_note = if r.diff.is_empty() { "" } else { " Los cambios van debajo: no abras los archivos salvo que te falte algo." };
    let text = format!(
        "🔎 Revisa la entrega de #{id} «{}» de {}{round}: {} · Archivos: {files} · Evidencia: {evidence}. \
         Decide con team_task_review: verdict ok, fix (con órdenes concretas) o take (la haces tú).{diff_note}",
        clean_text(&task.title, 120),
        r.by,
        clean_text(&r.summary, 500),
    );
    push_event_full(inner, "lienzo", "hub", "message", &text, r.files, Some(leader.to_string()), Some(id));
}

/// El líder (o tú) completa el encargo de una tarea; un borrador pasa a estar listo para repartir.
pub fn brief_task(
    inner: &mut HubInner,
    id: u64,
    by: &str,
    session_id: &str,
    notes: &str,
    level: &str,
    assign: &str,
) -> Result<String, String> {
    let is_leader = inner.leader.as_deref().is_some_and(|l| l.eq_ignore_ascii_case(by));
    if by != "tú" && !is_leader {
        return Err("solo el líder (o tú) escribe los encargos".into());
    }
    let assign = resolve_to(inner, assign);
    let level = task_level(level);
    let Some(task) = inner.tasks.iter_mut().find(|t| t.id == id) else {
        return Err("tarea no encontrada".into());
    };
    if !matches!(task.status.as_str(), "draft" | "open") {
        return Err(format!("la tarea #{id} ya está {}: no se cambia su encargo", task.status));
    }
    let notes: String = notes.trim().chars().take(4000).collect();
    if notes.is_empty() && task.notes.trim().is_empty() {
        return Err("falta el encargo en `notes`".into());
    }
    if !notes.is_empty() {
        task.notes = notes;
    }
    if !level.is_empty() {
        task.level = level;
    }
    if !assign.is_empty() {
        task.assign = assign;
    }
    task.status = "open".into();
    let title = clean_text(&task.title, 100);
    push_event_full(inner, by, session_id, "task", &format!("#{id} con encargo: {title}"), vec![], None, Some(id));
    Ok(format!("#{id} lista para repartir."))
}

/// Decisión sobre una entrega en revisión. `ok` la cierra, `fix` la devuelve a su dueño con
/// órdenes (como mucho `fix_limit` rondas) y `take` la pasa a quien revisa.
pub fn review_task(
    inner: &mut HubInner,
    id: u64,
    by: &str,
    session_id: &str,
    verdict: &str,
    notes: &str,
) -> Result<String, String> {
    let is_leader = inner.leader.as_deref().is_some_and(|l| l.eq_ignore_ascii_case(by));
    if by != "tú" && !is_leader {
        return Err("solo el líder (o tú) decide sobre las entregas".into());
    }
    let limit = fix_limit(inner);
    let notes = notes.trim().chars().take(2000).collect::<String>();
    let Some(task) = inner.tasks.iter_mut().find(|t| t.id == id) else {
        return Err("tarea no encontrada".into());
    };
    if task.status != "review" {
        return Err(format!("la tarea #{id} no está en revisión (estado: {})", task.status));
    }
    let owner = task.owner.clone();
    let title = clean_text(&task.title, 100);
    let now = now_ms();
    match verdict.trim().to_lowercase().as_str() {
        "ok" | "aprobar" | "aprobada" => {
            task.status = "done".into();
            if !notes.is_empty() {
                task.comments.push(TaskComment { by: by.into(), text: format!("✅ {notes}"), ts_ms: now });
            }
            let files = task.result.as_ref().map(|r| r.files.clone()).unwrap_or_default();
            drop_bases(inner, &files);
            push_event_full(inner, by, session_id, "task", &format!("#{id} aprobada por {by}"), vec![], None, Some(id));
            Ok(format!("#{id} aprobada y cerrada."))
        }
        "fix" | "corregir" => {
            if notes.is_empty() {
                return Err("di qué corregir en `notes`: órdenes concretas (archivo, qué cambiar, cómo comprobarlo)".into());
            }
            if task.fix_rounds >= limit {
                return Err(format!(
                    "#{id} ya lleva {} rondas de corrección: asúmela (verdict take) o apruébala (ok)",
                    task.fix_rounds
                ));
            }
            task.fix_rounds += 1;
            let round = task.fix_rounds;
            task.status = "claimed".into();
            task.comments.push(TaskComment { by: by.into(), text: format!("🔧 Ronda {round}/{limit}: {notes}"), ts_ms: now });
            let last = if round >= limit { " Es la última ronda: si no queda bien, la asumirá el líder." } else { "" };
            let text = format!(
                "🔧 Corrige #{id} «{title}» (ronda {round} de {limit}): {notes}{last} \
                 Al terminar, ciérrala otra vez con team_task_done (summary, files, evidence)."
            );
            push_event_full(inner, by, session_id, "message", &text, vec![], Some(owner.clone()), Some(id));
            Ok(format!("#{id} devuelta a {owner} para corregir (ronda {round} de {limit})."))
        }
        "take" | "asumir" => {
            task.status = "claimed".into();
            task.owner = by.into();
            let why = if notes.is_empty() { String::new() } else { format!(": {notes}") };
            task.comments.push(TaskComment { by: by.into(), text: format!("🧭 La asume {by}{why}"), ts_ms: now });
            push_event_full(
                inner,
                by,
                session_id,
                "task",
                &format!("#{id} la asume {by} (era de {owner})"),
                vec![],
                None,
                Some(id),
            );
            Ok(format!("#{id} es tuya ahora: termínala y ciérrala con team_task_done."))
        }
        other => Err(format!("veredicto «{other}» desconocido: usa ok, fix o take")),
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Claim {
    pub path: String,
    pub session_id: String,
    pub agent: String,
    pub ts_ms: u64,
}

/// Tokens que ha gastado un agente (sumados de su telemetría) y lo que lienzo le ahorró.
#[derive(Clone, Serialize, Deserialize, Default)]
pub struct Usage {
    #[serde(default)]
    pub input: u64,
    #[serde(default)]
    pub output: u64,
    /// Leídos de la caché del proveedor: cuestan una fracción de un token normal.
    #[serde(default)]
    pub cache_read: u64,
    #[serde(default)]
    pub cache_write: u64,
    #[serde(default)]
    pub turns: u64,
    /// Tokens (estimados) que no se inyectaron porque el contexto del equipo no había cambiado.
    #[serde(default)]
    pub saved_ctx: u64,
    /// Contexto liberado al compactar (relevos): lo que dejó de viajar en cada mensaje.
    #[serde(default)]
    pub freed: u64,
    #[serde(default)]
    pub compactions: u64,
}

// ---------------------------------------------------------------------------
// Preguntas de un agente al usuario (team_ask_user): un panel con opciones en el chat
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct QOption {
    pub label: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct QItem {
    pub question: String,
    /// Etiqueta corta («Estilo», «Alcance»).
    #[serde(default)]
    pub header: String,
    pub options: Vec<QOption>,
    /// Se puede marcar más de una opción.
    #[serde(default)]
    pub multi: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct QAnswer {
    pub question: String,
    #[serde(default)]
    pub choices: Vec<String>,
    /// Lo que escribiste en «Otra respuesta».
    #[serde(default)]
    pub other: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Question {
    pub id: u64,
    pub agent: String,
    pub ts_ms: u64,
    #[serde(default)]
    pub context: String,
    pub items: Vec<QItem>,
    #[serde(default)]
    pub answers: Option<Vec<QAnswer>>,
    #[serde(default)]
    pub answered_ms: u64,
    /// La herramienta del agente dejó de esperar: la respuesta se le escribe en su terminal.
    #[serde(default)]
    pub detached: bool,
    /// Preferiste no contestar.
    #[serde(default)]
    pub dismissed: bool,
}

pub const MAX_QUESTIONS: usize = 40;

const DISMISSED_NOTE: &str = "decide tú con criterio y explica qué elegiste en tu resumen.";

/// Valida y limpia lo que manda un agente: 1–4 preguntas con 2–6 opciones cada una.
pub fn clean_questions(raw: &serde_json::Value) -> Result<Vec<QItem>, String> {
    let list = raw.as_array().ok_or("`questions` debe ser una lista")?;
    if list.is_empty() || list.len() > 4 {
        return Err("haz entre 1 y 4 preguntas a la vez".into());
    }
    let mut out = Vec::new();
    for q in list {
        let question = clean_text(q["question"].as_str().unwrap_or(""), 300);
        if question.is_empty() {
            return Err("cada pregunta necesita su texto en `question`".into());
        }
        let options: Vec<QOption> = q["options"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|o| {
                        let (label, description) = match o.as_str() {
                            Some(s) => (s.to_string(), String::new()),
                            None => (
                                o["label"].as_str().unwrap_or("").to_string(),
                                o["description"].as_str().unwrap_or("").to_string(),
                            ),
                        };
                        let label = clean_text(&label, 80);
                        (!label.is_empty()).then(|| QOption { label, description: clean_text(&description, 200) })
                    })
                    .take(6)
                    .collect()
            })
            .unwrap_or_default();
        if options.len() < 2 {
            return Err(format!("«{question}»: da al menos 2 opciones concretas (el usuario siempre puede escribir otra)"));
        }
        out.push(QItem {
            question,
            header: clean_text(q["header"].as_str().unwrap_or(""), 24),
            options,
            multi: q["multiSelect"].as_bool().or(q["multi"].as_bool()).unwrap_or(false),
        });
    }
    Ok(out)
}

/// Un agente pregunta: queda pendiente en el chat hasta que contestes.
pub fn ask_user(inner: &mut HubInner, agent: &str, session_id: &str, context: &str, items: Vec<QItem>) -> u64 {
    inner.question_seq += 1;
    let id = inner.question_seq;
    let first = items.first().map(|q| q.question.clone()).unwrap_or_default();
    let more = if items.len() > 1 { format!(" (+{})", items.len() - 1) } else { String::new() };
    inner.questions.push(Question {
        id,
        agent: agent.to_string(),
        ts_ms: now_ms(),
        context: clean_text(context, 600),
        items,
        answers: None,
        answered_ms: 0,
        detached: false,
        dismissed: false,
    });
    while inner.questions.len() > MAX_QUESTIONS {
        // Fuera la más vieja ya resuelta; si todas siguen abiertas, la más vieja.
        let pos = inner.questions.iter().position(|q| q.answers.is_some() || q.dismissed).unwrap_or(0);
        inner.questions.remove(pos);
    }
    push_event(inner, agent, session_id, "question", &format!("❓ q{id} · {first}{more}"), vec![], Some("tú".into()));
    id
}

/// Las respuestas en texto, para el agente.
pub fn format_answers(q: &Question) -> String {
    if q.dismissed {
        return format!("💬 El usuario prefirió no contestar tu pregunta q{}: {DISMISSED_NOTE}", q.id);
    }
    let Some(answers) = &q.answers else { return String::new() };
    let mut out = format!("💬 Respuestas del usuario a tu pregunta q{}:", q.id);
    for (i, a) in answers.iter().enumerate() {
        let label = q
            .items
            .iter()
            .find(|it| it.question == a.question)
            .map(|it| it.question.clone())
            .unwrap_or_else(|| a.question.clone());
        let mut picked = a.choices.join(", ");
        if !a.other.trim().is_empty() {
            if !picked.is_empty() {
                picked.push_str("; ");
            }
            picked.push_str(&format!("otra: {}", a.other.trim()));
        }
        if picked.is_empty() {
            picked = "(sin respuesta)".into();
        }
        out.push_str(&format!("\n{}. {label} → {picked}", i + 1));
    }
    out
}

/// Contestas (o descartas con `answers: None`). Devuelve el agente y, si su herramienta ya no
/// espera, el texto que hay que escribirle en la terminal.
pub fn answer_question(inner: &mut HubInner, id: u64, answers: Option<Vec<QAnswer>>) -> Result<(String, Option<String>), String> {
    let q = inner.questions.iter_mut().find(|q| q.id == id).ok_or("esa pregunta ya no existe")?;
    if q.answers.is_some() || q.dismissed {
        return Err("esa pregunta ya está contestada".into());
    }
    match answers {
        Some(a) => q.answers = Some(a),
        None => q.dismissed = true,
    }
    q.answered_ms = now_ms();
    let text = format_answers(q);
    let agent = q.agent.clone();
    let late = q.detached.then(|| text.clone());
    push_event(inner, "tú", "ui", "answer", &text, vec![], Some(agent.clone()));
    Ok((agent, late))
}

/// La herramienta del agente se cansa de esperar: si ya hay respuesta se la lleva; si no, la
/// pregunta queda «suelta» y la respuesta irá a su terminal.
pub fn detach_question(inner: &mut HubInner, id: u64) -> Option<String> {
    let q = inner.questions.iter_mut().find(|q| q.id == id)?;
    if q.answers.is_some() || q.dismissed {
        return Some(format_answers(q));
    }
    q.detached = true;
    None
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
    pub strengths: HashMap<String, String>,
    #[serde(default)]
    pub questions: Vec<Question>,
    #[serde(default)]
    pub question_seq: u64,
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
    /// Copia de cada archivo al reservarlo (clave de `review::rel_key`), para el diff de la entrega.
    pub bases: HashMap<String, review::FileBase>,
    /// Tarea en la que trabaja cada agente (en minúsculas): a ella va el gasto de sus turnos.
    pub focus: HashMap<String, u64>,
    /// Qué se le da bien a cada agente (lo escribes tú): el líder lo usa para repartir.
    pub strengths: HashMap<String, String>,
    /// Preguntas de los agentes al usuario (team_ask_user).
    pub questions: Vec<Question>,
    pub question_seq: u64,
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
        memory: inner.memory.clone(),
        memory_seq: inner.memory_seq,
        usage: inner.usage.clone(),
        usage_since: inner.usage_since,
        director: inner.director,
        fix_limit: inner.fix_limit,
        strengths: inner.strengths.clone(),
        questions: inner.questions.clone(),
        question_seq: inner.question_seq,
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
        text: text.to_string(),
        files,
        to,
        task_id,
    };
    inner.events.push_back(event.clone());
    while inner.events.len() > MAX_EVENTS {
        inner.events.pop_front();
    }
    event
}

/// Guarda el relevo de un agente pegado a su tarea y lo anuncia en el feed.
pub fn save_handover(
    inner: &mut HubInner,
    agent: &str,
    session_id: &str,
    task_id: Option<u64>,
    summary: &str,
    files: Vec<String>,
) -> u64 {
    let now = now_ms();
    let mut attached = false;
    if let Some(id) = task_id {
        if let Some(task) = inner.tasks.iter_mut().find(|t| t.id == id) {
            task.handover = Some(TaskHandover {
                text: summary.to_string(),
                by: agent.to_string(),
                ts_ms: now,
                files: files.clone(),
            });
            attached = true;
        }
    }
    let label = match task_id {
        Some(id) if attached => format!("#{id} · "),
        Some(id) => format!("#{id} (sin tarea) · "),
        None => String::new(),
    };
    let ev = push_event_full(
        inner,
        agent,
        session_id,
        "handover",
        &format!("{label}{summary}"),
        files,
        None,
        task_id,
    );
    ev.seq
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
                "model": a.model,
                "ctx_tokens": a.ctx_tokens,
                "ctx_window": a.ctx_window,
                "ctx_ms": a.ctx_ms,
                "cli_session": a.cli_session,
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
        "memory": inner.memory,
        "claims": inner.claims.values().collect::<Vec<&Claim>>(),
        "inbox": inbox_summary(inner),
        "usage": inner.usage,
        "usage_since": inner.usage_since,
        "director": inner.director,
        "fix_limit": fix_limit(inner),
        "strengths": inner.strengths,
        "questions": inner.questions.iter().rev().take(20).collect::<Vec<_>>(),
        "now_ms": now,
    })
}

// ---------------------------------------------------------------------------
// Buzón: mensajes de un agente a otro (o a todo el equipo) que aún no ha leído
// ---------------------------------------------------------------------------

/// Nombre del líder si `to` lo nombra con su alias («líder», «lider», «leader»).
fn resolve_to(inner: &HubInner, to: &str) -> String {
    let t = to.trim();
    match t.to_lowercase().as_str() {
        "líder" | "lider" | "leader" => inner.leader.clone().unwrap_or_else(|| t.to_string()),
        _ => t.to_string(),
    }
}

/// ¿Es `e` un mensaje para `agent`? Directo a él, o de otro agente para todo el equipo.
/// Los del usuario («tú») no: esos ya se escriben en su terminal.
fn is_inbox_for(inner: &HubInner, e: &Event, agent: &str) -> bool {
    if e.kind != "message" || e.agent == "tú" || e.agent.eq_ignore_ascii_case(agent) {
        return false;
    }
    match e.to.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        None => true,
        Some(to) => {
            let to = resolve_to(inner, to);
            to.eq_ignore_ascii_case(agent) || to == "todos" || to == "equipo"
        }
    }
}

pub fn inbox_mark(inner: &HubInner, agent: &str) -> u64 {
    inner
        .inbox_marks
        .get(&agent.to_lowercase())
        .copied()
        .unwrap_or(0)
        .max(inner.inbox_floor)
}

/// Mensajes sin leer de `agent`, del más antiguo al más nuevo.
pub fn inbox_unread<'a>(inner: &'a HubInner, agent: &str) -> Vec<&'a Event> {
    let mark = inbox_mark(inner, agent);
    inner
        .events
        .iter()
        .filter(|e| e.seq > mark && is_inbox_for(inner, e, agent))
        .collect()
}

pub fn inbox_ack(inner: &mut HubInner, agent: &str, seq: u64) {
    let entry = inner.inbox_marks.entry(agent.to_lowercase()).or_insert(0);
    if seq > *entry {
        *entry = seq;
    }
}

/// Para la UI: cuántos mensajes tiene sin leer cada agente conectado.
fn inbox_summary(inner: &HubInner) -> serde_json::Value {
    let mut out = serde_json::Map::new();
    let mut names: Vec<&str> = inner.agents.values().map(|a| a.name.as_str()).collect();
    names.sort();
    names.dedup();
    for name in names {
        let unread = inbox_unread(inner, name);
        if unread.is_empty() {
            continue;
        }
        out.insert(
            name.to_string(),
            serde_json::json!({
                "unread": unread.len(),
                // Solo los dirigidos a él justifican despertarlo (un turno entero de contexto).
                "direct": unread.iter().filter(|e| e.to.is_some()).count(),
                "last_seq": unread.last().map(|e| e.seq).unwrap_or(0),
                "from": unread.iter().map(|e| e.agent.clone()).collect::<std::collections::BTreeSet<_>>(),
            }),
        );
    }
    serde_json::Value::Object(out)
}

/// Normaliza el destinatario de un mensaje antes de guardarlo (alias del líder).
pub fn message_target(inner: &HubInner, to: Option<String>) -> Option<String> {
    to.map(|t| resolve_to(inner, &t)).filter(|t| !t.is_empty())
}

// ---------------------------------------------------------------------------
// Consumo de tokens
// ---------------------------------------------------------------------------

/// Suma el gasto de un mensaje del agente (una sola vez por `id`).
#[allow(clippy::too_many_arguments)]
pub fn report_usage(
    inner: &mut HubInner,
    agent: &str,
    id: &str,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
) {
    if !id.is_empty() {
        if inner.usage_seen.iter().any(|x| x == id) {
            return;
        }
        inner.usage_seen.push_back(id.to_string());
        while inner.usage_seen.len() > 5000 {
            inner.usage_seen.pop_front();
        }
    }
    let u = inner.usage.entry(agent.to_string()).or_default();
    u.input += input;
    u.output += output;
    u.cache_read += cache_read;
    u.cache_write += cache_write;
    u.turns += 1;

    // El gasto también cuenta para la tarea en la que está el agente. Cuando la tarea ya
    // no es suya (cerrada, o devuelta a quien la hace tras revisarla), deja de contar.
    let key = agent.to_lowercase();
    let Some(&tid) = inner.focus.get(&key) else { return };
    let Some(task) = inner.tasks.iter_mut().find(|t| t.id == tid) else {
        inner.focus.remove(&key);
        return;
    };
    let c = task.cost.entry(agent.to_string()).or_default();
    c.input += input;
    c.output += output;
    c.cache_read += cache_read;
    c.cache_write += cache_write;
    c.turns += 1;
    let still_mine = task.status != "done" && (task.owner.eq_ignore_ascii_case(agent) || task.status == "review");
    if !still_mine {
        inner.focus.remove(&key);
    }
}

/// A partir de ahora, el gasto de `agent` cuenta para la tarea `id`.
pub fn set_focus(inner: &mut HubInner, agent: &str, id: u64) {
    if agent != "tú" {
        inner.focus.insert(agent.to_lowercase(), id);
    }
}

pub fn report_saved(inner: &mut HubInner, agent: &str, tokens: u64) {
    if tokens > 0 {
        inner.usage.entry(agent.to_string()).or_default().saved_ctx += tokens;
    }
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

/// Guarda la telemetría de contexto que reporta el puente (uso real de tokens
/// leído del transcript del agente). Busca por sesión y, si no, por nombre.
/// Guarda el id de conversación del CLI que reportó un hook (ver `AgentInfo::cli_session`).
pub fn report_cli_session(inner: &mut HubInner, session_id: &str, agent_name: &str, cli: &str) {
    let key = if !session_id.is_empty() && inner.agents.contains_key(session_id) {
        session_id.to_string()
    } else {
        inner
            .agents
            .iter()
            .filter(|(_, a)| a.name == agent_name)
            .max_by_key(|(_, a)| a.last_seen_ms)
            .map(|(k, _)| k.clone())
            .unwrap_or_default()
    };
    if let Some(agent) = inner.agents.get_mut(&key) {
        agent.cli_session = Some(cli.to_string());
    }
}

pub fn report_ctx(
    inner: &mut HubInner,
    session_id: &str,
    agent_name: &str,
    model: Option<String>,
    tokens: Option<u64>,
    window: Option<u64>,
) {
    let key = if !session_id.is_empty() && inner.agents.contains_key(session_id) {
        session_id.to_string()
    } else {
        inner
            .agents
            .iter()
            .filter(|(_, a)| a.name == agent_name)
            .max_by_key(|(_, a)| a.last_seen_ms)
            .map(|(k, _)| k.clone())
            .unwrap_or_default()
    };
    if key.is_empty() {
        return;
    }
    let mut freed: Option<(String, u64)> = None;
    if let Some(agent) = inner.agents.get_mut(&key) {
        if model.is_some() {
            agent.model = model;
        }
        if let Some(t) = tokens {
            // Una caída fuerte del contexto es una compactación (relevo o /compact): lo que se
            // liberó deja de viajar en cada mensaje siguiente.
            if let Some(prev) = agent.ctx_tokens {
                if prev > 30_000 && t < prev / 2 {
                    freed = Some((agent.name.clone(), prev - t));
                }
            }
            agent.ctx_tokens = Some(t);
        }
        if let Some(w) = window {
            agent.ctx_window = Some(w);
        }
        agent.ctx_ms = Some(now_ms());
    }
    if let Some((name, n)) = freed {
        let u = inner.usage.entry(name).or_default();
        u.freed += n;
        u.compactions += 1;
    }
}

/// ¿Sigue vivo el proceso `pid`? Sin PID conocido (0) se asume que sí.
#[cfg(windows)]
pub fn pid_alive(pid: u32) -> bool {
    use std::ffi::c_void;
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn GetExitCodeProcess(h: *mut c_void, code: *mut u32) -> i32;
        fn CloseHandle(h: *mut c_void) -> i32;
    }
    if pid == 0 {
        return true;
    }
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(h, &mut code) != 0;
        CloseHandle(h);
        !ok || code == STILL_ACTIVE
    }
}

#[cfg(not(windows))]
pub fn pid_alive(_pid: u32) -> bool {
    true
}

/// Quita las sesiones de `name` en `project` cuyo proceso ya murió (p. ej. el agente que se
/// reinició con otro modelo): si no, la tarjeta vieja seguía «en línea» hasta caducar.
pub fn drop_dead_sessions(inner: &mut HubInner, name: &str, project: &str, keep: &str) {
    let dead: Vec<String> = inner
        .agents
        .iter()
        .filter(|(k, a)| {
            k.as_str() != keep && a.name == name && a.project == project && !pid_alive(a.pid)
        })
        .map(|(k, _)| k.clone())
        .collect();
    for id in dead {
        inner.agents.remove(&id);
        inner.claims.retain(|_, c| c.session_id != id);
    }
}

/// Drop agents that stopped heartbeating (and their file claims). Also releases
/// tasks whose owner no longer has any live session (orphaned work).
pub fn expire_agents(inner: &mut HubInner) -> bool {
    let now = now_ms();
    let stale: Vec<String> = inner
        .agents
        .iter()
        .filter(|(_, a)| {
            let silent = now.saturating_sub(a.last_seen_ms);
            // Proceso muerto y callado >30s (el latido es cada 8s): fuera sin esperar al TTL.
            silent > AGENT_TTL_MS * 4 || (silent > 30_000 && !pid_alive(a.pid))
        })
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
pub fn team_add_task(
    hub: tauri::State<'_, Hub>,
    title: String,
    parents: Option<Vec<u64>>,
) -> Result<(), String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    let parents = check_parents(&inner.tasks, &parents.unwrap_or_default())?;
    inner.task_seq += 1;
    let id = inner.task_seq;
    let mut task = Task::new(id, title.trim().to_string(), String::new(), parents);
    // En modo director, lo que creas a mano espera a que el líder escriba el encargo.
    let leader = inner.leader.clone().filter(|_| inner.director);
    if leader.is_some() {
        task.status = "draft".into();
    }
    inner.tasks.push(task);
    push_event(
        &mut inner,
        "tú",
        "ui",
        "task",
        &format!("#{} creada: {}", id, title.trim()),
        vec![],
        None,
    );
    if let Some(leader) = leader {
        let text = format!(
            "📝 Nueva tarea #{id} «{}» del usuario: escribe su encargo con team_task_brief (notes con la plantilla, level y, si hace falta, assign). Hasta entonces no se reparte.",
            clean_text(&title, 120)
        );
        push_event_full(&mut inner, "lienzo", "hub", "message", &text, vec![], Some(leader), Some(id));
    }
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(())
}

#[tauri::command]
pub fn team_task_comment(hub: tauri::State<'_, Hub>, id: u64, text: String) -> Result<(), String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    add_task_comment(&mut inner, id, "tú", "ui", &text)?;
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(())
}

#[tauri::command]
pub fn team_memory_add(hub: tauri::State<'_, Hub>, text: String, kind: Option<String>) -> Result<(), String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    memory_add(&mut inner, "tú", &text, kind.as_deref().unwrap_or("hecho"), true)?;
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(())
}

#[tauri::command]
pub fn team_memory_resolve(
    hub: tauri::State<'_, Hub>,
    id: u64,
    accept: bool,
    text: Option<String>,
) -> Result<(), String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    memory_resolve(&mut inner, id, accept, text.as_deref(), "tú")?;
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(())
}

#[tauri::command]
pub fn team_memory_forget(hub: tauri::State<'_, Hub>, id: u64) -> Result<(), String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    memory_forget(&mut inner, id, "tú")?;
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(())
}

#[tauri::command]
pub fn team_task_op(hub: tauri::State<'_, Hub>, id: u64, op: String) -> Result<(), String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    if op == "delete" || op == "approve" {
        if op == "delete" {
            delete_task(&mut inner, id)?;
        } else {
            review_task(&mut inner, id, "tú", "ui", "ok", "")?;
        }
        persist(&inner);
        drop(inner);
        notify_ui();
        return Ok(());
    }
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
                task.result = None; // la entrega anterior ya no vale
                task.fix_rounds = 0;
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

/// Change who coordinates the team, without touching the charter.
#[tauri::command]
pub fn team_leader(hub: tauri::State<'_, Hub>, leader: Option<String>) -> Result<(), String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
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

/// Modo director: el líder reparte y revisa; `fix_limit` = rondas de corrección antes de asumirla.
#[tauri::command]
pub fn team_director(hub: tauri::State<'_, Hub>, enabled: bool, fix_limit: Option<u32>) -> Result<(), String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    inner.director = enabled;
    if let Some(n) = fix_limit {
        inner.fix_limit = n.clamp(1, 5);
    }
    let text = if enabled {
        format!(
            "modo director activado: {} reparte y revisa las entregas (máx. {} rondas de corrección)",
            inner.leader.clone().unwrap_or_else(|| "el líder".into()),
            self::fix_limit(&inner)
        )
    } else {
        "modo director desactivado: las tareas se cierran sin revisión".to_string()
    };
    push_event(&mut inner, "tú", "ui", "update", &text, vec![], None);
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

/// Contestas la pregunta de un agente (`answers` vacío = la descartas). Devuelve a quién y, si
/// su herramienta ya no esperaba, el texto que la app le escribe en la terminal.
#[tauri::command]
pub fn team_answer(hub: tauri::State<'_, Hub>, id: u64, answers: Option<Vec<QAnswer>>) -> Result<serde_json::Value, String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    let (agent, late) = answer_question(&mut inner, id, answers)?;
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(serde_json::json!({ "agent": agent, "late": late }))
}

/// Empieza a contar el consumo de tokens desde cero.
#[tauri::command]
pub fn team_usage_reset(hub: tauri::State<'_, Hub>) -> Result<(), String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    inner.usage.clear();
    inner.usage_since = now_ms();
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(())
}

/// Qué se le da bien a un agente (vacío = olvidarlo). El líder lo ve al repartir.
#[tauri::command]
pub fn team_strengths(hub: tauri::State<'_, Hub>, agent: String, text: String) -> Result<(), String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    let text = clean_text(&text, 200);
    if text.is_empty() {
        inner.strengths.remove(&agent);
    } else {
        inner.strengths.insert(agent, text);
    }
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
        inbox_marks: HashMap::new(),
        inbox_floor: persisted.seq,
        usage: persisted.usage,
        usage_since: if persisted.usage_since > 0 { persisted.usage_since } else { now_ms() },
        usage_seen: VecDeque::new(),
        director: persisted.director,
        fix_limit: persisted.fix_limit,
        bases: HashMap::new(),
        focus: HashMap::new(),
        strengths: persisted.strengths,
        questions: persisted.questions,
        question_seq: persisted.question_seq,
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

#[cfg(test)]
mod task_tests {
    use super::*;

    fn task(id: u64, status: &str, parents: &[u64]) -> Task {
        let mut t = Task::new(id, format!("t{id}"), String::new(), parents.to_vec());
        t.status = status.into();
        t
    }

    #[test]
    fn unmet_parents_lists_only_pending_ones() {
        let tasks = vec![task(1, "done", &[]), task(2, "claimed", &[]), task(3, "open", &[1, 2])];
        assert_eq!(unmet_parents(&tasks, &tasks[2]), vec![2]);
    }

    #[test]
    fn missing_parent_counts_as_met() {
        let tasks = vec![task(3, "open", &[9])];
        assert!(unmet_parents(&tasks, &tasks[0]).is_empty());
    }

    #[test]
    fn check_parents_rejects_unknown_and_dedupes() {
        let tasks = vec![task(1, "open", &[]), task(2, "open", &[])];
        assert_eq!(check_parents(&tasks, &[2, 1, 2]).unwrap(), vec![2, 1]);
        assert!(check_parents(&tasks, &[7]).is_err());
    }

    #[test]
    fn old_state_without_new_fields_still_loads() {
        let json = r#"{"id":1,"title":"x","status":"open","created_ms":5}"#;
        let t: Task = serde_json::from_str(json).unwrap();
        assert!(t.parents.is_empty() && t.result.is_none());
    }
}

#[cfg(test)]
mod inbox_tests {
    use super::*;

    fn hub() -> HubInner {
        HubInner {
            token: String::new(),
            port: 0,
            agents: HashMap::new(),
            events: VecDeque::new(),
            tasks: vec![],
            claims: HashMap::new(),
            project: None,
            charter: None,
            leader: Some("claude".into()),
            broadcasts: VecDeque::new(),
            memory: vec![],
            memory_seq: 0,
            broadcast_marks: HashMap::new(),
            inbox_marks: HashMap::new(),
            inbox_floor: 0,
            usage: HashMap::new(),
            usage_since: 0,
            usage_seen: VecDeque::new(),
            director: false,
            fix_limit: 0,
            bases: HashMap::new(),
            focus: HashMap::new(),
            strengths: HashMap::new(),
            questions: Vec::new(),
            question_seq: 0,
            seq: 0,
            task_seq: 0,
        }
    }

    fn msg(h: &mut HubInner, from: &str, to: Option<&str>, text: &str) -> u64 {
        let to = message_target(h, to.map(|s| s.to_string()));
        push_event(h, from, "s", "message", text, vec![], to).seq
    }

    #[test]
    fn inbox_gets_direct_and_team_messages_but_not_own_or_user() {
        let mut h = hub();
        msg(&mut h, "opencode", Some("claude"), "para ti");
        msg(&mut h, "opencode", None, "para todos");
        msg(&mut h, "opencode", Some("antigravity"), "para otro");
        msg(&mut h, "claude", None, "mío");
        msg(&mut h, "tú", Some("claude"), "del usuario");
        let texts: Vec<&str> = inbox_unread(&h, "claude").iter().map(|e| e.text.as_str()).collect();
        assert_eq!(texts, vec!["para ti", "para todos"]);
    }

    #[test]
    fn leader_alias_and_ack() {
        let mut h = hub();
        let seq = msg(&mut h, "opencode", Some("líder"), "hola líder");
        assert_eq!(inbox_unread(&h, "claude").len(), 1);
        inbox_ack(&mut h, "Claude", seq);
        assert!(inbox_unread(&h, "claude").is_empty());
    }

    #[test]
    fn messages_before_start_count_as_read() {
        let mut h = hub();
        msg(&mut h, "opencode", Some("claude"), "viejo");
        h.inbox_floor = h.seq;
        msg(&mut h, "opencode", Some("claude"), "nuevo");
        let texts: Vec<&str> = inbox_unread(&h, "claude").iter().map(|e| e.text.as_str()).collect();
        assert_eq!(texts, vec!["nuevo"]);
    }

    #[test]
    fn usage_counts_each_message_once() {
        let mut h = hub();
        report_usage(&mut h, "claude", "cc:1", 10, 5, 100, 20);
        report_usage(&mut h, "claude", "cc:1", 10, 5, 100, 20);
        report_usage(&mut h, "claude", "cc:2", 1, 1, 1, 1);
        let u = &h.usage["claude"];
        assert_eq!((u.input, u.output, u.cache_read, u.cache_write, u.turns), (11, 6, 101, 21, 2));
    }

    #[test]
    fn big_context_drop_counts_as_freed() {
        let mut h = hub();
        h.agents.insert(
            "s1".into(),
            AgentInfo {
                session_id: "s1".into(),
                name: "claude".into(),
                project: String::new(),
                pid: 0,
                last_seen_ms: now_ms(),
                model: None,
                ctx_tokens: Some(150_000),
                ctx_window: Some(200_000),
                ctx_ms: None,
                cli_session: None,
            },
        );
        report_ctx(&mut h, "s1", "claude", None, Some(20_000), None);
        report_ctx(&mut h, "s1", "claude", None, Some(25_000), None);
        let u = &h.usage["claude"];
        assert_eq!((u.freed, u.compactions), (130_000, 1));
    }

    fn join(h: &mut HubInner, name: &str) {
        h.agents.insert(
            name.into(),
            AgentInfo {
                session_id: name.into(),
                name: name.into(),
                project: String::new(),
                pid: 0,
                last_seen_ms: now_ms(),
                model: None,
                ctx_tokens: None,
                ctx_window: None,
                ctx_ms: None,
                cli_session: None,
            },
        );
    }

    /// Hub en modo director con una tarea #1 de opencode entregada y en revisión.
    fn delivered() -> HubInner {
        let mut h = hub();
        h.director = true;
        join(&mut h, "claude");
        let mut t = Task::new(1, "login".into(), String::new(), vec![]);
        t.status = "review".into();
        t.owner = "opencode".into();
        t.result = Some(TaskResult {
            summary: "hecho".into(),
            files: vec!["src/a.ts".into()],
            evidence: "npm test ok".into(),
            by: "opencode".into(),
            ts_ms: 0,
            diff: String::new(),
        });
        h.tasks.push(t);
        h
    }

    #[test]
    fn director_reviews_only_workers_with_leader_online() {
        let mut h = hub();
        assert_eq!(reviewer_for(&h, "opencode"), None, "sin modo director no hay revisión");
        h.director = true;
        assert_eq!(reviewer_for(&h, "opencode").as_deref(), Some("claude"), "aunque esté desconectado, la entrega le espera");
        h.leader = None;
        assert_eq!(reviewer_for(&h, "opencode"), None, "sin líder no hay revisión");
        h.leader = Some("claude".into());
        assert_eq!(reviewer_for(&h, "claude"), None, "el líder no se revisa a sí mismo");
        assert_eq!(reviewer_for(&h, "tú"), None);
    }

    #[test]
    fn review_request_reaches_leader_inbox() {
        let mut h = delivered();
        ask_review(&mut h, 1, "claude");
        let inbox = inbox_unread(&h, "claude");
        assert_eq!(inbox.len(), 1);
        assert!(inbox[0].text.contains("#1") && inbox[0].text.contains("npm test ok"));
    }

    #[test]
    fn fix_goes_back_to_owner_until_limit() {
        let mut h = delivered();
        assert!(review_task(&mut h, 1, "opencode", "s", "ok", "").is_err(), "un trabajador no se aprueba");
        assert!(review_task(&mut h, 1, "claude", "s", "fix", "  ").is_err(), "fix pide órdenes");
        review_task(&mut h, 1, "claude", "s", "fix", "falta el test de error").unwrap();
        assert_eq!((h.tasks[0].status.as_str(), h.tasks[0].fix_rounds), ("claimed", 1));
        let orders = inbox_unread(&h, "opencode");
        assert!(orders.iter().any(|e| e.text.contains("falta el test de error")));
        h.tasks[0].status = "review".into();
        review_task(&mut h, 1, "claude", "s", "fix", "otra vez").unwrap();
        h.tasks[0].status = "review".into();
        assert!(review_task(&mut h, 1, "claude", "s", "fix", "y otra").is_err(), "tope de rondas");
        review_task(&mut h, 1, "claude", "s", "take", "").unwrap();
        assert_eq!((h.tasks[0].status.as_str(), h.tasks[0].owner.as_str()), ("claimed", "claude"));
    }

    #[test]
    fn ok_closes_and_unblocks_children() {
        let mut h = delivered();
        h.tasks.push(Task::new(2, "hija".into(), String::new(), vec![1]));
        assert_eq!(unmet_parents(&h.tasks, &h.tasks[1]), vec![1], "en revisión aún bloquea");
        review_task(&mut h, 1, "tú", "ui", "ok", "").unwrap();
        assert_eq!(h.tasks[0].status, "done");
        assert!(unmet_parents(&h.tasks, &h.tasks[1]).is_empty());
    }

    #[test]
    fn leader_back_gets_one_reminder_of_pending_reviews() {
        let mut h = delivered();
        remind_reviews(&mut h, "claude");
        remind_reviews(&mut h, "claude");
        let inbox = inbox_unread(&h, "claude");
        assert_eq!(inbox.len(), 1, "un solo recordatorio aunque se conecte dos veces");
        assert!(inbox[0].text.contains("#1"));
        remind_reviews(&mut h, "opencode");
        assert!(inbox_unread(&h, "opencode").is_empty(), "solo al líder");
    }

    #[test]
    fn usage_goes_to_the_task_in_focus_until_it_is_not_theirs() {
        let mut h = delivered();
        h.tasks[0].status = "claimed".into();
        set_focus(&mut h, "opencode", 1);
        report_usage(&mut h, "opencode", "oc:1", 100, 10, 0, 0);
        h.tasks[0].status = "review".into();
        set_focus(&mut h, "claude", 1);
        report_usage(&mut h, "claude", "cc:1", 5, 50, 1000, 0);
        review_task(&mut h, 1, "claude", "s", "ok", "").unwrap();
        report_usage(&mut h, "claude", "cc:2", 1, 1, 1, 1);
        report_usage(&mut h, "claude", "cc:3", 7, 7, 7, 7);
        let cost = &h.tasks[0].cost;
        assert_eq!((cost["opencode"].input, cost["claude"].output, cost["claude"].turns), (100, 51, 2));
        assert!(!h.focus.contains_key("claude"), "tras cerrarla, su gasto ya no cuenta para la tarea");
        assert_eq!(h.usage["claude"].turns, 3);
    }

    #[test]
    fn brief_opens_a_draft_only_for_the_leader() {
        let mut h = hub();
        let mut t = Task::new(1, "login".into(), String::new(), vec![]);
        t.status = "draft".into();
        h.tasks.push(t);
        assert!(brief_task(&mut h, 1, "opencode", "s", "hazlo", "", "").is_err());
        assert!(brief_task(&mut h, 1, "claude", "s", "  ", "", "").is_err(), "sin encargo no");
        brief_task(&mut h, 1, "claude", "s", "Objetivo: …", "Fácil", "OpenCode").unwrap();
        let t = &h.tasks[0];
        assert_eq!((t.status.as_str(), t.level.as_str(), t.assign.as_str()), ("open", "simple", "OpenCode"));
    }

    #[test]
    fn levels_are_normalized() {
        assert_eq!(task_level("Difícil"), "dificil");
        assert_eq!(task_level("fácil"), "simple");
        assert_eq!(task_level("??"), "");
    }

    #[test]
    fn preguntas_al_usuario() {
        let mut h = hub();
        // Validación: opciones mínimas y número de preguntas.
        assert!(clean_questions(&serde_json::json!([])).is_err());
        assert!(clean_questions(&serde_json::json!([{ "question": "¿Color?", "options": ["Azul"] }])).is_err());
        let items = clean_questions(&serde_json::json!([
            { "question": "¿Qué estilo?", "header": "Estilo", "options": [
                { "label": "Minimalista", "description": "Mucho blanco" }, "Colorido" ] },
            { "question": "¿Qué incluye?", "options": ["Login", "Pagos", "Blog"], "multiSelect": true }
        ]))
        .unwrap();
        assert_eq!(items[0].options[1].label, "Colorido");
        assert!(items[1].multi);

        // Contestada mientras la herramienta espera: no hay que escribir en la terminal.
        let id = ask_user(&mut h, "claude", "s1", "Antes de diseñar", items.clone());
        assert!(h.events.back().unwrap().text.starts_with(&format!("❓ q{id} · ¿Qué estilo? (+1)")));
        let (agent, late) = answer_question(
            &mut h,
            id,
            Some(vec![
                QAnswer { question: "¿Qué estilo?".into(), choices: vec!["Minimalista".into()], other: String::new() },
                QAnswer { question: "¿Qué incluye?".into(), choices: vec!["Login".into(), "Blog".into()], other: "SEO".into() },
            ]),
        )
        .unwrap();
        assert_eq!((agent.as_str(), late), ("claude", None));
        let text = detach_question(&mut h, id).unwrap();
        assert!(text.contains("1. ¿Qué estilo? → Minimalista"));
        assert!(text.contains("2. ¿Qué incluye? → Login, Blog; otra: SEO"));
        assert!(answer_question(&mut h, id, None).is_err());

        // La herramienta dejó de esperar: la respuesta va a la terminal.
        let id2 = ask_user(&mut h, "opencode", "s2", "", items);
        assert_eq!(detach_question(&mut h, id2), None);
        let (_, late) = answer_question(&mut h, id2, None).unwrap();
        assert!(late.unwrap().contains("prefirió no contestar"));
    }
}
