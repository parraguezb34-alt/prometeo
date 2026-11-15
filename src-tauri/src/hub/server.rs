//! Local HTTP API of the team hub (used by `lienzo-mcp.exe`, hook scripts and
//! anything else that wants to talk to the team).
//!
//! Bound to 127.0.0.1 on a random port; every request needs the session token
//! (written to `%APPDATA%/lienzo/hub.json` and injected in terminal env vars).

use crate::hub;
use serde_json::{json, Value};
use std::io::Read;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::AppHandle;

const MAX_BODY_BYTES: usize = 1024 * 1024;
const MAX_IN_FLIGHT: usize = 16;

pub fn bind() -> Result<(tiny_http::Server, u16), String> {
    let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or_else(|| "no se pudo obtener el puerto del hub".to_string())?;
    Ok((server, port))
}

pub fn serve(server: tiny_http::Server, app: AppHandle) {
    serve_with(Arc::new(server), move |request| handle_caught(request, &app));
}

fn serve_with<H>(server: Arc<tiny_http::Server>, handler: H)
where
    H: Fn(tiny_http::Request) + Send + Sync + 'static,
{
    let handler = Arc::new(handler);
    let active = Arc::new(AtomicUsize::new(0));
    for request in server.incoming_requests() {
        // /health permanece disponible aunque una petición autenticada tarde en enviar su cuerpo.
        if request.url().split('?').next() == Some("/health") {
            handler(request);
            continue;
        }
        if active
            .try_update(Ordering::AcqRel, Ordering::Acquire, |n| (n < MAX_IN_FLIGHT).then_some(n + 1))
            .is_err()
        {
            respond_json(request, 503, json!({"error": "hub ocupado; vuelve a intentar"}));
            continue;
        }
        let handler = handler.clone();
        let active = active.clone();
        std::thread::spawn(move || {
            let _slot = ActiveRequest(active);
            handler(request);
        });
    }
}

struct ActiveRequest(Arc<AtomicUsize>);

impl Drop for ActiveRequest {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn handle_caught(request: tiny_http::Request, app: &AppHandle) {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handle(request, app)));
    if result.is_err() {
        crate::errlog::log("hub", "Una petición de un agente hizo fallar al hub (se recuperó)", "");
    }
}

fn parse_query(url: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    if let Some((_, qs)) = url.split_once('?') {
        for pair in qs.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                map.insert(k.to_string(), v.to_string());
            }
        }
    }
    map
}

fn respond_json(request: tiny_http::Request, status: u16, value: Value) {
    let body = value.to_string();
    let header = tiny_http::Header::from_bytes(
        &b"Content-Type"[..],
        &b"application/json; charset=utf-8"[..],
    )
    .unwrap();
    // Sin cabeceras CORS: solo hablan con el hub lienzo-mcp y los hooks, nunca una página web.
    let response = tiny_http::Response::from_string(body)
        .with_status_code(status)
        .with_header(header);
    let _ = request.respond(response);
}

fn authorized(request: &tiny_http::Request, app: &AppHandle) -> bool {
    let expected = match hub::with_inner(app, |i| i.token.clone()) {
        Some(t) => t,
        None => return false,
    };
    request
        .headers()
        .iter()
        .any(|h| h.field.equiv("X-Lienzo-Token") && same_token(h.value.as_str(), &expected))
}

/// Compara el token sin cortar en el primer byte distinto (no deja adivinarlo midiendo tiempos).
fn same_token(got: &str, want: &str) -> bool {
    let (a, b) = (got.as_bytes(), want.as_bytes());
    let mut diff = a.len() ^ b.len();
    for (i, &w) in b.iter().enumerate() {
        diff |= usize::from(a.get(i).copied().unwrap_or(0) ^ w);
    }
    diff == 0
}

fn read_payload(request: &mut tiny_http::Request) -> Result<Value, (u16, &'static str)> {
    if request.body_length().is_some_and(|n| n > MAX_BODY_BYTES) {
        return Err((413, "cuerpo demasiado grande"));
    }
    parse_payload(request.as_reader())
}

fn parse_payload(reader: &mut dyn Read) -> Result<Value, (u16, &'static str)> {
    let mut bytes = Vec::new();
    match reader.take((MAX_BODY_BYTES + 1) as u64).read_to_end(&mut bytes) {
        Ok(_) if bytes.len() > MAX_BODY_BYTES => Err((413, "cuerpo demasiado grande")),
        Ok(_) => Ok(serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}))),
        Err(e) if e.kind() == std::io::ErrorKind::TimedOut => Err((408, "tiempo agotado al leer el cuerpo")),
        Err(_) => Err((400, "no se pudo leer el cuerpo")),
    }
}

