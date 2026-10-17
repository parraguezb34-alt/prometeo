//! lienzo-mcp — puente entre los agentes de IA y el hub de equipo de lienzo.
//!
//! Dos modos:
//! - Servidor MCP por stdio (por defecto): expone las herramientas `team_*` y
//!   se las pasa al hub HTTP local de la app.
//! - Hooks: `lienzo-mcp hook --agent claude --event prompt|tool|stop|session`
//!   lee el JSON del hook por stdin, publica actividad y (en prompt/session)
//!   imprime contexto del equipo para inyectarlo en la conversación.

use lienzo_lib::hub::client::HubClient;
use serde_json::{json, Value};
use std::io::{BufRead, Read, Write};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(|a| a == "hook").unwrap_or(false) {
        hook_mode(&args[1..]);
    } else {
        mcp_mode();
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn trunc(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn short_path(path: &str) -> String {
    let norm = path.replace('\\', "/");
    let parts: Vec<&str> = norm.split('/').filter(|s| !s.is_empty()).collect();
    let n = parts.len();
    if n >= 2 {
        format!("{}/{}", parts[n - 2], parts[n - 1])
    } else {
        norm
    }
}

fn ago(ts: u64) -> String {
    let seconds = now_ms().saturating_sub(ts) / 1000;
    if seconds < 60 {
        format!("{}s", seconds)
    } else if seconds < 3600 {
        format!("{}m", seconds / 60)
    } else {
        format!("{}h", seconds / 3600)
    }
}

fn str_array(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn text_result(text: &str, is_error: bool) -> Value {
    let mut v = json!({ "content": [ { "type": "text", "text": text } ] });
    if is_error {
        v["isError"] = json!(true);
    }
    v
}

// ---------------------------------------------------------------------------
// Renderizado de estado (mismo formato para contexto inyectado y tools)
// ---------------------------------------------------------------------------

fn render_context(state: &Value) -> String {
    let empty = vec![];
    let mut out = String::from("[Equipo lienzo]\n");

    if let Some(leader) = state["leader"].as_str().filter(|s| !s.is_empty()) {
        out.push_str(&format!(
            "Líder del equipo: {} (coordina y reparte).\n",
            leader
        ));
    }
    if let Some(charter) = state["charter"].as_str().filter(|s| !s.is_empty()) {
        out.push_str(&format!("Normas del equipo:\n{}\n", trunc(charter, 520)));
    }

    let agents = state["agents"].as_array().unwrap_or(&empty);
    let names: Vec<String> = agents
        .iter()
        .filter(|a| a["online"].as_bool().unwrap_or(false))
        .map(|a| a["name"].as_str().unwrap_or("?").to_string())
        .collect();
    if names.is_empty() {
        out.push_str("No hay otros agentes en línea ahora mismo.\n");
    } else {
        out.push_str(&format!("Agentes en línea: {}\n", names.join(", ")));
    }

    let tasks = state["tasks"].as_array().unwrap_or(&empty);
    let open: Vec<String> = tasks
        .iter()
        .filter(|t| t["status"].as_str().unwrap_or("") != "done")
        .take(6)
        .map(|t| {
            format!(
                "#{} {} [{}]",
                t["id"].as_u64().unwrap_or(0),
                trunc(t["title"].as_str().unwrap_or(""), 60),
                t["status"].as_str().unwrap_or("open")
            )
        })
        .collect();
    if !open.is_empty() {
        out.push_str(&format!("Tareas abiertas: {}\n", open.join(" · ")));
    }

    let claims = state["claims"].as_array().unwrap_or(&empty);
    if !claims.is_empty() {
        let list: Vec<String> = claims
            .iter()
            .take(8)
            .map(|c| {
                format!(
                    "{} (de {})",
                    c["path"].as_str().unwrap_or("?"),
                    c["agent"].as_str().unwrap_or("?")
                )
            })
            .collect();
        out.push_str(&format!("Archivos reservados: {}\n", list.join(", ")));
    }

    let events = state["events"].as_array().unwrap_or(&empty);
    let recent: Vec<String> = events
        .iter()
        .filter(|e| e["kind"].as_str().unwrap_or("") != "tool")
        .take(6)
        .map(|e| {
            let mark = if e["kind"].as_str().unwrap_or("") == "broadcast" {
                "📣 "
            } else {
                ""
            };
            format!(
                "- hace {} · {}{}: {}",
                ago(e["ts_ms"].as_u64().unwrap_or(0)),
                mark,
                e["agent"].as_str().unwrap_or("?"),
                trunc(e["text"].as_str().unwrap_or(""), 110)
            )
        })
        .collect();
    if !recent.is_empty() {
        out.push_str("Actividad reciente:\n");
        out.push_str(&recent.join("\n"));
        out.push('\n');
    }

    out.push_str(
        "Coordínate con las herramientas team_* (MCP lienzo-team): team_update al terminar un paso, \
team_claim_files antes de editar archivos que otros podrían tocar, team_message para hablar con otro agente.",
    );
    out
}

fn render_feed(feed: &Value) -> String {
    let empty = vec![];
    let events = feed["events"].as_array().unwrap_or(&empty);
    if events.is_empty() {
        return "Sin actividad todavía.".to_string();
    }
    events
        .iter()
        .map(|e| {
            let files = str_array(&e["files"]);
            let extra = if files.is_empty() {
                String::new()
            } else {
                format!(" [{}]", files.iter().map(|f| short_path(f)).collect::<Vec<_>>().join(", "))
            };
            format!(
                "- hace {} · {} · {}: {}{}",
                ago(e["ts_ms"].as_u64().unwrap_or(0)),
                e["seq"].as_u64().unwrap_or(0),
                e["agent"].as_str().unwrap_or("?"),
                trunc(e["text"].as_str().unwrap_or(""), 160),
                extra
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn render_tasks(state: &Value) -> String {
    let empty = vec![];
    let tasks = state["tasks"].as_array().unwrap_or(&empty);
    if tasks.is_empty() {
        return "No hay tareas compartidas todavía. Crea una con team_task_create.".to_string();
    }
    let mut lines: Vec<String> = vec![];
    for t in tasks {
        let owner = t["owner"].as_str().unwrap_or("");
        lines.push(format!(
            "#{} [{}]{} {}",
            t["id"].as_u64().unwrap_or(0),
            t["status"].as_str().unwrap_or("open"),
            if owner.is_empty() {
                String::new()
            } else {
                format!(" ({})", owner)
            },
            trunc(t["title"].as_str().unwrap_or(""), 120)
        ));
    }
    lines.join("\n")
}

// ---------------------------------------------------------------------------
// Modo MCP (stdio)
// ---------------------------------------------------------------------------

fn initialize_result(params: &Value, client: Option<&HubClient>) -> Value {
    let mut instructions = String::from(
        "Herramientas del equipo compartido de lienzo: varios agentes de IA trabajan juntos en el mismo proyecto. \
Empieza con team_context, publica avances con team_update, reserva archivos con team_claim_files antes de editarlos y revisa team_feed.",
    );
    if let Some(c) = client {
        if let Ok(state) = c.get("/state?limit=1") {
            if let Some(leader) = state["leader"].as_str().filter(|s| !s.is_empty()) {
                instructions.push_str(&format!(
                    "\nLíder del equipo: {} (coordina y reparte; no compitas por el mando).",
                    leader
                ));
            }
            if let Some(charter) = state["charter"].as_str().filter(|s| !s.is_empty()) {
                instructions.push_str("\nNormas del equipo:\n");
                instructions.push_str(&trunc(charter, 600));
            }
        }
    }
    let wanted = params["protocolVersion"].as_str().unwrap_or("2025-06-18");
    json!({
        "protocolVersion": if wanted.is_empty() { "2025-06-18" } else { wanted },
        "capabilities": {
            "tools": { "listChanged": false },
            "resources": { "subscribe": false, "listChanged": false }
        },
        "serverInfo": { "name": "lienzo-team", "version": "0.1.0" },
        "instructions": instructions
    })
}

fn tools_catalog() -> Value {
    json!([
        {
            "name": "team_context",
            "description": "Resumen del equipo: compañeros en línea, tareas abiertas, archivos reservados y actividad reciente. Úsalo al empezar tu trabajo.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "team_update",
            "description": "Publica en el feed del equipo un avance de 1 línea (lo que hiciste o vas a hacer). Los demás agentes y el usuario lo ven al momento.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "Resumen breve del avance" },
                    "files": { "type": "array", "items": { "type": "string" }, "description": "Archivos tocados (opcional)" }
                },
                "required": ["text"]
            }
        },
        {
            "name": "team_feed",
            "description": "Lee la actividad reciente de todos los agentes del equipo.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "since_seq": { "type": "integer", "description": "Solo eventos posteriores a este número" },
                    "limit": { "type": "integer", "description": "Máximo de eventos (por defecto 40)" }
                }
            }
        },
        {
            "name": "team_message",
            "description": "Envía un mensaje al equipo (o a un agente concreto). Aparece en el feed de todos.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": { "type": "string" },
                    "to": { "type": "string", "description": "Nombre del agente destinatario (opcional; por defecto todos)" }
                },
                "required": ["text"]
            }
        },
        {
            "name": "team_task_create",
            "description": "Crea una tarea en el tablero compartido.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "notes": { "type": "string" }
                },
                "required": ["title"]
            }
        },
        {
            "name": "team_task_list",
            "description": "Lista el tablero de tareas compartidas.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "team_task_claim",
            "description": "Marca una tarea como tuya (en progreso).",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "integer" } },
                "required": ["id"]
            }
        },
        {
            "name": "team_task_done",
            "description": "Marca una tarea como completada.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer" },
                    "notes": { "type": "string", "description": "Resultado o notas finales" }
                },
                "required": ["id"]
            }
        },
        {
            "name": "team_claim_files",
            "description": "Reserva archivos antes de editarlos para que otros agentes no los toquen. Devuelve un aviso si alguien ya los tiene reservados.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "files": { "type": "array", "items": { "type": "string" }, "description": "Rutas de archivo" }
                },
                "required": ["files"]
            }
        },
        {
            "name": "team_release_files",
            "description": "Libera archivos reservados cuando terminas con ellos.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "files": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["files"]
            }
        }
    ])
}

