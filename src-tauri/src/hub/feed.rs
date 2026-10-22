//! Archivo del feed (lo que ya no cabe en el feed vivo), relevos y la foto del estado para la interfaz.

#![allow(unused_imports)]
use super::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

/// Tope del archivo de cada proyecto; al pasarlo, el actual pasa a `.old` y se empieza otro.
pub(super) const ARCHIVE_MAX_BYTES: u64 = 20 * 1024 * 1024;

pub(super) fn archive_file(project: Option<&str>) -> std::path::PathBuf {
    let key = project.map(project_key).unwrap_or_default();
    // FNV-1a: un nombre de archivo estable y corto para cada carpeta.
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in key.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    data_dir().join("feed-archive").join(format!("{h:016x}.jsonl"))
}

pub(super) fn archive_events(project: Option<&str>, events: &[Event]) {
    use std::io::Write;
    if events.is_empty() {
        return;
    }
    let path = archive_file(project);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::metadata(&path).map(|m| m.len() > ARCHIVE_MAX_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(&path, path.with_extension("old.jsonl"));
    }
    let mut lines = String::new();
    for e in events {
        if let Ok(l) = serde_json::to_string(e) {
            lines.push_str(&l);
            lines.push('\n');
        }
    }
    let written = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| f.write_all(lines.as_bytes()));
    if let Err(e) = written {
        crate::errlog::log("hub", "No se pudo archivar el feed", &e.to_string());
    }
}

/// ¿El evento casa con la búsqueda? Todas las palabras (sin mayúsculas) en su texto, autor o
/// archivos; `#67` también casa con los eventos de la tarea 67.
pub fn feed_matches(e: &Event, terms: &[String], agent: &str) -> bool {
    if matches!(e.kind.as_str(), "join" | "leave" | "session" | "stop" | "prompt") {
        return false;
    }
    if !agent.is_empty() && !e.agent.to_lowercase().contains(agent) {
        return false;
    }
    let hay = format!("{} {} {}", e.text, e.agent, e.files.join(" ")).to_lowercase();
    terms.iter().all(|t| {
        hay.contains(t.as_str())
            || t.strip_prefix('#').and_then(|n| n.parse::<u64>().ok()).is_some_and(|n| e.task_id == Some(n))
    })
}

/// Busca en el feed vivo y en el archivo del proyecto (lo más nuevo primero, hasta `limit`).
/// Devuelve los eventos en orden cronológico.
pub fn search_feed(inner: &HubInner, query: &str, agent: &str, limit: usize) -> Vec<Event> {
    let terms: Vec<String> = query.to_lowercase().split_whitespace().map(String::from).collect();
    let agent = agent.trim().to_lowercase();
    if terms.is_empty() && agent.is_empty() {
        return Vec::new();
    }
    let mut found: Vec<Event> = inner.events.iter().rev().filter(|e| feed_matches(e, &terms, &agent)).take(limit).cloned().collect();
    if found.len() < limit {
        let path = archive_file(inner.project.as_deref());
        for file in [path.clone(), path.with_extension("old.jsonl")] {
            let Ok(raw) = std::fs::read_to_string(&file) else {
                continue;
            };
            for line in raw.lines().rev() {
                if found.len() >= limit {
                    break;
                }
                if let Ok(e) = serde_json::from_str::<Event>(line) {
                    if feed_matches(&e, &terms, &agent) && !found.iter().any(|f| f.seq == e.seq) {
                        found.push(e);
                    }
                }
            }
        }
    }
    found.sort_by_key(|e| e.seq);
    found
}

/// Los eventos entre dos instantes, del feed vivo y del archivo del proyecto, en orden: para
/// exportar un chat entero aunque ya no quepa en el feed vivo. `limit` acota lo que se devuelve.
/// `live` es el feed vivo (copiado, para no leer el archivo con el hub bloqueado).
pub fn events_between(live: Vec<Event>, archive: &std::path::Path, from_ms: u64, to_ms: u64, limit: usize) -> Vec<Event> {
    let inside = |e: &Event| e.ts_ms >= from_ms && e.ts_ms < to_ms;
    let mut out: Vec<Event> = Vec::new();
    let oldest_live = live.first().map(|e| e.seq).unwrap_or(u64::MAX);
    // El archivo solo hace falta si la ventana empieza antes del feed vivo.
    if live.first().is_none_or(|e| from_ms < e.ts_ms) {
        for file in [archive.with_extension("old.jsonl"), archive.to_path_buf()] {
            let Ok(raw) = std::fs::read_to_string(&file) else { continue };
            out.extend(raw.lines().filter_map(|l| serde_json::from_str::<Event>(l).ok()).filter(|e| e.seq < oldest_live && inside(e)));
        }
    }
    out.extend(live.into_iter().filter(|e| inside(e)));
    out.sort_by_key(|e| e.seq);
    out.dedup_by_key(|e| e.seq);
    if out.len() > limit {
        out.drain(..out.len() - limit);
    }
    out
}

/// Eventos de una ventana de tiempo (`to_ms` ausente = hasta ahora), para exportar un chat.
#[tauri::command]
pub async fn team_events_range(hub: tauri::State<'_, Hub>, from_ms: u64, to_ms: Option<u64>) -> Result<Vec<Event>, String> {
    let (live, archive) = {
        let inner = hub.0.lock().map_err(|e| e.to_string())?;
        (inner.events.iter().cloned().collect::<Vec<_>>(), archive_file(inner.project.as_deref()))
    };
    Ok(events_between(live, &archive, from_ms, to_ms.unwrap_or(u64::MAX), 50_000))
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
                text: redact::redact(summary),
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
        "plan_hold": inner.plan_hold,
        "isolate": inner.isolate,
        "fix_limit": fix_limit(inner),
        "strengths": inner.strengths,
        "questions": inner.questions.iter().rev().take(20).collect::<Vec<_>>(),
        "schedules": inner.schedules,
        "projects": project_list(inner),
        "limits": inner.limits,
        "now_ms": now,
    })
}