fn handle(mut request: tiny_http::Request, app: &AppHandle) {
    let method = request.method().as_str().to_string();
    let url = request.url().to_string();
    let path = url.split('?').next().unwrap_or("").to_string();
    let query = parse_query(&url);

    // /health needs no auth (only reports liveness).
    if path == "/health" {
        let v = hub::with_inner(app, |i| json!({"ok": true, "seq": i.seq, "port": i.port}))
            .unwrap_or_else(|| json!({"ok": true}));
        respond_json(request, 200, v);
        return;
    }

    if !authorized(&request, app) {
        respond_json(request, 401, json!({"error": "token inválido"}));
        return;
    }

    let payload = match read_payload(&mut request) {
        Ok(payload) => payload,
        Err((status, error)) => {
            respond_json(request, status, json!({"error": error}));
            return;
        }
    };

    let result: Result<Value, String> = match (method.as_str(), path.as_str()) {
        ("POST", "/join") => cmd_join(app, &payload),
        ("POST", "/heartbeat") => cmd_heartbeat(app, &payload),
        ("POST", "/leave") => cmd_leave(app, &payload),
        ("POST", "/event") => cmd_event(app, &payload),
        ("POST", "/handover") => cmd_handover(app, &payload),
        ("POST", "/ctx") => cmd_ctx(app, &payload),
        ("GET", "/state") => cmd_state(app, &query),
        ("GET", "/feed") => cmd_feed(app, &query),
        ("POST", "/feed/search") => cmd_feed_search(app, &payload),
        ("POST", "/schedule") => cmd_schedule(app, &payload),
        ("POST", "/task") => cmd_task(app, &payload),
        ("POST", "/memory") => cmd_memory(app, &payload),
        ("POST", "/claim") => cmd_claim(app, &payload),
        ("POST", "/release") => cmd_release(app, &payload),
        ("POST", "/connect") => cmd_connect(app, &payload),
        ("POST", "/broadcast") => cmd_broadcast(app, &payload),
        ("GET", "/pending") => cmd_pending(app, &query),
        ("POST", "/broadcast/ack") => cmd_broadcast_ack(app, &payload),
        ("POST", "/charter") => cmd_charter(app, &payload),
        ("GET", "/inbox") => cmd_inbox(app, &query),
        ("POST", "/inbox/ack") => cmd_inbox_ack(app, &payload),
        ("POST", "/usage") => cmd_usage(app, &payload),
        ("POST", "/ask") => cmd_ask(app, &payload),
        ("POST", "/limits") => cmd_limits(app, &payload),
        ("GET", "/ask") => cmd_ask_status(app, &query),
        ("POST", "/ask/detach") => cmd_ask_detach(app, &payload),
        ("GET", "/skills") => Ok(json!({ "skills": crate::skills::catalog() })),
        _ => Err(format!("ruta desconocida: {} {}", method, path)),
    };

    match result {
        Ok(v) => respond_json(request, 200, v),
        Err(e) => respond_json(request, 400, json!({"error": e})),
    }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

fn cmd_join(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let name = payload["name"]
        .as_str()
        .unwrap_or("agente")
        .trim()
        .chars()
        .take(40)
        .collect::<String>();
    let project = payload["project"]
        .as_str()
        .unwrap_or("")
        .chars()
        .take(400)
        .collect::<String>();
    let pid = payload["pid"].as_u64().unwrap_or(0) as u32;

    let session_id = format!("s{}", &hub::random_token()[..10]);
    let sid = session_id.clone();

    hub::with_inner(app, |inner| {
        let now = hub::now_ms();
        let was_online = hub::is_online(inner, &name);
        hub::drop_dead_sessions(inner, &name, &project, &sid);
        inner.agents.insert(
            sid.clone(),
            hub::AgentInfo {
                session_id: sid.clone(),
                name: name.clone(),
                project: project.clone(),
                pid,
                last_seen_ms: now,
                model: None,
                ctx_tokens: None,
                ctx_window: None,
                ctx_ms: None,
                cli_session: None,
            },
        );
        let norm = project.replace('\\', "/");
        let short = norm.rsplit('/').next().unwrap_or("").to_string();
        let text = if short.is_empty() {
            "se conectó".to_string()
        } else {
            format!("se conectó · {}", short)
        };
        hub::push_event(inner, &name, &sid, "join", &text, vec![], None);
        // First real agent to join becomes the default leader until the user picks one.
        if inner.leader.is_none() && name != "agente" {
            inner.leader = Some(name.clone());
        }
        if !was_online {
            hub::remind_reviews(inner, &name);
        }
        hub::persist(inner);
    })
    .ok_or("hub no inicializado")?;

    hub::notify_ui();
    Ok(json!({ "session_id": session_id }))
}

fn cmd_heartbeat(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let sid = payload["session_id"].as_str().unwrap_or("").to_string();
    // `known: false` avisa al puente de que este hub no lo conoce (p. ej. lienzo se reinició):
    // el puente vuelve a unirse en vez de quedarse mudo con una sesión que ya no existe.
    let (known, rerouted) = hub::with_inner(app, |inner| {
        let known = inner.agents.contains_key(&sid);
        hub::touch_agent(inner, &sid);
        // Cada latido mira si alguna revisión del primer revisor debe volver al líder.
        let rerouted = hub::reroute_reviews(inner);
        if rerouted {
            hub::persist(inner);
        }
        (known, rerouted)
    })
    .ok_or("hub no inicializado")?;
    if rerouted {
        hub::notify_ui();
    }
    Ok(json!({ "ok": true, "known": known }))
}

fn cmd_leave(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let sid = payload["session_id"].as_str().unwrap_or("").to_string();
    hub::with_inner(app, |inner| {
        if let Some(agent) = inner.agents.remove(&sid) {
            hub::push_event(inner, &agent.name, &sid, "leave", "se desconectó", vec![], None);
            inner.claims.retain(|_, c| c.session_id != sid);
        }
        hub::persist(inner);
    })
    .ok_or("hub no inicializado")?;
    hub::notify_ui();
    Ok(json!({ "ok": true }))
}

fn cmd_event(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let sid = payload["session_id"].as_str().unwrap_or("").to_string();
    let out = hub::with_inner(app, |inner| {
        let (agent, sid) = hub::agent_label(inner, &sid, payload["agent"].as_str());
        let kind = payload["kind"].as_str().unwrap_or("update").to_string();
        // La respuesta final de un agente (kind «reply») va entera al chat.
        let cap = if kind == "reply" { 6000 } else { 2000 };
        let text: String = payload["text"]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(cap)
            .collect();
        let files: Vec<String> = payload["files"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .take(50)
                    .collect()
            })
            .unwrap_or_default();
        let to = hub::message_target(inner, payload["to"].as_str().map(|s| s.to_string()));
        let ev = hub::push_event(inner, &agent, &sid, &kind, &text, files, to.clone());
        // Quien manda un mensaje ya leyó lo anterior de su buzón (está contestando).
        if kind == "message"
            && let Some(reply_to) = payload["reply_to"].as_u64() {
                hub::inbox_ack(inner, &agent, reply_to);
            }
        let online = to.as_deref().map(|t| {
            let now = hub::now_ms();
            inner
                .agents
                .values()
                .any(|a| a.name.eq_ignore_ascii_case(t) && now.saturating_sub(a.last_seen_ms) < hub::AGENT_TTL_MS)
        });
        // Telemetría opcional del puente: modelo y uso de contexto reales.
        let model = payload["model"].as_str().map(|s| s.to_string());
        let ctx_tokens = payload["ctx_tokens"].as_u64();
        let ctx_window = payload["ctx_window"].as_u64();
        if model.is_some() || ctx_tokens.is_some() {
            hub::report_ctx(inner, &sid, &agent, model, ctx_tokens, ctx_window);
        }
        if let Some(cli) = payload["cli_session"].as_str().filter(|s| !s.is_empty() && s.len() < 100) {
            hub::report_cli_session(inner, &sid, &agent, cli);
        }
        hub::persist(inner);
        json!({ "seq": ev.seq, "to": to, "online": online })
    })
    .ok_or("hub no inicializado")?;
    hub::notify_ui();
    Ok(out)
}

/// Un agente pregunta al usuario (team_ask_user): sale un panel con opciones en el chat.
fn cmd_ask(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let sid = payload["session_id"].as_str().unwrap_or("").to_string();
    let items = hub::clean_questions(&payload["questions"])?;
    let context = payload["context"].as_str().unwrap_or("").to_string();
    let id = hub::with_inner(app, |inner| {
        let (agent, sid) = hub::agent_label(inner, &sid, payload["agent"].as_str());
        let id = hub::ask_user(inner, &agent, &sid, &context, items);
        hub::persist(inner);
        id
    })
    .ok_or("hub no inicializado")?;
    hub::notify_ui();
    Ok(json!({ "id": id }))
}

/// Límites de uso que manda el puente (la «status line» de Claude Code).
fn cmd_limits(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let agent = payload["agent"].as_str().unwrap_or("").to_string();
    let exact = payload["exact"].as_bool().unwrap_or(false);
    let changed = hub::with_inner(app, |inner| {
        let changed = hub::set_limits(inner, &agent, &payload["windows"], exact, "");
        if changed {
            hub::persist(inner);
        }
        changed
    })
    .ok_or("hub no inicializado")?;
    if changed {
        hub::notify_ui();
    }
    Ok(json!({ "ok": true }))
}

/// ¿Ya contestó? (la herramienta del agente lo consulta mientras espera)
fn cmd_ask_status(app: &AppHandle, query: &std::collections::HashMap<String, String>) -> Result<Value, String> {
    let id: u64 = query.get("id").and_then(|s| s.parse().ok()).ok_or("falta id")?;
    hub::with_inner(app, |inner| {
        let q = inner.questions.iter_mut().find(|q| q.id == id)?;
        // Sigue esperando: si deja de preguntar, la respuesta irá a su terminal.
        q.polled_ms = hub::now_ms();
        let done = q.answers.is_some() || q.dismissed;
        Some(json!({ "done": done, "text": if done { hub::format_answers(q) } else { String::new() } }))
    })
    .flatten()
    .ok_or_else(|| "esa pregunta ya no existe".to_string())
}