fn resources_catalog() -> Value {
    json!([
        { "uri": "team://context", "name": "Equipo: contexto", "description": "Compañeros, tareas, reservas y actividad reciente", "mimeType": "text/markdown" },
        { "uri": "team://feed", "name": "Equipo: actividad", "description": "Últimos eventos del equipo", "mimeType": "text/markdown" },
        { "uri": "team://tasks", "name": "Equipo: tareas", "description": "Tablero de tareas compartidas", "mimeType": "text/markdown" }
    ])
}

fn call_tool(client: &HubClient, session_id: &str, params: &Value) -> Result<Value, (i64, String)> {
    let name = params["name"].as_str().unwrap_or("");
    let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    let sid = session_id.to_string();

    let result: Result<Value, String> = match name {
        "team_context" => client
            .get("/state?limit=40")
            .map(|v| text_result(&render_context(&v), false)),
        "team_feed" => {
            let since = args["since_seq"].as_u64().unwrap_or(0);
            let limit = args["limit"].as_u64().unwrap_or(40).min(200);
            client
                .get(&format!("/feed?since_seq={}&limit={}", since, limit))
                .map(|v| text_result(&render_feed(&v), false))
        }
        "team_update" => {
            let text = trunc(args["text"].as_str().unwrap_or(""), 1500);
            let files = str_array(&args["files"]);
            client
                .post(
                    "/event",
                    &json!({ "session_id": sid, "kind": "update", "text": text, "files": files }),
                )
                .map(|v| {
                    text_result(
                        &format!("publicado (evento #{})", v["seq"].as_u64().unwrap_or(0)),
                        false,
                    )
                })
        }
        "team_message" => {
            let text = trunc(args["text"].as_str().unwrap_or(""), 1500);
            let to = args["to"].as_str().map(|s| s.to_string());
            client
                .post(
                    "/event",
                    &json!({ "session_id": sid, "kind": "message", "text": text, "to": to }),
                )
                .map(|_| text_result("mensaje enviado al equipo", false))
        }
        "team_task_create" => {
            let title = trunc(args["title"].as_str().unwrap_or(""), 200);
            let notes = trunc(args["notes"].as_str().unwrap_or(""), 500);
            client
                .post(
                    "/task",
                    &json!({ "session_id": sid, "op": "create", "title": title, "notes": notes }),
                )
                .map(|v| {
                    text_result(
                        &format!(
                            "tarea #{} creada: {}",
                            v["task"]["id"].as_u64().unwrap_or(0),
                            v["task"]["title"].as_str().unwrap_or("")
                        ),
                        false,
                    )
                })
        }
        "team_task_list" => client
            .get("/state?limit=1")
            .map(|v| text_result(&render_tasks(&v), false)),
        "team_task_claim" | "team_task_done" => {
            let id = args["id"].as_u64().unwrap_or(0);
            let op = if name == "team_task_claim" { "claim" } else { "done" };
            let notes = trunc(args["notes"].as_str().unwrap_or(""), 500);
            client
                .post(
                    "/task",
                    &json!({ "session_id": sid, "op": op, "id": id, "notes": notes }),
                )
                .map(|v| {
                    text_result(
                        &format!(
                            "tarea #{} ahora está: {}",
                            v["task"]["id"].as_u64().unwrap_or(0),
                            v["task"]["status"].as_str().unwrap_or("")
                        ),
                        false,
                    )
                })
        }
        "team_claim_files" => {
            let files = str_array(&args["files"]);
            client
                .post("/claim", &json!({ "session_id": sid, "files": files }))
                .map(|v| {
                    let granted = str_array(&v["granted"]);
                    let conflicts = v["conflicts"].as_array().cloned().unwrap_or_default();
                    if conflicts.is_empty() {
                        text_result(
                            &format!("reservados: {}", granted.join(", ")),
                            false,
                        )
                    } else {
                        let list: Vec<String> = conflicts
                            .iter()
                            .map(|c| {
                                format!(
                                    "{} (reservado por {})",
                                    c["path"].as_str().unwrap_or("?"),
                                    c["agent"].as_str().unwrap_or("?")
                                )
                            })
                            .collect();
                        let extra = if granted.is_empty() {
                            String::new()
                        } else {
                            format!(" Aun así reservaste: {}.", granted.join(", "))
                        };
                        text_result(
                            &format!(
                                "⚠️ Conflictos: {}. No edites esos archivos: habla con su dueño (team_message) o espera.{}",
                                list.join("; "),
                                extra
                            ),
                            true,
                        )
                    }
                })
        }
        "team_release_files" => {
            let files = str_array(&args["files"]);
            client
                .post("/release", &json!({ "session_id": sid, "files": files }))
                .map(|v| {
                    text_result(
                        &format!(
                            "liberados {} archivo(s)",
                            v["released"].as_array().map(|a| a.len()).unwrap_or(0)
                        ),
                        false,
                    )
                })
        }
        other => return Err((-32602, format!("herramienta desconocida: {other}"))),
    };

    match result {
        Ok(v) => Ok(v),
        Err(e) => Ok(text_result(
            &format!(
                "No pude contactar con el hub de lienzo: {e}. Si la app está cerrada, avisa al usuario; puedes seguir trabajando sin coordinación."
            ),
            true,
        )),
    }
}

