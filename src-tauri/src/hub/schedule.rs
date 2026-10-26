//! Tareas programadas: un agente (normalmente el líder) escribe el encargo una vez con su frecuencia
//! («cada día 9:00», «lun-vie 8:30», «cada 2 h») y Prometeo crea una tarea normal a cada hora, que el
//! despacho da a quien toque (un agente económico, si va dirigida a él). Nada corre sin tu OK: toda
//! programación nace «pendiente» y la apruebas en el tablero.
//!
//! El reloj vive en la interfaz (sabe la hora local y los límites de uso de cada agente); aquí se
//! guardan las programaciones, se valida la frecuencia y se crea la tarea al dispararse.

use super::{now_ms, push_event, resolve_agent, task_level, HubInner, Task};
use serde::{Deserialize, Serialize};

/// Tope por defecto de ejecuciones al día (para que nada gaste cuota sin que lo veas).
pub const DEFAULT_DAILY_CAP: u32 = 6;
/// Intervalo mínimo de «cada N min».
pub const MIN_INTERVAL_MIN: u32 = 15;
/// Intervalo máximo permitido (~1 año en minutos).
pub const MAX_INTERVAL_MIN: u32 = 525_600;

#[derive(Clone, Serialize, Deserialize)]
pub struct Schedule {
    pub id: u64,
    pub title: String,
    /// El encargo completo de cada ejecución.
    pub notes: String,
    /// La frecuencia tal como se escribió (la interfaz calcula la próxima hora con ella).
    pub every: String,
    #[serde(default)]
    pub assign: String,
    #[serde(default)]
    pub level: String,
    /// Modelo con el que debe ejecutarse (Claude: se le teclea `/model`; Antigravity: se reinicia
    /// con `--model`), vacío = el suyo.
    #[serde(default)]
    pub model: String,
    /// pending (espera tu OK) · active · paused
    pub status: String,
    #[serde(default)]
    pub daily_cap: u32,
    pub by: String,
    pub created_ms: u64,
    /// Carpeta del proyecto en que se creó: solo se dispara con ese proyecto abierto.
    #[serde(default)]
    pub project: String,
    #[serde(default)]
    pub approved_ms: u64,
    /// Última vez que tocó (se ejecutara o se saltara).
    #[serde(default)]
    pub last_ms: u64,
    /// Día local («2026-10-22») y ejecuciones de ese día.
    #[serde(default)]
    pub day: String,
    #[serde(default)]
    pub runs_day: u32,
    #[serde(default)]
    pub runs_total: u32,
    #[serde(default)]
    pub last_task: u64,
    /// Por qué se saltó la última vez (vacío si se ejecutó).
    #[serde(default)]
    pub skipped: String,
    /// Chat al que está ligada (id del chat de Prometeo y su título), vacío si a ninguno.
    #[serde(default)]
    pub chat: String,
    #[serde(default)]
    pub chat_title: String,
}

/// Lo que se puede escribir de una programación (al crearla desde la app o al editarla).
#[derive(Clone, Default, Deserialize)]
pub struct Draft {
    pub title: String,
    pub notes: String,
    pub every: String,
    #[serde(default)]
    pub assign: String,
    #[serde(default)]
    pub level: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub daily_cap: u32,
    #[serde(default)]
    pub chat: String,
    #[serde(default)]
    pub chat_title: String,
}