/// La herramienta deja de esperar: se lleva la respuesta si ya está; si no, irá a la terminal.
fn cmd_ask_detach(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let id = payload["id"].as_u64().ok_or("falta id")?;
    let text = hub::with_inner(app, |inner| {
        let t = hub::detach_question(inner, id);
        hub::persist(inner);
        t
    })
    .ok_or("hub no inicializado")?;
    Ok(json!({ "done": text.is_some(), "text": text.unwrap_or_default() }))
}

/// Buzón de un agente: sus mensajes sin leer. Con `ack=1` quedan leídos.
fn cmd_inbox(app: &AppHandle, query: &std::collections::HashMap<String, String>) -> Result<Value, String> {
    let agent = query.get("agent").cloned().unwrap_or_default();
    if agent.trim().is_empty() {
        return Ok(json!({ "messages": [], "unread": 0 }));
    }
    let ack = query.get("ack").map(|v| v == "1").unwrap_or(false);
    let out = hub::with_inner(app, |inner| {
        let list: Vec<Value> = hub::inbox_unread(inner, &agent)
            .into_iter()
            .map(|e| {
                // Un aviso de revisión lleva los cambios de la entrega (solo para el agente, no
                // para el chat de la app: por eso no van en el texto del evento).
                let diff = e
                    .task_id
                    .filter(|_| e.agent == "lienzo")
                    .and_then(|id| inner.tasks.iter().find(|t| t.id == id && t.status == "review"))
                    .and_then(|t| t.result.as_ref())
                    .map(|r| r.diff.clone())
                    .unwrap_or_default();
                json!({
                    "seq": e.seq,
                    "from": e.agent,
                    "to": e.to,
                    "text": e.text,
                    "ts_ms": e.ts_ms,
                    "diff": diff,
                })
            })
            .collect();
        let last = list.last().and_then(|m| m["seq"].as_u64()).unwrap_or(0);
        if ack && last > 0 {
            hub::inbox_ack(inner, &agent, last);
        }
        json!({ "unread": list.len(), "messages": list })
    })
    .ok_or("hub no inicializado")?;
    if ack {
        hub::notify_ui();
    }
    Ok(out)
}

fn cmd_inbox_ack(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let agent = payload["agent"].as_str().unwrap_or("").trim().to_string();
    let seq = payload["seq"].as_u64().unwrap_or(0);
    if agent.is_empty() {
        return Err("falta el agente".into());
    }
    hub::with_inner(app, |inner| hub::inbox_ack(inner, &agent, seq)).ok_or("hub no inicializado")?;
    hub::notify_ui();
    Ok(json!({ "ok": true }))
}

/// Consumo de tokens del agente: mensajes con su gasto (`items`) y/o tokens ahorrados (`saved`).
fn cmd_usage(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let sid = payload["session_id"].as_str().unwrap_or("").to_string();
    let items = payload["items"].as_array().cloned().unwrap_or_default();
    let saved = payload["saved"].as_u64().unwrap_or(0);
    hub::with_inner(app, |inner| {
        let (agent, _) = hub::agent_label(inner, &sid, payload["agent"].as_str());
        for it in items.iter().take(200) {
            hub::report_usage(
                inner,
                &agent,
                it["id"].as_str().unwrap_or(""),
                it["input"].as_u64().unwrap_or(0),
                it["output"].as_u64().unwrap_or(0),
                it["cache_read"].as_u64().unwrap_or(0),
                it["cache_write"].as_u64().unwrap_or(0),
            );
        }
        hub::report_saved(inner, &agent, saved);
        hub::persist(inner);
    })
    .ok_or("hub no inicializado")?;
    hub::notify_ui();
    Ok(json!({ "ok": true }))
}

/// Relevo con memoria: guarda el resumen pegado a la tarea y lo publica.
fn cmd_handover(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let sid = payload["session_id"].as_str().unwrap_or("").to_string();
    let task_id = payload["task_id"].as_u64().filter(|v| *v > 0);
    let summary: String = payload["summary"]
        .as_str()
        .unwrap_or("")
        .trim()
        .chars()
        .take(1500)
        .collect();
    if summary.is_empty() {
        return Err("el relevo necesita un resumen".into());
    }
    let files: Vec<String> = payload["files"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .take(60)
                .collect()
        })
        .unwrap_or_default();

    let out = hub::with_inner(app, |inner| {
        let (agent, sid) = hub::agent_label(inner, &sid, payload["agent"].as_str());
        let seq = hub::save_handover(inner, &agent, &sid, task_id, &summary, files);
        hub::persist(inner);
        json!({ "ok": true, "seq": seq })
    })
    .ok_or("hub no inicializado")?;
    hub::notify_ui();
    Ok(out)
}

/// Telemetría de contexto sin evento de feed (la usan los muestreadores del
/// puente para los CLIs sin hooks).
fn cmd_ctx(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let sid = payload["session_id"].as_str().unwrap_or("").to_string();
    let model = payload["model"].as_str().map(|s| s.to_string());
    let ctx_tokens = payload["ctx_tokens"].as_u64();
    let ctx_window = payload["ctx_window"].as_u64();
    if model.is_none() && ctx_tokens.is_none() {
        return Ok(json!({ "ok": false }));
    }
    let out = hub::with_inner(app, |inner| {
        let (agent, sid) = hub::agent_label(inner, &sid, payload["agent"].as_str());
        hub::report_ctx(inner, &sid, &agent, model, ctx_tokens, ctx_window);
        json!({ "ok": true })
    })
    .ok_or("hub no inicializado")?;
    hub::notify_ui();
    Ok(out)
}

/// Send a prompt to the whole team (feed event + pending hook deliveries).
fn cmd_broadcast(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let text: String = payload["text"]
        .as_str()
        .unwrap_or("")
        .trim()
        .chars()
        .take(4000)
        .collect();
    if text.is_empty() {
        return Err("el mensaje está vacío".into());
    }
    let out = hub::with_inner(app, |inner| {
        let ev = hub::broadcast(inner, &text);
        hub::persist(inner);
        json!({ "seq": ev.seq })
    })
    .ok_or("hub no inicializado")?;
    hub::notify_ui();
    Ok(out)
}

/// Broadcasts still pending for a hook session (checks session + agent marks).
fn cmd_pending(app: &AppHandle, query: &std::collections::HashMap<String, String>) -> Result<Value, String> {
    let agent = query.get("agent").cloned().unwrap_or_default();
    let session = query.get("session").cloned().unwrap_or_default();
    let list = hub::with_inner(app, |inner| {
        hub::pending_broadcasts(inner, &session, &agent)
            .into_iter()
            .map(|(seq, text)| json!({ "seq": seq, "text": text }))
            .collect::<Vec<Value>>()
    })
    .ok_or("hub no inicializado")?;
    Ok(json!({ "broadcasts": list }))
}

