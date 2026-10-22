//! Preguntas de un agente al usuario (team_ask_user): un panel con opciones en el chat.

#![allow(unused_imports)]
use super::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

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
    /// Última vez que su herramienta preguntó por la respuesta (cada 1,5 s mientras espera).
    #[serde(default)]
    pub polled_ms: u64,
    /// Preferiste no contestar.
    #[serde(default)]
    pub dismissed: bool,
}

pub const MAX_QUESTIONS: usize = 40;
/// Sin preguntar por la respuesta en este tiempo, la herramienta del agente ya no la espera.
pub const ASK_GONE_MS: u64 = 10_000;

pub(super) const DISMISSED_NOTE: &str = "decide tú con criterio y explica qué elegiste en tu resumen.";

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
        polled_ms: 0,
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
    // Si su herramienta ya no pregunta (el agente o Prometeo se reiniciaron mientras esperaba),
    // nadie se llevaría la respuesta: va a su terminal, entera.
    if q.answered_ms.saturating_sub(q.polled_ms.max(q.ts_ms)) > ASK_GONE_MS {
        q.detached = true;
    }
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
