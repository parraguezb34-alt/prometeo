//! Local HTTP API of the team hub (used by `lienzo-mcp.exe`, hook scripts and
//! anything else that wants to talk to the team).
//!
//! Bound to 127.0.0.1 on a random port; every request needs the session token
//! (written to `%APPDATA%/lienzo/hub.json` and injected in terminal env vars).

use crate::hub;
use serde_json::{json, Value};
use tauri::AppHandle;

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
    for request in server.incoming_requests() {
        let result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handle(request, &app)));
        if result.is_err() {
            eprintln!("[hub] una petición terminó en pánico");
        }
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
    let named = tiny_http::Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..])
        .unwrap();
    let response = tiny_http::Response::from_string(body)
        .with_status_code(status)
        .with_header(header)
        .with_header(named);
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
        .any(|h| h.field.equiv("X-Lienzo-Token") && h.value.as_str() == expected)
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

    let mut raw = String::new();
    let _ = request.as_reader().read_to_string(&mut raw);
    let payload: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));

    let result: Result<Value, String> = match (method.as_str(), path.as_str()) {
        ("POST", "/join") => cmd_join(app, &payload),
        ("POST", "/heartbeat") => cmd_heartbeat(app, &payload),
        ("POST", "/leave") => cmd_leave(app, &payload),
        ("POST", "/event") => cmd_event(app, &payload),
        ("POST", "/handover") => cmd_handover(app, &payload),
        ("POST", "/ctx") => cmd_ctx(app, &payload),
        ("GET", "/state") => cmd_state(app, &query),
        ("GET", "/feed") => cmd_feed(app, &query),
        ("POST", "/task") => cmd_task(app, &payload),
        ("POST", "/claim") => cmd_claim(app, &payload),
        ("POST", "/release") => cmd_release(app, &payload),
        ("POST", "/connect") => cmd_connect(app, &payload),
        ("POST", "/broadcast") => cmd_broadcast(app, &payload),
        ("GET", "/pending") => cmd_pending(app, &query),
        ("POST", "/broadcast/ack") => cmd_broadcast_ack(app, &payload),
        ("POST", "/charter") => cmd_charter(app, &payload),
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
        hub::persist(inner);
    })
    .ok_or("hub no inicializado")?;

    hub::notify_ui();
    Ok(json!({ "session_id": session_id }))
}

fn cmd_heartbeat(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let sid = payload["session_id"].as_str().unwrap_or("").to_string();
    hub::with_inner(app, |inner| {
        hub::touch_agent(inner, &sid);
    })
    .ok_or("hub no inicializado")?;
    Ok(json!({ "ok": true }))
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
        let text: String = payload["text"]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(2000)
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
        let to = payload["to"].as_str().map(|s| s.to_string());
        let ev = hub::push_event(inner, &agent, &sid, &kind, &text, files, to);
        // Telemetría opcional del puente: modelo y uso de contexto reales.
        let model = payload["model"].as_str().map(|s| s.to_string());
        let ctx_tokens = payload["ctx_tokens"].as_u64();
        let ctx_window = payload["ctx_window"].as_u64();
        if model.is_some() || ctx_tokens.is_some() {
            hub::report_ctx(inner, &sid, &agent, model, ctx_tokens, ctx_window);
        }
        hub::persist(inner);
        json!({ "seq": ev.seq })
    })
    .ok_or("hub no inicializado")?;
    hub::notify_ui();
    Ok(out)
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
    let out = hub::with_inner(app, |inner| {
        let events: Vec<&hub::Event> = inner
            .events
            .iter()
            .filter(|e| e.seq > since)
            .take(limit)
            .collect();
        json!({ "events": events, "seq": inner.seq })
    })
    .ok_or("hub no inicializado")?;
    Ok(out)
}

fn cmd_task(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let op = payload["op"].as_str().unwrap_or("").to_string();
    let sid = payload["session_id"].as_str().unwrap_or("").to_string();
    let id = payload["id"].as_u64().unwrap_or(0);
    let title: String = payload["title"]
        .as_str()
        .unwrap_or("")
        .trim()
        .chars()
        .take(200)
        .collect();
    let notes: String = payload["notes"].as_str().unwrap_or("").chars().take(500).collect();

    let out = hub::with_inner(app, |inner| -> Result<Value, String> {
        let (agent, sid) = hub::agent_label(inner, &sid, payload["agent"].as_str());
        match op.as_str() {
            "create" => {
                if title.is_empty() {
                    return Err("la tarea necesita un título".into());
                }
                inner.task_seq += 1;
                let task = hub::Task {
                    id: inner.task_seq,
                    title: title.clone(),
                    status: "open".into(),
                    owner: String::new(),
                    notes,
                    created_ms: hub::now_ms(),
                    handover: None,
                };
                inner.tasks.push(task.clone());
                hub::push_event(
                    inner,
                    &agent,
                    &sid,
                    "task",
                    &format!("#{} creada: {}", task.id, title),
                    vec![],
                    None,
                );
                hub::persist(inner);
                Ok(json!({ "task": task }))
            }
            "claim" | "done" | "reopen" => {
                let updated = if let Some(pos) = inner.tasks.iter().position(|t| t.id == id) {
                    {
                        let task = &mut inner.tasks[pos];
                        match op.as_str() {
                            "claim" => {
                                task.status = "claimed".into();
                                task.owner = agent.clone();
                            }
                            "done" => {
                                task.status = "done".into();
                                task.owner = agent.clone();
                                if !notes.is_empty() {
                                    task.notes = notes.clone();
                                }
                            }
                            _ => {
                                task.status = "open".into();
                                task.owner = String::new();
                            }
                        }
                    }
                    Some(inner.tasks[pos].clone())
                } else {
                    None
                };
                match updated {
                    Some(task) => {
                        let text = format!("#{} {} por {}", task.id, task.status, agent);
                        hub::push_event(inner, &agent, &sid, "task", &text, vec![], None);
                        hub::persist(inner);
                        Ok(json!({ "task": task }))
                    }
                    None => Err("tarea no encontrada".into()),
                }
            }
            "list" => Ok(json!({ "tasks": inner.tasks })),
            _ => Err("operación de tarea desconocida".into()),
        }
    })
    .ok_or("hub no inicializado")??;
    hub::notify_ui();
    Ok(out)
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
        for f in &files {
            let key = f.to_lowercase();
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
            hub::persist(inner);
        }
        json!({ "granted": granted, "conflicts": conflicts })
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
            let key = f.to_lowercase();
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

    // Remember the project so new terminals and the UI follow it.
    let changed = hub::with_inner(app, |inner| {
        if inner.project.as_deref() != Some(project.as_str()) {
            inner.project = Some(project.clone());
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