fn cmd_broadcast_ack(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let agent = payload["agent"].as_str().unwrap_or("").trim().to_string();
    let session = payload["session"].as_str().unwrap_or("").to_string();
    let seq = payload["seq"].as_u64().unwrap_or(0);
    hub::with_inner(app, |inner| {
        if !agent.is_empty() {
            hub::ack_broadcast(inner, &format!("agent:{}", agent), seq);
        }
        if !session.is_empty() {
            hub::ack_broadcast(inner, &format!("session:{}", session), seq);
        }
    })
    .ok_or("hub no inicializado")?;
    Ok(json!({ "ok": true }))
}

/// Set the team charter and/or leader from scripts (the UI uses a Tauri command).
fn cmd_charter(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    hub::with_inner(app, |inner| {
        if let Some(c) = payload.get("charter") {
            inner.charter = c
                .as_str()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
        }
        if let Some(l) = payload.get("leader") {
            inner.leader = l
                .as_str()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
        }
        hub::persist(inner);
    })
    .ok_or("hub no inicializado")?;
    hub::notify_ui();
    Ok(json!({ "ok": true }))
}

fn cmd_state(app: &AppHandle, query: &std::collections::HashMap<String, String>) -> Result<Value, String> {
    let limit = query
        .get("limit")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(200)
        .min(500);
    hub::with_inner(app, |inner| hub::snapshot(inner, limit)).ok_or("hub no inicializado".into())
}

/// Tareas programadas: `create` (queda pendiente de tu OK) o `list`.
fn cmd_schedule(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let sid = payload["session_id"].as_str().unwrap_or("").to_string();
    let out = hub::with_inner(app, |inner| -> Result<Value, String> {
        let (agent, sid) = hub::agent_label(inner, &sid, payload["agent"].as_str());
        match payload["op"].as_str().unwrap_or("") {
            "create" => {
                let s = hub::schedule::create(
                    inner,
                    &agent,
                    &sid,
                    payload["title"].as_str().unwrap_or(""),
                    payload["notes"].as_str().unwrap_or(""),
                    payload["every"].as_str().unwrap_or(""),
                    payload["assign"].as_str().unwrap_or(""),
                    payload["level"].as_str().unwrap_or(""),
                    payload["model"].as_str().unwrap_or(""),
                    payload["daily_cap"].as_u64().unwrap_or(0) as u32,
                )?;
                hub::persist(inner);
                Ok(json!({ "schedule": s }))
            }
            "list" => Ok(json!({ "schedules": inner.schedules })),
            other => Err(format!("operación desconocida: {other}")),
        }
    })
    .ok_or("hub no inicializado")??;
    hub::notify_ui();
    Ok(out)
}

/// Busca en todo el historial del proyecto (el feed vivo y su archivo), no solo en lo último.
fn cmd_feed_search(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let query = payload["query"].as_str().unwrap_or("");
    let agent = payload["agent"].as_str().unwrap_or("");
    let limit = payload["limit"].as_u64().unwrap_or(20).clamp(1, 50) as usize;
    let events = hub::with_inner(app, |inner| hub::search_feed(inner, query, agent, limit)).ok_or("hub no inicializado")?;
    Ok(json!({ "events": events }))
}

fn cmd_feed(app: &AppHandle, query: &std::collections::HashMap<String, String>) -> Result<Value, String> {
    let since = query
        .get("since_seq")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let limit = query
        .get("limit")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(50)
        .min(200);
    let quiet = query.get("quiet").map(|v| v == "1").unwrap_or(false);
    let out = hub::with_inner(app, |inner| {
        let noise = |e: &&hub::Event| {
            quiet && matches!(e.kind.as_str(), "join" | "leave" | "session" | "stop" | "prompt" | "tool")
        };
        let mut events: Vec<&hub::Event> = inner
            .events
            .iter()
            .filter(|e| e.seq > since && !noise(e))
            .collect();
        // Sin `since_seq` interesa lo último, no lo más antiguo que quede guardado.
        if since == 0 && events.len() > limit {
            events.drain(..events.len() - limit);
        }
        events.truncate(limit);
        json!({ "events": events, "seq": inner.seq })
    })
    .ok_or("hub no inicializado")?;
    Ok(out)
}

/// Rutas de una carpeta aislada pasadas a las del proyecto (para el feed y la entrega).
struct WsPaths {
    ws: String,
    root: String,
}

impl WsPaths {
    fn map_path(&self, f: &str) -> String {
        let norm = |s: &str| s.replace('/', "\\").to_lowercase();
        let (f_n, ws_n) = (norm(f), norm(self.ws.trim_end_matches(['\\', '/'])));
        if f_n.starts_with(&ws_n) && f.len() >= self.ws.trim_end_matches(['\\', '/']).len() {
            let rest = &f[self.ws.trim_end_matches(['\\', '/']).len()..];
            format!("{}{}", self.root.trim_end_matches(['\\', '/']), rest)
        } else {
            f.to_string()
        }
    }
}

enum IsoStep {
    /// Entregada para revisión: aún no se une; el líder ve el diff de la copia.
    Review { diff: String, files: WsPaths },
    /// Unida al proyecto: rutas absolutas que cambiaron.
    Merged { project: String, files: Vec<String> },
}

/// Lo que toca hacer con la carpeta aislada de la tarea al entregarla o al decidir sobre ella.
/// Lo que el camino normal rechazaría (entrega ajena, sin resumen, revisión de quien no lidera) no
/// se une: se deja pasar para que dé su error de siempre.
fn merge_done_if_valid(
    tasks: &[hub::Task],
    task: &hub::Task,
    agent: &str,
    summary: &str,
    merge: impl FnOnce() -> Result<Vec<String>, String>,
) -> Result<Vec<String>, String> {
    if task.status != "claimed" {
        return Err(format!("la tarea #{} no está tomada (estado: {})", task.id, task.status));
    }
    if task.owner != agent {
        return Err(format!("la tarea #{} es de {}; no la cierres tú", task.id, task.owner));
    }
    if summary.is_empty() {
        return Err("cierra la tarea con una entrega: pasa `summary`, `files` y `evidence`".into());
    }
    let unmet = hub::unmet_parents(tasks, task);
    if !unmet.is_empty() {
        let ids = unmet.iter().map(|p| format!("#{p}")).collect::<Vec<_>>().join(", ");
        return Err(format!("la tarea #{} depende de {ids} que aún no está hecha", task.id));
    }
    merge()
}

