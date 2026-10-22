//! Buzón: mensajes de un agente a otro (o a todo el equipo) que aún no ha leído.

#![allow(unused_imports)]
use super::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

/// Nombre del líder si `to` lo nombra con su alias («líder», «lider», «leader»).
pub(super) fn resolve_to(inner: &HubInner, to: &str) -> String {
    let t = to.trim();
    match t.to_lowercase().as_str() {
        "líder" | "lider" | "leader" => inner.leader.clone().unwrap_or_else(|| t.to_string()),
        _ => t.to_string(),
    }
}

/// ¿Es `e` un mensaje para `agent`? Directo a él, o de otro agente para todo el equipo.
/// Los del usuario («tú») no: esos ya se escriben en su terminal.
pub(super) fn is_inbox_for(inner: &HubInner, e: &Event, agent: &str) -> bool {
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
pub(super) fn inbox_summary(inner: &HubInner) -> serde_json::Value {
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