fn read_resource(client: &HubClient, params: &Value) -> Result<Value, (i64, String)> {
    let uri = params["uri"].as_str().unwrap_or("").to_string();
    let state = client.get("/state?limit=40").map_err(|e| (-32000, e))?;
    let text = match uri.as_str() {
        "team://context" => render_context(&state),
        "team://feed" => render_feed(&json!({ "events": state["events"] })),
        "team://tasks" => render_tasks(&state),
        _ => return Err((-32602, format!("recurso desconocido: {uri}"))),
    };
    Ok(json!({ "contents": [ { "uri": uri, "mimeType": "text/markdown", "text": text } ] }))
}

fn mcp_mode() {
    let agent = std::env::var("LIENZO_AGENT").unwrap_or_else(|_| "agente".to_string());
    let client = HubClient::discover();

    let session_id: String = client
        .as_ref()
        .and_then(|c| {
            let cwd = std::env::current_dir()
                .map(|p| p.display().to_string())
                .unwrap_or_default();
            c.post(
                "/join",
                &json!({ "name": agent, "project": cwd, "pid": std::process::id() }),
            )
            .ok()
            .and_then(|v| v["session_id"].as_str().map(|s| s.to_string()))
        })
        .unwrap_or_default();

    // Heartbeat so the hub knows this agent is alive.
    if let (Some(c), false) = (client.clone(), session_id.is_empty()) {
        let sid = session_id.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(20));
            let _ = c.post("/heartbeat", &json!({ "session_id": sid }));
        });
    }

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let method = msg["method"].as_str().unwrap_or("").to_string();
        let id = msg.get("id").cloned();
        let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));

        let response: Option<Result<Value, (i64, String)>> = match method.as_str() {
            "initialize" => Some(Ok(initialize_result(&params, client.as_ref()))),
            "notifications/initialized"
            | "notifications/cancelled"
            | "notifications/roots/list_changed" => None,
            "ping" => Some(Ok(json!({}))),
            "tools/list" => Some(Ok(json!({ "tools": tools_catalog() }))),
            "tools/call" => match &client {
                Some(c) => Some(call_tool(c, &session_id, &params)),
                None => Some(Ok(text_result(
                    "La app de lienzo no está abierta: no puedo conectar con el equipo.",
                    true,
                ))),
            },
            "resources/list" => Some(Ok(json!({ "resources": resources_catalog() }))),
            "resources/read" => match &client {
                Some(c) => Some(read_resource(c, &params)),
                None => Some(Ok(json!({ "contents": [] }))),
            },
            _ => {
                if id.is_some() {
                    Some(Err((-32601, format!("método no soportado: {method}"))))
                } else {
                    None
                }
            }
        };

        if let (Some(id), Some(resp)) = (id, response) {
            let out = match resp {
                Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                Err((code, message)) => json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": code, "message": message }
                }),
            };
            println!("{}", out);
            let _ = std::io::stdout().flush();
        }
    }

    if let (Some(c), false) = (client, session_id.is_empty()) {
        let _ = c.post("/leave", &json!({ "session_id": session_id }));
    }
}