/// Valida y fusiona bajo el mismo cerrojo del hub que confirma la entrega.
fn isolated_step(inner: &hub::HubInner, op: &str, id: u64, sid: &str, payload: &Value, summary: &str) -> Result<Option<IsoStep>, String> {
    let (agent, _) = hub::agent_label(inner, sid, payload["agent"].as_str());
    let Some(t) = inner.tasks.iter().find(|t| t.id == id) else {
        return Ok(None);
    };
    if t.workspace.is_empty() {
        return Ok(None);
    }
    let Some(project) = inner.project.clone() else {
        return Ok(None);
    };
    let ws = t.workspace.clone();
    let reviewer = t.research.is_empty() && hub::reviewer_for(inner, &agent).is_some();
    let leads = agent == "tú"
        || inner.leader.as_deref().is_some_and(|l| l.eq_ignore_ascii_case(&agent))
        || (!t.reviewer.is_empty() && t.reviewer.eq_ignore_ascii_case(&agent));
    if op == "done" {
        if reviewer {
            merge_done_if_valid(&inner.tasks, t, &agent, summary, || Ok(Vec::new()))?;
            let diff = crate::workspace::diff(&project, id, 6000).unwrap_or_default();
            return Ok(Some(IsoStep::Review { diff, files: WsPaths { ws, root: project } }));
        }
        let files = merge_done_if_valid(&inner.tasks, t, &agent, summary, || hub::merge_workspace(&project, id, &ws))?;
        return Ok(Some(IsoStep::Merged { project, files }));
    }
    let verdict = payload["verdict"].as_str().unwrap_or("").trim().to_lowercase();
    if !leads || t.status != "review" || !matches!(verdict.as_str(), "ok" | "aprobar" | "aprobada") {
        return Ok(None);
    }
    let files = hub::merge_workspace(&project, id, &ws).map_err(|e| {
        format!("No se puede aprobar aún: {e} Devuélvela con verdict «fix» para que su dueño lo resuelva.")
    })?;
    Ok(Some(IsoStep::Merged { project, files }))
}

/// Al tomar una tarea con las carpetas aisladas activadas: su copia del proyecto (la crea la primera
/// vez; si ya la tenía, de un traspaso o una corrección, la misma). None si no toca.
fn claim_workspace(app: &AppHandle, id: u64) -> Option<Result<String, String>> {
    let (project, existing, wanted) = hub::with_inner(app, |inner| {
        let t = inner.tasks.iter().find(|t| t.id == id)?;
        Some((inner.project.clone()?, t.workspace.clone(), inner.isolate && t.research.is_empty()))
    })
    .flatten()?;
    if !existing.is_empty() && crate::workspace::exists(&project, id) {
        return Some(Ok(existing));
    }
    if !wanted {
        return None;
    }
    let made = crate::workspace::create(&project, id);
    if let Ok(ws) = &made {
        hub::with_inner(app, |inner| {
            if let Some(t) = inner.tasks.iter_mut().find(|t| t.id == id) {
                t.workspace = ws.clone();
            }
            hub::persist(inner);
        });
    }
    Some(made)
}

