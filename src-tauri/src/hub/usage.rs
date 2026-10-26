//! Consumo de tokens.

#![allow(unused_imports)]
use super::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

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
            if let Some(prev) = agent.ctx_tokens
                && prev > 30_000 && t < prev / 2 {
                    freed = Some((agent.name.clone(), prev - t));
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
