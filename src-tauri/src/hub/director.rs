//! Modo director: el líder reparte, revisa las entregas y manda corregir.

#![allow(unused_imports)]
use super::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

pub const DEFAULT_FIX_LIMIT: u32 = 2;

/// Primer revisor de las entregas `simple` y `media`: Codex (modelo fuerte con su propia cuota,
/// aparte de la de Claude). Revisa con el contexto limpio (encargo + diff) y solo le pasa al líder
/// lo difícil, lo delicado o lo que no sepa resolver: así no se relee su conversación entera por
/// cada entrega que acaba en «ok».
pub const FIRST_REVIEWER: &str = "codex";
/// Con esta cuota gastada (cualquier ventana), el primer revisor deja de revisar.
pub const FIRST_REVIEWER_MAX_PCT: f64 = 80.0;
/// Si el primer revisor no decide en este tiempo, la revisión vuelve al líder.
pub const FIRST_REVIEWER_WAIT_MS: u64 = 20 * 60_000;
/// Una revisión le cuesta al líder mucho más que a Codex (relee su conversación entera): solo las
/// hace él si el ritmo de cuota de Codex va al menos esto por delante del suyo.
pub const REVIEW_PACE_MARGIN: f64 = 25.0;

/// Ritmo de gasto de una cuota (`{ windows: [{ key, label, used_pct, resets_at }] }`): puntos por
/// encima (+) o por debajo (−) de un gasto parejo en su peor ventana; la de 5 h, que va a rachas,
/// con 15 de margen. `INFINITY` si alguna pasa del 80 %; 0 si no se sabe. Igual que `quotaPace`.
pub fn limits_pace(limits: &serde_json::Value, now: u64) -> f64 {
    const H: u64 = 3_600_000;
    let Some(ws) = limits["windows"].as_array() else { return 0.0 };
    let mut worst = f64::NEG_INFINITY;
    for w in ws {
        let used = w["used_pct"].as_f64().unwrap_or(0.0);
        if used >= 80.0 {
            return f64::INFINITY;
        }
        let name = format!("{} {}", w["key"].as_str().unwrap_or(""), w["label"].as_str().unwrap_or("")).to_lowercase();
        let len = if ["week", "semana", "seven", "7d", "7 d"].iter().any(|k| name.contains(k)) {
            7 * 24 * H
        } else if ["session", "sesión", "sesion", "5 h", "5h", "five"].iter().any(|k| name.contains(k)) {
            5 * H
        } else {
            continue;
        };
        let Some(reset) = w["resets_at"].as_u64() else { continue };
        let left = reset.saturating_sub(now).min(len);
        let ahead = used - 100.0 * (1.0 - left as f64 / len as f64);
        worst = worst.max(if len < 24 * H { ahead - 15.0 } else { ahead });
    }
    if worst == f64::NEG_INFINITY { 0.0 } else { worst }
}

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

/// Lo más gastado de la cuota de un agente (la peor de sus ventanas), 0 si no se sabe.
pub fn quota_pct(inner: &HubInner, agent: &str) -> f64 {
    inner
        .limits
        .get(&agent.to_lowercase())
        .and_then(|l| l["windows"].as_array())
        .map(|ws| ws.iter().filter_map(|w| w["used_pct"].as_f64()).fold(0.0, f64::max))
        .unwrap_or(0.0)
}

/// Ritmo de la cuota de un agente (ver `limits_pace`).
pub fn quota_pace(inner: &HubInner, agent: &str) -> f64 {
    inner.limits.get(&agent.to_lowercase()).map(|l| limits_pace(l, now_ms())).unwrap_or(0.0)
}

/// ¿Puede el primer revisor ocuparse ahora de una entrega? Conectado y con cuota.
pub fn first_reviewer_ready(inner: &HubInner) -> bool {
    is_online(inner, FIRST_REVIEWER) && quota_pct(inner, FIRST_REVIEWER) < FIRST_REVIEWER_MAX_PCT
}