fn cmd_task(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let op = payload["op"].as_str().unwrap_or("").to_string();
    let sid = payload["session_id"].as_str().unwrap_or("").to_string();
    let id = payload["id"].as_u64().unwrap_or(0);
    let title: String = hub::redact::redact(payload["title"].as_str().unwrap_or("").trim()).chars().take(200).collect();
    // Las notas son el encargo completo (objetivo, archivos, criterio de hecho…). Sin secretos:
    // el tablero se guarda en disco y lo leen todos.
    let notes: String = hub::redact::redact(payload["notes"].as_str().unwrap_or("")).chars().take(4000).collect();
    let parents_in: Vec<u64> = payload["parents"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_u64()).collect())
        .unwrap_or_default();
    // Entrega al cerrar: resumen (o las notas de siempre), archivos y evidencia.
    let summary: String = hub::redact::redact(
        payload["summary"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(payload["notes"].as_str().unwrap_or(""))
            .trim(),
    )
    .chars()
    .take(1500)
    .collect();
    let evidence: String = hub::redact::redact(payload["evidence"].as_str().unwrap_or("").trim()).chars().take(500).collect();
    let mut files_in: Vec<String> = payload["files"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.chars().take(260).collect::<String>())
                .take(40)
                .collect()
        })
        .unwrap_or_default();

    let out = hub::with_inner(app, |inner| -> Result<Value, String> {
        // Validación, fusión y confirmación comparten el cerrojo del hub.
        let iso = if matches!(op.as_str(), "done" | "review") {
            isolated_step(inner, &op, id, &sid, payload, &summary)?
        } else {
            None
        };
        let (ws_diff, merged) = match iso {
            Some(IsoStep::Review { diff, files }) => {
                files_in = files_in.iter().map(|f| files.map_path(f)).collect();
                (Some(diff), None)
            }
            Some(IsoStep::Merged { project, files }) => {
                files_in = files.clone();
                (None, Some((project, files)))
            }
            None => (None, None),
        };
        let (agent, sid) = hub::agent_label(inner, &sid, payload["agent"].as_str());
        match op.as_str() {
            "create" => {
                if title.is_empty() {
                    return Err("la tarea necesita un título".into());
                }
                let parents = hub::check_parents(&inner.tasks, &parents_in)?;
                inner.task_seq += 1;
                let mut task = hub::Task::new(inner.task_seq, title.clone(), notes, parents);
                task.level = hub::task_level(payload["level"].as_str().unwrap_or(""));
                task.assign = hub::resolve_agent(inner, payload["assign"].as_str().unwrap_or(""));
                // Modo plan: la tarea espera tu aprobación antes de que nadie la empiece.
                if inner.plan_hold {
                    task.status = "plan".into();
                }
                inner.tasks.push(task.clone());
                let mut text = format!("#{} creada: {}", task.id, title);
                if !task.parents.is_empty() {
                    let ids = task.parents.iter().map(|p| format!("#{p}")).collect::<Vec<_>>().join(", ");
                    text.push_str(&format!(" (depende de {ids})"));
                }
                if !task.assign.is_empty() {
                    text.push_str(&format!(" → {}", task.assign));
                }
                hub::push_event(inner, &agent, &sid, "task", &text, vec![], None);
                hub::persist(inner);
                if task.status == "plan" {
                    return Ok(json!({
                        "task": task,
                        "note": "Modo plan: la tarea espera la aprobación del usuario; nadie la empieza hasta entonces.",
                    }));
                }
                Ok(json!({ "task": task }))
            }
            "comment" => {
                let text = payload["text"].as_str().unwrap_or("");
                let c = hub::add_task_comment(inner, id, &agent, &sid, text)?;
                hub::persist(inner);
                Ok(json!({ "comment": c }))
            }
            "brief" => {
                let msg = hub::brief_task(
                    inner,
                    id,
                    &agent,
                    &sid,
                    &notes,
                    payload["level"].as_str().unwrap_or(""),
                    payload["assign"].as_str().unwrap_or(""),
                )?;
                hub::persist(inner);
                Ok(json!({ "ok": msg }))
            }
            "handoff" => {
                let msg = hub::handoff_task(
                    inner,
                    id,
                    &agent,
                    &sid,
                    payload["assign"].as_str().unwrap_or(""),
                    payload["notes"].as_str().unwrap_or(""),
                )?;
                hub::persist(inner);
                Ok(json!({ "ok": msg }))
            }
            "plan_approve" => {
                // Solo el líder, y solo si el usuario habló después de que se propusiera el plan
                // (su «sí», «dale» o «sigue»): un agente no se aprueba su propio plan.
                if !inner.leader.as_deref().is_some_and(|l| l.eq_ignore_ascii_case(&agent)) {
                    return Err("solo el líder aprueba el plan, y solo cuando el usuario lo dice".into());
                }
                let first = inner.tasks.iter().filter(|t| t.status == "plan").map(|t| t.created_ms).min();
                let Some(first) = first else {
                    return Err("no hay ningún plan esperando aprobación".into());
                };
                let user_spoke = inner
                    .events
                    .iter()
                    .any(|e| e.agent == "tú" && e.ts_ms > first && matches!(e.kind.as_str(), "message" | "broadcast" | "answer"));
                if !user_spoke {
                    return Err("el usuario aún no ha contestado al plan: espera su aprobación".into());
                }
                let ids = hub::approve_plan(inner, &agent, &sid);
                hub::persist(inner);
                Ok(json!({ "ok": format!("Plan aprobado: {} tareas listas para repartir.", ids.len()) }))
            }
            "review" => {
                let verdict = payload["verdict"].as_str().unwrap_or("");
                hub::set_focus(inner, &agent, id);
                let mut msg = hub::review_task(inner, id, &agent, &sid, verdict, payload["notes"].as_str().unwrap_or(""))?;
                if let Some(task) = inner.tasks.iter_mut().find(|t| t.id == id) {
                    if let Some((project, files)) = merged.clone() {
                        // Aprobada: lo de la copia ya está en el proyecto.
                        task.workspace = String::new();
                        let (title, by) = (task.title.clone(), task.owner.clone());
                        hub::after_merge(project, id, title, by, files);
                    } else if !task.workspace.is_empty() && task.owner == agent {
                        msg.push_str(&format!(" Trabaja en su carpeta aislada: {}", task.workspace));
                    }
                }
                hub::persist(inner);
                Ok(json!({ "ok": msg }))
            }
            "claim" | "done" | "reopen" => {
                let Some(pos) = inner.tasks.iter().position(|t| t.id == id) else {
                    return Err("tarea no encontrada".into());
                };
                let snapshot = inner.tasks[pos].clone();
                let unmet = hub::unmet_parents(&inner.tasks, &snapshot);
                let fmt_ids = |v: &[u64]| v.iter().map(|p| format!("#{p}")).collect::<Vec<_>>().join(", ");

                // Un solo ganador: no se pisa la tarea de otro ni se reabre una hecha.
                match op.as_str() {
                    "claim" => {
                        if snapshot.status == "done" {
                            return Err(format!("la tarea #{id} ya está hecha"));
                        }
                        if snapshot.status == "review" {
                            return Err(format!("la tarea #{id} está en revisión; espera la decisión"));
                        }
                        if snapshot.status == "plan" {
                            return Err(format!(
                                "la tarea #{id} es parte de un plan que el usuario aún no aprueba: no empieces hasta su OK"
                            ));
                        }
                        // Modo director: con una entrega tuya en revisión, espera el veredicto (puede
                        // volverte para corregir) en vez de empezar otra por delante.
                        if let Some(r) = inner
                            .tasks
                            .iter()
                            .find(|t| t.status == "review" && t.owner == agent && t.id != id)
                        {
                            return Err(format!(
                                "tu entrega #{} está en revisión del líder: espera su veredicto antes de tomar otra (acaba tu turno; lienzo te avisará)",
                                r.id
                            ));
                        }
                        if snapshot.status == "draft" {
                            return Err(format!("la tarea #{id} aún no tiene encargo: espera a que el líder lo escriba"));
                        }
                        if snapshot.status == "claimed" && !snapshot.owner.is_empty() && snapshot.owner != agent {
                            return Err(format!(
                                "la tarea #{id} ya está en manos de {}; elige otra o coordínate con esa persona",
                                snapshot.owner
                            ));
                        }
                        if !unmet.is_empty() {
                            return Err(format!(
                                "la tarea #{id} está bloqueada: espera a {}. Haz primero esas o elige otra tarea lista",
                                fmt_ids(&unmet)
                            ));
                        }
                    }
                    "done" => {
                        if snapshot.status == "review" {
                            return Err(format!("la tarea #{id} ya está entregada y en revisión; espera las órdenes del líder"));
                        }
                        if snapshot.status == "claimed" && !snapshot.owner.is_empty() && snapshot.owner != agent {
                            return Err(format!("la tarea #{id} es de {}; no la cierres tú", snapshot.owner));
                        }
                        if !unmet.is_empty() {
                            return Err(format!(
                                "la tarea #{id} depende de {} que aún no está hecha",
                                fmt_ids(&unmet)
                            ));
                        }
                        if summary.is_empty() {
                            return Err(
                                "cierra la tarea con una entrega: pasa `summary` (qué hiciste y qué decidiste), `files` (qué tocaste) y `evidence` (cómo lo comprobaste)"
                                    .into(),
                            );
                        }
                    }
                    _ => {}
                }

                // Modo director: la entrega de un trabajador espera la revisión del líder.
                // Las de una investigación no: ya tienen su verificación (y gastaría cuota del líder).
                let reviewer = if op == "done" && inner.tasks[pos].research.is_empty() {
                    hub::reviewer_for_task(inner, &agent, id)
                } else {
                    None
                };
                // Lo que verá el líder: los cambios frente a la copia de cada archivo al reservarlo.
                let diff = match (&reviewer, &ws_diff) {
                    // Con carpeta aislada, lo que cambió en la copia frente a su base.
                    (Some(_), Some(d)) => d.clone(),
                    (Some(_), None) => hub::delivery_diff(inner, &files_in),
                    _ => String::new(),
                };
                if op == "done" && reviewer.is_none() {
                    hub::drop_bases(inner, &files_in);
                }
                {
                    let task = &mut inner.tasks[pos];
                    match op.as_str() {
                        "claim" => {
                            task.status = "claimed".into();
                            task.owner = agent.clone();
                        }
                        "done" => {
                            task.status = if reviewer.is_some() { "review" } else { "done" }.into();
                            task.owner = agent.clone();
                            // `notes` aquí es el alias antiguo de summary: el encargo no se toca.
                            task.result = Some(hub::TaskResult {
                                summary: summary.clone(),
                                files: files_in.clone(),
                                evidence: evidence.clone(),
                                by: agent.clone(),
                                ts_ms: hub::now_ms(),
                                diff,
                            });
                            // Ya unida al proyecto: la copia sobra (se borra tras guardar el historial).
                            if merged.is_some() {
                                task.workspace = String::new();
                            }
                        }
                        _ => {
                            task.status = "open".into();
                            task.owner = String::new();
                            task.result = None;
                            task.fix_rounds = 0;
                        }
                    }
                }
                if op != "reopen" {
                    hub::set_focus(inner, &agent, id);
                }
                let task = inner.tasks[pos].clone();
                let (text, ev_files) = if op == "done" {
                    let verb = if reviewer.is_some() { "entregada" } else { "hecha" };
                    (
                        format!(
                            "#{} {verb} por {}: {}",
                            task.id,
                            agent,
                            // Entero (ya viene acotado): el chat lo pliega y el puente lo recorta para los agentes.
                            summary
                        ),
                        files_in.clone(),
                    )
                } else {
                    let verb = match task.status.as_str() {
                        "claimed" => "tomada",
                        "open" => "liberada",
                        other => other,
                    };
                    (format!("#{} {} por {}", task.id, verb, agent), vec![])
                };
                hub::push_event(inner, &agent, &sid, "task", &text, ev_files, None);
                // Historial: copia de sus archivos tal como los entrega (para verlos y deshacerlos).
                // Con carpeta aislada lo guarda `after_merge` al unirla (y en revisión aún no se unió).
                if op == "done" && ws_diff.is_none() && merged.is_none()
                    && let Some(project) = inner.project.clone() {
                        let title = if task.fix_rounds > 0 {
                            format!("{} · corrección {}", task.title, task.fix_rounds)
                        } else {
                            task.title.clone()
                        };
                        let (tid, by, files) = (task.id, agent.clone(), files_in.clone());
                        std::thread::spawn(move || {
                            if let Err(e) = crate::history::record(&project, tid, &title, &by, &files) {
                                crate::errlog::log("historial", &format!("No se guardó la entrega de #{tid} en el historial"), &e);
                            }
                        });
                    }
                if let Some(leader) = &reviewer {
                    hub::ask_review(inner, task.id, leader);
                }
                if let (true, Some((project, files))) = (op == "done", merged.clone()) {
                    let title = if task.fix_rounds > 0 {
                        format!("{} · corrección {}", task.title, task.fix_rounds)
                    } else {
                        task.title.clone()
                    };
                    hub::after_merge(project, task.id, title, agent.clone(), files);
                }
                hub::persist(inner);

                // Al reclamar, el agente recibe las entregas de las tareas de las que depende.
                let parents_results: Vec<Value> = if op == "claim" {
                    task.parents
                        .iter()
                        .filter_map(|p| inner.tasks.iter().find(|t| t.id == *p))
                        .filter_map(|t| {
                            t.result.as_ref().map(|r| {
                                json!({
                                    "id": t.id,
                                    "title": t.title,
                                    "by": r.by,
                                    "summary": r.summary,
                                    "files": r.files,
                                    "evidence": r.evidence,
                                })
                            })
                        })
                        .collect()
                } else {
                    vec![]
                };
                Ok(json!({
                    "task": task,
                    "parents_results": parents_results,
                    "comments": task.comments,
                    "reviewer": reviewer,
                }))
            }
            "list" => Ok(json!({ "tasks": inner.tasks })),
            _ => Err("operación de tarea desconocida".into()),
        }
    })
    .ok_or("hub no inicializado")??;
    let mut out = out;
    if op == "claim" {
        match claim_workspace(app, id) {
            Some(Ok(ws)) => {
                let root = hub::with_inner(app, |i| i.project.clone()).flatten().unwrap_or_default();
                out["workspace"] = json!(ws);
                out["project_root"] = json!(root);
            }
            Some(Err(e)) => out["workspace_error"] = json!(e),
            None => {}
        }
    }
    hub::notify_ui();
    Ok(out)
}