/// Normaliza: minúsculas, sin tildes, espacios simples.
fn norm(s: &str) -> String {
    let s: String = s
        .to_lowercase()
        .chars()
        .map(|c| match c {
            'á' => 'a',
            'é' => 'e',
            'í' => 'i',
            'ó' => 'o',
            'ú' | 'ü' => 'u',
            _ => c,
        })
        .collect();
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

const DAYS: [&str; 7] = ["lun", "mar", "mie", "jue", "vie", "sab", "dom"];

fn day_index(tok: &str) -> Option<usize> {
    let t = tok.trim();
    if t.len() < 3 {
        return None;
    }
    DAYS.iter().position(|d| t.starts_with(d))
}

fn valid_time(t: &str) -> bool {
    let Some((h, m)) = t.split_once(':') else { return false };
    let digits = |x: &str| !x.is_empty() && x.len() <= 2 && x.chars().all(|c| c.is_ascii_digit());
    digits(h) && digits(m) && h.parse::<u32>().is_ok_and(|h| h < 24) && m.parse::<u32>().is_ok_and(|m| m < 60)
}

/// ¿Se entiende la frecuencia? Devuelve una descripción corta o el motivo por el que no.
/// Formatos: «cada 30 min», «cada 2 h», «cada día 9:00» (o «diario 9:00»), «lun-vie 8:30»,
/// «laborables 8:30», «lun,mie,vie 18:00», «sab 10:00».
pub fn validate_every(every: &str) -> Result<String, String> {
    let s = norm(every);
    let help = "usa «cada 30 min», «cada 2 h», «cada día 9:00», «lun-vie 8:30» o «lun,mie,vie 18:00»";
    if let Some(rest) = s.strip_prefix("cada ") {
        if let Some(t) = rest.strip_prefix("dia ") {
            return if valid_time(t) { Ok(format!("cada día a las {t}")) } else { Err(format!("hora no válida en «{every}»: {help}")) };
        }
        let mut it = rest.splitn(2, ' ');
        let n: u32 = it.next().and_then(|n| n.parse().ok()).ok_or_else(|| format!("no entiendo «{every}»: {help}"))?;
        let unit = it.next().unwrap_or("");
        let mins = if unit.starts_with("min") {
            Some(n)
        } else if unit.starts_with('h') {
            n.checked_mul(60)
        } else {
            return Err(format!("no entiendo «{every}»: {help}"));
        };
        let mins = mins.ok_or_else(|| format!("intervalo demasiado grande en «{every}»"))?;
        if mins < MIN_INTERVAL_MIN {
            return Err(format!("como mínimo cada {MIN_INTERVAL_MIN} min"));
        }
        if mins > MAX_INTERVAL_MIN {
            return Err(format!("intervalo demasiado grande en «{every}» (como máximo {MAX_INTERVAL_MIN} min)"));
        }
        return Ok(format!("cada {mins} min"));
    }
    let (days, time) = s.rsplit_once(' ').ok_or_else(|| format!("no entiendo «{every}»: {help}"))?;
    if !valid_time(time) {
        return Err(format!("hora no válida en «{every}»: {help}"));
    }
    if matches!(days, "diario" | "todos los dias" | "cada dia") {
        return Ok(format!("cada día a las {time}"));
    }
    if days == "laborables" {
        return Ok(format!("lun-vie a las {time}"));
    }
    for part in days.split([',', ' ']).filter(|p| !p.is_empty() && *p != "y") {
        match part.split_once('-') {
            Some((a, b)) => {
                if day_index(a).is_none() || day_index(b).is_none() {
                    return Err(format!("día no válido «{part}»: {help}"));
                }
            }
            None => {
                if day_index(part).is_none() {
                    return Err(format!("día no válido «{part}»: {help}"));
                }
            }
        }
    }
    Ok(format!("{days} a las {time}"))
}

/// Crea una programación pendiente de tu aprobación.
#[allow(clippy::too_many_arguments)]
pub fn create(
    inner: &mut HubInner,
    by: &str,
    session_id: &str,
    title: &str,
    notes: &str,
    every: &str,
    assign: &str,
    level: &str,
    model: &str,
    daily_cap: u32,
) -> Result<Schedule, String> {
    let title = super::redact::redact(title.trim()).chars().take(160).collect::<String>();
    if title.is_empty() {
        return Err("la programación necesita un título".into());
    }
    let notes = super::redact::redact(notes.trim()).chars().take(4000).collect::<String>();
    if notes.is_empty() {
        return Err("falta el encargo en `notes`: es lo que hará el agente cada vez".into());
    }
    let when = validate_every(every)?;
    inner.schedule_seq += 1;
    let s = Schedule {
        id: inner.schedule_seq,
        title,
        notes,
        every: every.trim().to_string(),
        assign: resolve_agent(inner, assign),
        level: task_level(level),
        model: model.trim().chars().take(40).collect(),
        status: "pending".into(),
        daily_cap: if daily_cap == 0 { DEFAULT_DAILY_CAP } else { daily_cap.min(48) },
        by: by.to_string(),
        created_ms: now_ms(),
        project: inner.project.clone().unwrap_or_default(),
        approved_ms: 0,
        last_ms: 0,
        day: String::new(),
        runs_day: 0,
        runs_total: 0,
        last_task: 0,
        skipped: String::new(),
        chat: String::new(),
        chat_title: String::new(),
    };
    let to = if s.assign.is_empty() { "quien esté libre".to_string() } else { s.assign.clone() };
    push_event(
        inner,
        by,
        session_id,
        "update",
        &format!("📅 Programación P{} pendiente de tu OK: «{}» · {when} → {to}. Apruébala en Programadas.", s.id, s.title),
        vec![],
        None,
    );
    inner.schedules.push(s.clone());
    Ok(s)
}

/// La creas tú desde la app: ya va aprobada (activa).
pub fn create_by_user(inner: &mut HubInner, d: &Draft) -> Result<Schedule, String> {
    let mut s = create(inner, "tú", "ui", &d.title, &d.notes, &d.every, &d.assign, &d.level, &d.model, d.daily_cap)?;
    if let Some(saved) = inner.schedules.iter_mut().find(|x| x.id == s.id) {
        saved.status = "active".into();
        saved.approved_ms = now_ms();
        saved.chat = d.chat.trim().chars().take(80).collect();
        saved.chat_title = d.chat_title.trim().chars().take(120).collect();
        s = saved.clone();
    }
    // El aviso de «pendiente» sobra: la creaste tú.
    if let Some(e) = inner.events.back_mut()
        && e.text.starts_with(&format!("📅 Programación P{} pendiente", s.id)) {
            e.text = format!("📅 Programación P{} creada: «{}» · {}", s.id, s.title, validate_every(&s.every).unwrap_or_default());
        }
    Ok(s)
}

/// Cambia lo escrito de una programación (frecuencia, encargo, agente…). Sigue en su estado.
pub fn update(inner: &mut HubInner, id: u64, d: &Draft) -> Result<Schedule, String> {
    let when = validate_every(&d.every)?;
    let title = super::redact::redact(d.title.trim()).chars().take(160).collect::<String>();
    let notes = super::redact::redact(d.notes.trim()).chars().take(4000).collect::<String>();
    if title.is_empty() || notes.is_empty() {
        return Err("hacen falta el título y el encargo".into());
    }
    let assign = resolve_agent(inner, &d.assign);
    let Some(s) = inner.schedules.iter_mut().find(|s| s.id == id) else {
        return Err("programación no encontrada".into());
    };
    s.title = title;
    s.notes = notes;
    s.every = d.every.trim().to_string();
    s.assign = assign;
    s.level = task_level(&d.level);
    s.model = d.model.trim().chars().take(40).collect();
    s.daily_cap = if d.daily_cap == 0 { DEFAULT_DAILY_CAP } else { d.daily_cap.min(48) };
    s.chat = d.chat.trim().chars().take(80).collect();
    s.chat_title = d.chat_title.trim().chars().take(120).collect();
    s.skipped = String::new();
    let out = s.clone();
    push_event(inner, "tú", "ui", "update", &format!("📅 P{id} «{}» cambiada · {when}", out.title), vec![], None);
    Ok(out)
}

/// Liga una programación a un chat (la que creó un agente queda en el chat donde se pidió).
pub fn link(inner: &mut HubInner, id: u64, chat: &str, title: &str) -> Result<(), String> {
    let Some(s) = inner.schedules.iter_mut().find(|s| s.id == id) else {
        return Err("programación no encontrada".into());
    };
    s.chat = chat.trim().chars().take(80).collect();
    s.chat_title = title.trim().chars().take(120).collect();
    Ok(())
}

/// approve · pause · resume · delete (desde el tablero).
pub fn op(inner: &mut HubInner, id: u64, op: &str) -> Result<(), String> {
    let Some(pos) = inner.schedules.iter().position(|s| s.id == id) else {
        return Err("programación no encontrada".into());
    };
    let title = inner.schedules[pos].title.clone();
    let text = match op {
        "approve" | "resume" => {
            let s = &mut inner.schedules[pos];
            if op == "approve" {
                s.approved_ms = now_ms();
                s.last_ms = 0;
            }
            s.status = "active".into();
            format!("📅 P{id} «{title}» activa")
        }
        "pause" => {
            inner.schedules[pos].status = "paused".into();
            format!("📅 P{id} «{title}» en pausa")
        }
        "delete" => {
            inner.schedules.remove(pos);
            format!("📅 P{id} «{title}» borrada")
        }
        other => return Err(format!("operación desconocida: {other}")),
    };
    push_event(inner, "tú", "ui", "update", &text, vec![], None);
    Ok(())
}

/// Toca la programación: crea su tarea, o se la salta con `skip` (cuota, tope…). `day` es el día
/// local, para el tope diario. `manual` = «Ejecutar ahora» (no cuenta como su hora).
pub fn fire(inner: &mut HubInner, id: u64, day: &str, skip: Option<&str>, manual: bool) -> Result<Option<u64>, String> {
    let Some(pos) = inner.schedules.iter().position(|s| s.id == id) else {
        return Err("programación no encontrada".into());
    };
    if inner.schedules[pos].status != "active" && !manual {
        return Err("la programación no está activa".into());
    }
    let now = now_ms();
    {
        let s = &mut inner.schedules[pos];
        if s.day != day {
            s.day = day.to_string();
            s.runs_day = 0;
        }
    }
    let s = inner.schedules[pos].clone();
    // La anterior aún sin acabar: no se amontonan.
    let pending = s.last_task != 0 && inner.tasks.iter().any(|t| t.id == s.last_task && t.status != "done");
    let reason = skip
        .map(String::from)
        .or_else(|| (s.runs_day >= s.daily_cap).then(|| format!("ya van {} hoy (tope diario)", s.runs_day)))
        .or_else(|| pending.then(|| format!("la anterior (#{}) aún no terminó", s.last_task)));
    if let Some(why) = reason {
        let s = &mut inner.schedules[pos];
        if !manual {
            s.last_ms = now;
        }
        if s.skipped != why {
            s.skipped = why.clone();
            let title = s.title.clone();
            push_event(inner, "tú", "ui", "update", &format!("📅 P{id} «{title}» saltada: {why}"), vec![], None);
        }
        return Ok(None);
    }
    inner.task_seq += 1;
    let tid = inner.task_seq;
    let mut task = Task::new(tid, format!("{} (programada)", s.title), s.notes.clone(), vec![]);
    task.assign = s.assign.clone();
    task.level = s.level.clone();
    task.schedule = id;
    task.model = s.model.clone();
    inner.tasks.push(task);
    {
        let s = &mut inner.schedules[pos];
        if !manual {
            s.last_ms = now;
        }
        s.runs_day += 1;
        s.runs_total += 1;
        s.last_task = tid;
        s.skipped = String::new();
    }
    let to = if s.assign.is_empty() { String::new() } else { format!(" → {}", s.assign) };
    super::push_event_full(inner, "tú", "ui", "task", &format!("#{tid} creada: {} (programada, P{id}){to}", s.title), vec![], None, Some(tid));
    Ok(Some(tid))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn understands_common_frequencies() {
        for ok in ["cada 30 min", "cada 2 h", "Cada día 9:00", "diario 09:30", "lun-vie 8:30", "laborables 7:05", "lun,mié,vie 18:00", "sáb 10:00", "lun y jue 12:00"] {
            assert!(validate_every(ok).is_ok(), "{ok}: {:?}", validate_every(ok));
        }
        for bad in ["cada 5 min", "a veces", "lun 25:00", "cada día", "pepe 9:00", "cada 3 semanas"] {
            assert!(validate_every(bad).is_err(), "{bad} debía fallar");
        }
    }

    #[test]
    fn frecuencia_extrema_no_desborda() {
        assert!(validate_every("cada 4294967295 h").is_err());
        assert!(validate_every("cada 100000000 min").is_err());
        assert_eq!(validate_every("cada 2 h").unwrap(), "cada 120 min");
    }
}