/// Quién revisa la entrega de `agent` de la tarea `id`: el primer revisor si es `simple` o
/// `media`, está libre y no es ni quien la entrega ni el líder; si no, el líder (ver `reviewer_for`).
pub fn reviewer_for_task(inner: &HubInner, agent: &str, id: u64) -> Option<String> {
    let leader = reviewer_for(inner, agent)?;
    let level = inner.tasks.iter().find(|t| t.id == id).map(|t| t.level.as_str()).unwrap_or("");
    let first = FIRST_REVIEWER;
    let light = matches!(level, "simple" | "media");
    // Que duren las dos cuotas: si la de Codex va muy por delante de la del líder, revisa el líder.
    let balanced = quota_pace(inner, first) <= quota_pace(inner, &leader) + REVIEW_PACE_MARGIN;
    if light && !agent.eq_ignore_ascii_case(first) && !leader.eq_ignore_ascii_case(first) && first_reviewer_ready(inner) && balanced {
        Some(first.to_string())
    } else {
        Some(leader)
    }
}

/// ¿Puede `by` decidir sobre la entrega de la tarea? El líder, tú o quien tiene asignada su revisión.
fn may_review(inner: &HubInner, task: &Task, by: &str) -> bool {
    by == "tú"
        || inner.leader.as_deref().is_some_and(|l| l.eq_ignore_ascii_case(by))
        || (!task.reviewer.is_empty() && task.reviewer.eq_ignore_ascii_case(by))
}