/// Memoria del proyecto: el líder (o tú) la cura; los demás proponen y el líder decide.
fn cmd_memory(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let op = payload["op"].as_str().unwrap_or("").to_string();
    let sid = payload["session_id"].as_str().unwrap_or("").to_string();
    let text = payload["text"].as_str().unwrap_or("").to_string();
    let kind = payload["kind"].as_str().unwrap_or("hecho").to_string();
    let id = payload["id"].as_u64().unwrap_or(0);
    let accept = payload["accept"].as_bool().unwrap_or(true);

    let out = hub::with_inner(app, |inner| -> Result<Value, String> {
        let (agent, _sid) = hub::agent_label(inner, &sid, payload["agent"].as_str());
        let curator = hub::can_curate(inner, &agent);
        let leader = inner.leader.clone().unwrap_or_default();
        let need_leader = |what: &str| -> String {
            format!("solo el líder ({leader}) puede {what}; propón con team_memory_propose y él decidirá")
        };
        let result = match op.as_str() {
            "list" => Ok(json!({ "memory": inner.memory })),
            "propose" => {
                // El líder (o tú) no necesita pasar por propuesta: se guarda directo.
                let entry = hub::memory_add(inner, &agent, &text, &kind, curator)?;
                Ok(json!({ "entry": entry, "saved": curator }))
            }
            "save" => {
                if !curator {
                    return Err(need_leader("guardar memoria"));
                }
                let entry = hub::memory_add(inner, &agent, &text, &kind, true)?;
                Ok(json!({ "entry": entry, "saved": true }))
            }
            "resolve" => {
                if !curator {
                    return Err(need_leader("aceptar o descartar propuestas"));
                }
                let new_text = Some(text.as_str()).filter(|t| !t.trim().is_empty());
                hub::memory_resolve(inner, id, accept, new_text, &agent)?;
                Ok(json!({ "ok": true }))
            }
            "forget" => {
                if !curator {
                    return Err(need_leader("olvidar entradas"));
                }
                hub::memory_forget(inner, id, &agent)?;
                Ok(json!({ "ok": true }))
            }
            _ => Err("operación de memoria desconocida".into()),
        };
        if result.is_ok() && op != "list" {
            hub::persist(inner);
        }
        result
    })
    .ok_or("hub no inicializado")??;
    hub::notify_ui();
    Ok(out)
}

/// Ruta completa: con unidad (`C:\…`, `C:/…`), de red (`\\servidor\…`) o de Unix (`/…`).
fn is_absolute_path(p: &str) -> bool {
    let p = p.trim();
    let b = p.as_bytes();
    (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'\\' | b'/'))
        || p.starts_with("\\\\")
        || p.starts_with('/')
}

fn cmd_claim(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let sid = payload["session_id"].as_str().unwrap_or("").to_string();
    let files: Vec<String> = payload["files"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .take(100)
                .collect()
        })
        .unwrap_or_default();

    let out = hub::with_inner(app, |inner| {
        let (agent, sid) = hub::agent_label(inner, &sid, payload["agent"].as_str());
        let now = hub::now_ms();
        let mut granted: Vec<String> = vec![];
        let mut conflicts: Vec<Value> = vec![];
        let mut relative: Vec<String> = vec![];
        for f in &files {
            // Cada CLI tiene su carpeta de trabajo: «revision/arbol.md» puede ser cualquiera de
            // varias carpetas y no chocaría con la misma reserva escrita con su ruta completa.
            if !is_absolute_path(f) {
                relative.push(f.clone());
                continue;
            }
            let key = hub::claim_key(f);
            let taken = inner.claims.get(&key).filter(|c| {
                c.session_id != sid && inner.agents.contains_key(&c.session_id)
            });
            if let Some(c) = taken {
                conflicts.push(json!({ "path": f, "agent": c.agent, "since_ms": c.ts_ms }));
                continue;
            }
            inner.claims.insert(
                key,
                hub::Claim {
                    path: f.clone(),
                    session_id: sid.clone(),
                    agent: agent.clone(),
                    ts_ms: now,
                },
            );
            granted.push(f.clone());
        }
        if !granted.is_empty() {
            let short: Vec<String> = granted.iter().take(4).map(|s| short_name(s)).collect();
            let extra = if granted.len() > 4 { "…" } else { "" };
            let text = format!(
                "reservó {} archivo(s): {}{}",
                granted.len(),
                short.join(", "),
                extra
            );
            hub::push_event(inner, &agent, &sid, "claim", &text, granted.clone(), None);
            hub::snapshot_bases(inner, &granted);
            hub::persist(inner);
        }
        json!({ "granted": granted, "conflicts": conflicts, "relative": relative })
    })
    .ok_or("hub no inicializado")?;
    if out["granted"].as_array().map(|a| !a.is_empty()).unwrap_or(false) {
        hub::notify_ui();
    }
    Ok(out)
}