// ---------------------------------------------------------------------------
// Modo hook
// ---------------------------------------------------------------------------

fn hook_mode(args: &[String]) {
    let mut agent = "agente".to_string();
    let mut event = "tool".to_string();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--agent" if i + 1 < args.len() => {
                agent = args[i + 1].clone();
                i += 2;
            }
            "--event" if i + 1 < args.len() => {
                event = args[i + 1].clone();
                i += 2;
            }
            _ => i += 1,
        }
    }

    let mut raw = String::new();
    let _ = std::io::stdin().read_to_string(&mut raw);
    let payload: Value = serde_json::from_str(raw.trim()).unwrap_or_else(|_| json!({}));

    let client = match HubClient::discover() {
        Some(c) => c,
        None => return,
    };

    let (kind, text, files): (&str, String, Vec<String>) = match event.as_str() {
        "prompt" => (
            "prompt",
            trunc(payload["prompt"].as_str().unwrap_or(""), 280),
            vec![],
        ),
        "tool" => {
            let tool = payload["tool_name"].as_str().unwrap_or("herramienta");
            let input = &payload["tool_input"];
            let file = input["file_path"]
                .as_str()
                .or_else(|| input["notebook_path"].as_str())
                .unwrap_or("");
            let cmd = input["command"].as_str().unwrap_or("");
            let detail = if !file.is_empty() {
                short_path(file)
            } else if !cmd.is_empty() {
                trunc(cmd, 120)
            } else {
                String::new()
            };
            let files = if file.is_empty() {
                vec![]
            } else {
                vec![file.to_string()]
            };
            ("tool", format!("{} {}", tool, detail).trim().to_string(), files)
        }
        "stop" => ("stop", "terminó su turno".to_string(), vec![]),
        "session" => ("session", "sesión iniciada".to_string(), vec![]),
        // Claude pide atencion (permiso, pregunta o lleva rato esperando).
        "waiting" => (
            "waiting",
            trunc(
                payload["message"].as_str().unwrap_or("esperando tu respuesta"),
                240,
            ),
            vec![],
        ),
        _ => ("event", event.clone(), vec![]),
    };

    let session_key = payload["session_id"].as_str().unwrap_or("").to_string();

    let _ = client.post(
        "/event",
        &json!({ "agent": agent, "kind": kind, "text": text, "files": files }),
    );

    // Broadcasts the user sent to the whole team that this session hasn't seen.
    let pending = fetch_pending(&client, &agent, &session_key);

    // On stop: if there are pending team messages, keep the turn alive with them.
    if event == "stop" && !pending.is_empty() {
        let joined: Vec<String> = pending.iter().map(|(_, t)| format!("- {}", t)).collect();
        let max_seq = pending.iter().map(|(s, _)| *s).max().unwrap_or(0);
        ack_pending(&client, &agent, &session_key, max_seq);
        println!(
            "{}",
            json!({
                "decision": "block",
                "reason": format!(
                    "📣 El usuario envió este mensaje a TODO el equipo (te llega ahora):\n{}\n\nActúa según tu rol: si eres el líder, reparte y coordina; si no, ejecuta tu parte y publícala con team_update. Mira team_context para el estado del equipo (compañeros, tareas y reservas); reserva los archivos con team_claim_files antes de editarlos y habla con los demás con team_message.",
                    joined.join("\n")
                )
            })
        );
        return;
    }

    // Inject team context on prompt/session start (Claude Code / Codex shape).
    if event == "prompt" || event == "session" {
        if let Ok(state) = client.get("/state?limit=30") {
            let hook_event = if event == "session" {
                "SessionStart"
            } else {
                "UserPromptSubmit"
            };
            let mut ctx = render_context(&state);
            if !pending.is_empty() {
                ctx.push_str("\n📣 Mensajes del usuario para todo el equipo (nuevos):\n");
                for (_, t) in &pending {
                    ctx.push_str(&format!("- {}\n", t));
                }
                let max_seq = pending.iter().map(|(s, _)| *s).max().unwrap_or(0);
                ack_pending(&client, &agent, &session_key, max_seq);
            }
            println!(
                "{}",
                json!({
                    "hookSpecificOutput": {
                        "hookEventName": hook_event,
                        "additionalContext": ctx
                    }
                })
            );
        }
    }
}

/// Team broadcasts not yet delivered to this hook session / agent.
fn fetch_pending(client: &HubClient, agent: &str, session: &str) -> Vec<(u64, String)> {
    client
        .get(&format!("/pending?agent={}&session={}", agent, session))
        .ok()
        .and_then(|v| {
            v["broadcasts"].as_array().map(|arr| {
                arr.iter()
                    .map(|b| {
                        (
                            b["seq"].as_u64().unwrap_or(0),
                            b["text"].as_str().unwrap_or("").to_string(),
                        )
                    })
                    .collect()
            })
        })
        .unwrap_or_default()
}

fn ack_pending(client: &HubClient, agent: &str, session: &str, seq: u64) {
    let _ = client.post(
        "/broadcast/ack",
        &json!({ "agent": agent, "session": session, "seq": seq }),
    );
}