/// Revisiones del primer revisor que deben volver al líder: se desconectó, se quedó sin cuota o
/// lleva demasiado sin decidir. Devuelve si cambió algo.
pub fn reroute_reviews(inner: &mut HubInner) -> bool {
    if !inner.director {
        return false;
    }
    let Some(leader) = inner.leader.clone() else { return false };
    let ready = first_reviewer_ready(inner);
    let now = now_ms();
    let stuck: Vec<(u64, &'static str)> = inner
        .tasks
        .iter()
        .filter(|t| t.status == "review" && !t.reviewer.is_empty() && !t.reviewer.eq_ignore_ascii_case(&leader))
        .filter_map(|t| {
            if !ready {
                Some((t.id, "no está disponible (desconectado o sin cuota)"))
            } else if now.saturating_sub(t.review_ms) > FIRST_REVIEWER_WAIT_MS {
                Some((t.id, "lleva 20 min sin decidir"))
            } else {
                None
            }
        })
        .collect();
    for (id, why) in &stuck {
        let first = inner.tasks.iter().find(|t| t.id == *id).map(|t| t.reviewer.clone()).unwrap_or_default();
        if let Some(t) = inner.tasks.iter_mut().find(|t| t.id == *id) {
            t.comments.push(TaskComment { by: "lienzo".into(), text: format!("⤴ La revisión pasa al líder: {first} {why}"), ts_ms: now });
        }
        ask_review(inner, *id, &leader);
    }
    !stuck.is_empty()
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
        .filter(|t| t.status == "review" && (t.reviewer.is_empty() || t.reviewer.eq_ignore_ascii_case(agent)))
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

pub(super) fn project_root(inner: &HubInner) -> Option<std::path::PathBuf> {
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

/// Pide a `reviewer` (el líder o el primer revisor) que revise una entrega: le llega como mensaje
/// directo, así que lo despierta. Queda anotado en la tarea quién la revisa y desde cuándo.
pub fn ask_review(inner: &mut HubInner, id: u64, reviewer: &str) {
    let is_leader = inner.leader.as_deref().is_some_and(|l| l.eq_ignore_ascii_case(reviewer));
    let Some(task) = inner.tasks.iter_mut().find(|t| t.id == id) else { return };
    let Some(r) = task.result.clone() else { return };
    task.reviewer = reviewer.to_string();
    task.review_ms = now_ms();
    let task = task.clone();
    let round = if task.fix_rounds > 0 { format!(" (tras la ronda {} de correcciones)", task.fix_rounds) } else { String::new() };
    let files = if r.files.is_empty() { "—".to_string() } else { r.files.join(", ") };
    let evidence = if r.evidence.is_empty() { "sin evidencia".to_string() } else { clean_text(&r.evidence, 300) };
    let diff_note = if r.diff.is_empty() { "" } else { " Los cambios van debajo: no abras los archivos salvo que te falte algo." };
    let how = if is_leader {
        "verdict ok, fix (con órdenes concretas) o take (la haces tú).".to_string()
    } else {
        // El primer revisor: decide lo claro y le pasa al líder lo que no lo es.
        let escalated = task
            .comments
            .iter()
            .rev()
            .find(|c| c.text.starts_with("⤴"))
            .map(|c| format!(" Nota: {}", clean_text(&c.text, 200)))
            .unwrap_or_default();
        format!(
            "eres el primer revisor (pauta: skill lienzo-revision). verdict ok si cumple el «Hecho cuando» del encargo; \
             fix con órdenes concretas si falla algo; lider si dudas, si toca algo delicado (seguridad, datos, borrados) \
             o si tras las rondas sigue mal.{escalated}"
        )
    };
    let text = format!(
        "🔎 Revisa la entrega de #{id} «{}» de {}{round}: {} · Archivos: {files} · Evidencia: {evidence}. \
         Decide con team_task_review: {how}{diff_note}",
        clean_text(&task.title, 120),
        r.by,
        clean_text(&r.summary, 500),
    );
    push_event_full(inner, "lienzo", "hub", "message", &text, r.files, Some(reviewer.to_string()), Some(id));
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
    if !matches!(task.status.as_str(), "draft" | "open" | "plan") {
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
    // Si es del plan, sigue esperando tu OK; si era un borrador, ya se puede repartir.
    if task.status != "plan" {
        task.status = "open".into();
    }
    let title = clean_text(&task.title, 100);
    push_event_full(inner, by, session_id, "task", &format!("#{id} con encargo: {title}"), vec![], None, Some(id));
    Ok(format!("#{id} lista para repartir."))
}

/// Apruebas el plan: sus tareas pasan a abiertas y el despacho ya las puede repartir.
/// Devuelve las tareas que se liberaron.
pub fn approve_plan(inner: &mut HubInner, by: &str, session_id: &str) -> Vec<u64> {
    inner.plan_hold = false;
    let mut ids = Vec::new();
    for t in inner.tasks.iter_mut().filter(|t| t.status == "plan") {
        t.status = "open".into();
        ids.push(t.id);
    }
    if !ids.is_empty() {
        let list = ids.iter().map(|i| format!("#{i}")).collect::<Vec<_>>().join(", ");
        push_event(inner, by, session_id, "update", &format!("✅ Plan aprobado: {list} ya se pueden empezar"), vec![], None);
    }
    ids
}

/// Descartas el plan: sus tareas se borran sin que nadie las haya empezado.
pub fn discard_plan(inner: &mut HubInner, by: &str, session_id: &str) -> Vec<u64> {
    inner.plan_hold = false;
    let ids: Vec<u64> = inner.tasks.iter().filter(|t| t.status == "plan").map(|t| t.id).collect();
    inner.tasks.retain(|t| t.status != "plan");
    if !ids.is_empty() {
        let list = ids.iter().map(|i| format!("#{i}")).collect::<Vec<_>>().join(", ");
        push_event(inner, by, session_id, "update", &format!("🗑 Plan descartado: {list} borradas"), vec![], None);
    }
    ids
}

/// El líder (o tú) pasa una tarea tomada por otro agente que se paró o se bloqueó: queda libre
/// para `to` (o para quien esté libre) y su antiguo dueño recibe la orden de dejarla. Así no hace
/// falta que el agente parado la cierre como «No hecha» para que otro pueda reclamarla.
pub fn handoff_task(
    inner: &mut HubInner,
    id: u64,
    by: &str,
    session_id: &str,
    to: &str,
    notes: &str,
) -> Result<String, String> {
    let is_leader = inner.leader.as_deref().is_some_and(|l| l.eq_ignore_ascii_case(by));
    if by != "tú" && !is_leader {
        return Err("solo el líder (o tú) pasa una tarea de un agente a otro".into());
    }
    let to = resolve_to(inner, to);
    let notes = clean_text(notes, 300);
    let Some(task) = inner.tasks.iter_mut().find(|t| t.id == id) else {
        return Err("tarea no encontrada".into());
    };
    if !matches!(task.status.as_str(), "claimed" | "open") {
        return Err(format!("la tarea #{id} está {}: solo se pasa una tarea abierta o tomada", task.status));
    }
    let owner = std::mem::take(&mut task.owner);
    task.status = "open".into();
    task.assign = to.clone();
    let title = clean_text(&task.title, 100);
    let now = now_ms();
    let dest = if to.is_empty() { "quien esté libre".to_string() } else { to.clone() };
    let why = if notes.is_empty() { String::new() } else { format!(": {notes}") };
    task.comments.push(TaskComment { by: by.into(), text: format!("🔁 Pasa a {dest}{why}"), ts_ms: now });
    let from = if owner.is_empty() { String::new() } else { format!(" (era de {owner})") };
    push_event_full(inner, by, session_id, "task", &format!("#{id} liberada por {by}{from} → {dest}"), vec![], None, Some(id));
    if !owner.is_empty() && !owner.eq_ignore_ascii_case(&to) {
        let text = format!(
            "🔁 La tarea #{id} «{title}» pasa a {dest}. Deja de trabajar en ella y suelta sus reservas con team_release_files."
        );
        push_event_full(inner, by, session_id, "message", &text, vec![], Some(owner), Some(id));
    }
    Ok(format!("#{id} libre para {dest}: lienzo se la despacha en cuanto esté libre."))
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
    let leader = inner.leader.clone().unwrap_or_default();
    let is_leader = !leader.is_empty() && leader.eq_ignore_ascii_case(by);
    let limit = fix_limit(inner);
    let notes = notes.trim().chars().take(2000).collect::<String>();
    let Some(pos) = inner.tasks.iter().position(|t| t.id == id) else {
        return Err("tarea no encontrada".into());
    };
    if !may_review(inner, &inner.tasks[pos], by) {
        return Err("solo el líder, tú o el revisor de esta entrega deciden sobre ella".into());
    }
    if inner.tasks[pos].status != "review" {
        return Err(format!("la tarea #{id} no está en revisión (estado: {})", inner.tasks[pos].status));
    }
    // El primer revisor no se queda la tarea: lo que no tiene claro (o pide «take») vuelve al líder.
    let first = by != "tú" && !is_leader;
    let verdict_l = verdict.trim().to_lowercase();
    if first && matches!(verdict_l.as_str(), "lider" | "líder" | "leader" | "escalar" | "take" | "asumir") {
        if leader.is_empty() {
            return Err("no hay líder a quien pasársela: decide ok o fix".into());
        }
        let why = if notes.is_empty() { String::new() } else { format!(": {notes}") };
        let now = now_ms();
        let task = &mut inner.tasks[pos];
        task.comments.push(TaskComment { by: by.into(), text: format!("⤴ {by} se la pasa al líder{why}"), ts_ms: now });
        let title = clean_text(&task.title, 100);
        push_event_full(inner, by, session_id, "task", &format!("#{id} pasa al líder para revisar: {title}"), vec![], None, Some(id));
        ask_review(inner, id, &leader);
        return Ok(format!("#{id} pasa a {leader} para que la revise."));
    }
    let task = &mut inner.tasks[pos];
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
                let way = if first { "pásasela al líder (verdict lider)" } else { "asúmela (verdict take)" };
                return Err(format!("#{id} ya lleva {} rondas de corrección: {way} o apruébala (ok)", task.fix_rounds));
            }
            task.fix_rounds += 1;
            let round = task.fix_rounds;
            task.status = "claimed".into();
            task.comments.push(TaskComment { by: by.into(), text: format!("🔧 Ronda {round}/{limit}: {notes}"), ts_ms: now });
            let last = if round >= limit { " Es la última ronda: si no queda bien, la asumirá el líder." } else { "" };
            let place = if task.workspace.is_empty() {
                String::new()
            } else {
                format!(" Corrígelo en tu carpeta aislada {}.", task.workspace)
            };
            let text = format!(
                "🔧 Corrige #{id} «{title}» (ronda {round} de {limit}): {notes}{last}{place} \
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
        other if first => Err(format!("veredicto «{other}» desconocido: usa ok, fix o lider")),
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