fn cmd_release(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let sid = payload["session_id"].as_str().unwrap_or("").to_string();
    let files: Vec<String> = payload["files"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .take(100)
                .collect()
        })
        .unwrap_or_default();

    let released = hub::with_inner(app, |inner| {
        let (agent, sid) = hub::agent_label(inner, &sid, payload["agent"].as_str());
        let mut released: Vec<String> = vec![];
        for f in &files {
            let key = hub::claim_key(f);
            let owned = inner
                .claims
                .get(&key)
                .map(|c| c.session_id == sid)
                .unwrap_or(false);
            if owned {
                inner.claims.remove(&key);
                released.push(f.clone());
            }
        }
        if !released.is_empty() {
            let text = format!("liberó {} archivo(s)", released.len());
            hub::push_event(inner, &agent, &sid, "claim", &text, released.clone(), None);
            hub::persist(inner);
        }
        json!({ "released": released })
    })
    .ok_or("hub no inicializado")?;
    if released["released"].as_array().map(|a| !a.is_empty()).unwrap_or(false) {
        hub::notify_ui();
    }
    Ok(released)
}

/// Connect an agent to the team by writing its config (scripts/CLI friendly).
fn cmd_connect(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let agent = payload["agent"].as_str().unwrap_or("").to_string();
    let project = payload["project"].as_str().unwrap_or("").trim().to_string();
    if project.is_empty() {
        return Err("falta el campo project".into());
    }
    let path = std::path::PathBuf::from(&project);
    if !path.is_dir() {
        return Err(format!("la carpeta no existe: {}", path.display()));
    }
    let (files, notes) = crate::hub::connectors::connect_agent(&agent, &path)?;

    // Solo si aún no hay proyecto: conectar un agente no debe cambiar el proyecto abierto (y si
    // hay que cambiarlo, con switch_project, que guarda lo del anterior y trae lo del nuevo).
    let changed = hub::with_inner(app, |inner| {
        if inner.project.is_none() {
            hub::switch_project(inner, Some(project.clone()));
            hub::persist(inner);
            true
        } else {
            false
        }
    })
    .unwrap_or(false);
    if changed {
        hub::notify_ui();
    }

    Ok(json!({ "files": files, "notes": notes }))
}

/// "C:\a\b\src\main.rs" -> "src/main.rs" (for compact feed text)
fn short_name(path: &str) -> String {
    let norm = path.replace('\\', "/");
    let parts: Vec<&str> = norm.split('/').filter(|s| !s.is_empty()).collect();
    let n = parts.len();
    if n >= 2 {
        format!("{}/{}", parts[n - 2], parts[n - 1])
    } else {
        norm
    }
}


#[cfg(test)]
mod tests {
    #[test]
    fn same_token_compares_whole_token() {
        assert!(super::same_token("abc123", "abc123"));
        assert!(!super::same_token("abc124", "abc123"));
        assert!(!super::same_token("abc12", "abc123"));
        assert!(!super::same_token("abc1234", "abc123"));
        assert!(!super::same_token("", "abc123"));
    }

    use super::{is_absolute_path, WsPaths};

    #[test]
    fn peticion_lenta_no_bloquea_health_ni_otra_peticion() {
        use std::io::{Read, Write};
        use std::sync::{mpsc, Arc};
        use std::time::Duration;

        fn get(port: u16, path: &str) -> std::io::Result<String> {
            let mut stream = std::net::TcpStream::connect(("127.0.0.1", port))?;
            stream.set_read_timeout(Some(Duration::from_secs(2)))?;
            write!(stream, "GET {path} HTTP/1.0\r\nHost: localhost\r\n\r\n")?;
            let mut response = String::new();
            stream.read_to_string(&mut response)?;
            Ok(response)
        }

        let server = Arc::new(tiny_http::Server::http("127.0.0.1:0").unwrap());
        let port = server.server_addr().to_ip().unwrap().port();
        let (started_tx, started_rx) = mpsc::channel();
        let serving = server.clone();
        let server_thread = std::thread::spawn(move || {
            super::serve_with(serving, move |mut request| {
                if request.url() == "/slow" {
                    started_tx.send(()).unwrap();
                    let mut body = Vec::new();
                    let _ = request.as_reader().read_to_end(&mut body);
                }
                let _ = request.respond(tiny_http::Response::from_string("ready"));
            });
        });
        let mut slow = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        slow.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        // tiny_http precarga cuerpos de hasta 1024 bytes; uno mayor deja la lectura al handler.
        write!(slow, "POST /slow HTTP/1.0\r\nHost: localhost\r\nContent-Length: 2048\r\n\r\nx").unwrap();
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let health = get(port, "/health");
        let fast = get(port, "/fast");
        slow.shutdown(std::net::Shutdown::Write).unwrap();
        let mut slow_response = String::new();
        let _ = slow.read_to_string(&mut slow_response);
        server.unblock();
        server_thread.join().unwrap();
        assert!(health.unwrap().contains("ready"), "/health debe responder mientras /slow espera");
        assert!(fast.unwrap().contains("ready"), "otra petición debe responder mientras /slow espera");
        assert!(slow_response.contains("ready"));
    }

    #[test]
    fn cuerpo_del_hub_tiene_limite_de_un_megabyte() {
        let mut huge = std::io::Cursor::new(vec![b' '; super::MAX_BODY_BYTES + 1]);
        assert_eq!(super::parse_payload(&mut huge).unwrap_err().0, 413);
        let mut normal = std::io::Cursor::new(br#"{"ok":true}"#);
        assert_eq!(super::parse_payload(&mut normal).unwrap()["ok"], true);
    }

    #[test]
    fn blocked_isolated_delivery_never_writes_project() {
        let root = std::env::temp_dir().join(format!("lienzo-blocked-delivery-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let project_file = root.join("proyecto.txt");
        std::fs::write(&project_file, b"original").unwrap();
        let mut parent = crate::hub::Task::new(1, "padre".into(), String::new(), vec![]);
        parent.status = "claimed".into();
        let mut child = crate::hub::Task::new(2, "hija".into(), String::new(), vec![1]);
        child.status = "claimed".into();
        child.owner = "codex".into();
        let tasks = [parent, child];
        let result = super::merge_done_if_valid(&tasks, &tasks[1], "codex", "entrega", || {
            std::fs::write(&project_file, b"cambio").unwrap();
            Ok(vec![])
        });
        assert!(result.unwrap_err().contains("#1"));
        assert_eq!(std::fs::read(&project_file).unwrap(), b"original");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn workspace_paths_map_back_to_the_project() {
        let m = WsPaths { ws: r"C:\p\.lienzo\tareas\7".into(), root: r"C:\p".into() };
        assert_eq!(m.map_path(r"C:\p\.lienzo\tareas\7\src\a.md"), r"C:\p\src\a.md");
        assert_eq!(m.map_path("c:/p/.lienzo/tareas/7/src/a.md"), r"C:\p/src/a.md");
        assert_eq!(m.map_path(r"C:\otro\x.md"), r"C:\otro\x.md", "lo de fuera se queda igual");
    }

    #[test]
    fn claims_need_full_paths() {
        for p in [r"C:\Users\x\revision\arbol.md", "c:/a/b.md", r"\\nas\share\a.md", "/home/a.md"] {
            assert!(is_absolute_path(p), "{p}");
        }
        for p in ["revision/arbol.md", r"propuestas\hermes\a.md", "./a.md", "C:", "C:a.md", ""] {
            assert!(!is_absolute_path(p), "{p}");
        }
    }
}

