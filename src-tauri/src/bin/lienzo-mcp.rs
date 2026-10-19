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
use std::io::{BufRead, Read, Seek, SeekFrom, Write};
use std::sync::{Arc, Mutex};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(|a| a == "hook").unwrap_or(false) {
        hook_mode(&args[1..]);
    } else if args.first().map(|a| a == "mirror-dump").unwrap_or(false) {
        // Diagnóstico del espejo de OpenCode/Antigravity: lienzo-mcp mirror-dump <carpeta> [pasos]
        let project = args.get(1).cloned().unwrap_or_default();
        let back: i64 = args.get(2).and_then(|n| n.parse().ok()).unwrap_or(80);
        for line in lienzo_lib::hub::mirror::replay(&project, back, back) {
            println!("{line}");
        }
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

fn is_image_path(path: &str) -> bool {
    let low = path.to_lowercase();
    [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]
        .iter()
        .any(|ext| low.ends_with(ext))
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

const CONTEXT_FOOTER: &str = "Coordínate con las herramientas team_* (MCP lienzo-team): team_update al terminar un paso, \
team_claim_files antes de editar archivos que otros podrían tocar, team_message para hablar con otro agente.";

/// El contexto del equipo por partes (clave, texto). Los hooks comparan cada parte con la
/// que ya inyectaron y solo mandan las que cambiaron.
fn context_sections(state: &Value, me: &str) -> Vec<(&'static str, String)> {
    let empty = vec![];
    let mut sections: Vec<(&'static str, String)> = Vec::new();

    let mut lead = String::new();
    if let Some(leader) = state["leader"].as_str().filter(|s| !s.is_empty()) {
        lead.push_str(&format!("Líder del equipo: {} (coordina y reparte).\n", leader));
        if state["director"].as_bool().unwrap_or(false) {
            let rounds = state["fix_limit"].as_u64().unwrap_or(2);
            if leader.eq_ignore_ascii_case(me) {
                lead.push_str(&format!(
                    "Modo director: diriges tú. Divide el trabajo en encargos cerrados con team_task_create (notes, level, assign), \
revisa cada entrega con team_task_review (máx. {rounds} rondas de fix) y haz tú solo lo difícil. Pauta: skill lienzo-director.\n"
                ));
            } else {
                lead.push_str(&format!(
                    "Modo director: {leader} reparte y revisa tus entregas. Sigue el encargo al pie de la letra, \
entrega con evidencia real y corrige lo que te pida.\n"
                ));
            }
        }
    }
    if let Some(charter) = state["charter"].as_str().filter(|s| !s.is_empty()) {
        lead.push_str(&format!("Normas del equipo:\n{}\n", trunc(charter, 520)));
    }
    sections.push(("lead", lead));

    let agents = state["agents"].as_array().unwrap_or(&empty);
    let mut names: Vec<String> = agents
        .iter()
        .filter(|a| a["online"].as_bool().unwrap_or(false))
        .map(|a| a["name"].as_str().unwrap_or("?").to_string())
        .collect();
    names.sort();
    names.dedup();
    sections.push((
        "online",
        if names.is_empty() {
            "No hay otros agentes en línea ahora mismo.\n".to_string()
        } else {
            format!("Agentes en línea: {}\n", names.join(", "))
        },
    ));

    let tasks = state["tasks"].as_array().unwrap_or(&empty);
    let mut work = String::new();
    let open: Vec<String> = tasks
        .iter()
        .filter(|t| t["status"].as_str().unwrap_or("") != "done")
        .take(6)
        .map(|t| {
            format!(
                "#{} {} [{}]",
                t["id"].as_u64().unwrap_or(0),
                trunc(t["title"].as_str().unwrap_or(""), 60),
                task_flag(t, tasks)
            )
        })
        .collect();
    if !open.is_empty() {
        work.push_str(&format!("Tareas abiertas: {}\n", open.join(" · ")));
    }
    // Entregas de tareas hechas de las que aún depende trabajo pendiente.
    let delivered: Vec<String> = tasks
        .iter()
        .filter(|t| t["status"].as_str().unwrap_or("") == "done" && !t["result"].is_null())
        .filter(|t| {
            let id = t["id"].as_u64().unwrap_or(0);
            tasks.iter().any(|o| {
                o["status"].as_str().unwrap_or("") != "done"
                    && o["parents"].as_array().map(|p| p.iter().any(|x| x.as_u64() == Some(id))).unwrap_or(false)
            })
        })
        .take(4)
        .map(|t| {
            format!(
                "#{} entregó: {}",
                t["id"].as_u64().unwrap_or(0),
                trunc(t["result"]["summary"].as_str().unwrap_or(""), 140)
            )
        })
        .collect();
    if !delivered.is_empty() {
        work.push_str(&format!("Entregas previas: {}\n", delivered.join(" · ")));
    }
    // Notas cruzadas: lo último que se dijo en el tablón de las tareas pendientes.
    let mut notes: Vec<(u64, String)> = vec![];
    for t in tasks.iter().filter(|t| t["status"].as_str().unwrap_or("") != "done") {
        for c in t["comments"].as_array().unwrap_or(&empty) {
            notes.push((
                c["ts_ms"].as_u64().unwrap_or(0),
                format!(
                    "#{} {}: {}",
                    t["id"].as_u64().unwrap_or(0),
                    c["by"].as_str().unwrap_or("?"),
                    trunc(c["text"].as_str().unwrap_or(""), 120)
                ),
            ));
        }
    }
    notes.sort_by(|a, b| b.0.cmp(&a.0));
    if !notes.is_empty() {
        let list: Vec<String> = notes.into_iter().take(3).map(|n| n.1).collect();
        work.push_str(&format!("Notas del tablón: {}\n", list.join(" · ")));
    }
    sections.push(("tasks", work));

    // Memoria del proyecto: lo que el líder decidió que todos deben recordar.
    let mut mem = String::new();
    let memory = state["memory"].as_array().unwrap_or(&empty);
    let active: Vec<&Value> = memory.iter().filter(|m| m["status"].as_str() == Some("active")).collect();
    if !active.is_empty() {
        mem.push_str("Memoria del proyecto (curada por el líder):\n");
        let mut budget = 900usize;
        for m in active.iter().rev() {
            let line = format!("- [{}] {}\n", m["kind"].as_str().unwrap_or("hecho"), trunc(m["text"].as_str().unwrap_or(""), 200));
            if line.len() > budget {
                break;
            }
            budget -= line.len();
            mem.push_str(&line);
        }
    }
    let pending = memory.iter().filter(|m| m["status"].as_str() == Some("proposed")).count();
    let leader_name = state["leader"].as_str().unwrap_or("");
    if pending > 0 && (leader_name.is_empty() || leader_name == me) {
        mem.push_str(&format!(
            "Tienes {pending} propuesta(s) de memoria por revisar: mira team_memory_list y decide con team_memory_resolve.\n"
        ));
    }
    sections.push(("memory", mem));

    let claims = state["claims"].as_array().unwrap_or(&empty);
    let mut cl = String::new();
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
        cl.push_str(&format!("Archivos reservados: {}\n", list.join(", ")));
    }
    sections.push(("claims", cl));
    sections
}

/// Actividad reciente (sin acciones de herramientas), solo la posterior a `since_seq` y,
/// si se indica, sin lo que hizo el propio agente (eso ya lo sabe).
fn context_events(state: &Value, since_seq: u64, skip_agent: &str) -> String {
    let empty = vec![];
    let events = state["events"].as_array().unwrap_or(&empty);
    let recent: Vec<String> = events
        .iter()
        .filter(|e| e["kind"].as_str().unwrap_or("") != "tool")
        .filter(|e| e["seq"].as_u64().unwrap_or(0) > since_seq)
        .filter(|e| skip_agent.is_empty() || e["agent"].as_str() != Some(skip_agent))
        .filter(|e| !matches!(e["kind"].as_str().unwrap_or(""), "join" | "leave" | "session" | "stop" | "prompt"))
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
    if recent.is_empty() {
        String::new()
    } else {
        format!("Actividad reciente:\n{}\n", recent.join("\n"))
    }
}

fn render_context(state: &Value, me: &str) -> String {
    let mut out = String::from("[Equipo lienzo]\n");
    for (_, text) in context_sections(state, me) {
        out.push_str(&text);
    }
    out.push_str(&context_events(state, 0, ""));
    out.push_str(CONTEXT_FOOTER);
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
                trunc(&e["text"].as_str().unwrap_or("").replace('\n', " "), 160),
                extra
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Estado legible de una tarea: «open·lista», «open·bloqueada por #1,#2», «claimed», «done».
fn task_flag(t: &Value, tasks: &[Value]) -> String {
    let status = t["status"].as_str().unwrap_or("open");
    if status == "review" {
        return "en revisión".to_string();
    }
    if status != "open" {
        return status.to_string();
    }
    let unmet: Vec<String> = t["parents"]
        .as_array()
        .map(|p| {
            p.iter()
                .filter_map(|x| x.as_u64())
                .filter(|id| tasks.iter().any(|o| o["id"].as_u64() == Some(*id) && o["status"].as_str().unwrap_or("") != "done"))
                .map(|id| format!("#{id}"))
                .collect()
        })
        .unwrap_or_default();
    if unmet.is_empty() {
        "open·lista".to_string()
    } else {
        format!("open·bloqueada por {}", unmet.join(","))
    }
}

fn render_memory(v: &Value) -> String {
    let empty = vec![];
    let all = v["memory"].as_array().unwrap_or(&empty);
    if all.is_empty() {
        return "La memoria del proyecto está vacía. Propón algo con team_memory_propose.".to_string();
    }
    let mut out = String::new();
    let active: Vec<&Value> = all.iter().filter(|m| m["status"].as_str() == Some("active")).collect();
    let proposed: Vec<&Value> = all.iter().filter(|m| m["status"].as_str() == Some("proposed")).collect();
    if !active.is_empty() {
        out.push_str("Memoria del proyecto:\n");
        for m in active {
            out.push_str(&format!(
                "#{} [{}] {} (por {})\n",
                m["id"].as_u64().unwrap_or(0),
                m["kind"].as_str().unwrap_or("hecho"),
                m["text"].as_str().unwrap_or(""),
                m["by"].as_str().unwrap_or("?")
            ));
        }
    }
    if !proposed.is_empty() {
        out.push_str("Propuestas pendientes:\n");
        for m in proposed {
            out.push_str(&format!(
                "#{} [{}] {} (propone {})\n",
                m["id"].as_u64().unwrap_or(0),
                m["kind"].as_str().unwrap_or("hecho"),
                m["text"].as_str().unwrap_or(""),
                m["by"].as_str().unwrap_or("?")
            ));
        }
    }
    out
}

/// Tablero de tareas. Las hechas crecen sin fin: salvo `all`, solo las 5 últimas.
fn render_tasks(state: &Value, all: bool) -> String {
    let empty = vec![];
    let tasks = state["tasks"].as_array().unwrap_or(&empty);
    if tasks.is_empty() {
        return "No hay tareas compartidas todavía. Crea una con team_task_create.".to_string();
    }
    let done: Vec<&Value> = tasks.iter().filter(|t| t["status"].as_str() == Some("done")).collect();
    let hidden = if all { 0 } else { done.len().saturating_sub(5) };
    let skip: std::collections::HashSet<u64> = done
        .iter()
        .take(hidden)
        .filter_map(|t| t["id"].as_u64())
        .collect();
    let mut lines: Vec<String> = vec![];
    for t in tasks.iter().filter(|t| !skip.contains(&t["id"].as_u64().unwrap_or(0))) {
        let owner = t["owner"].as_str().unwrap_or("");
        let mut tags = String::new();
        if let Some(level) = t["level"].as_str().filter(|l| !l.is_empty()) {
            tags.push_str(&format!(" {level}"));
        }
        if let Some(to) = t["assign"].as_str().filter(|a| !a.is_empty() && owner.is_empty()) {
            tags.push_str(&format!(" →{to}"));
        }
        lines.push(format!(
            "#{} [{}{tags}]{} {}",
            t["id"].as_u64().unwrap_or(0),
            task_flag(t, tasks),
            if owner.is_empty() {
                String::new()
            } else {
                format!(" ({})", owner)
            },
            trunc(t["title"].as_str().unwrap_or(""), 120)
        ));
        if matches!(t["status"].as_str().unwrap_or(""), "done" | "review") && !t["result"].is_null() {
            lines.push(format!("   ↳ entrega: {}", trunc(t["result"]["summary"].as_str().unwrap_or(""), 160)));
        }
    }
    if hidden > 0 {
        lines.push(format!("(+{hidden} tareas hechas más antiguas; team_task_list con all=true para verlas)"));
    }
    lines.join("\n")
}

// ---------------------------------------------------------------------------
// Modo MCP (stdio)
// ---------------------------------------------------------------------------

fn initialize_result(params: &Value, client: Option<&HubClient>) -> Value {
    let mut instructions = String::from(
        "Herramientas del equipo compartido de lienzo: varios agentes de IA trabajan juntos en el mismo proyecto. \
Empieza con team_context, publica avances con team_update, reserva archivos con team_claim_files antes de editarlos y revisa team_feed. \
Si una herramienta te avisa de 📬 mensajes, léelos con team_inbox y contesta con team_message (to + reply_to); no contestes agradecimientos. \
Cuando tu contexto esté muy lleno, guarda tu memoria con team_handover_save (incluye tu task_id): queda pegada a la tarea y la app compactará tu contexto sin perder el hilo.",
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
            "description": "Lee la actividad reciente del equipo (avances, mensajes, tareas), sin el ruido de conexiones y comandos.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "since_seq": { "type": "integer", "description": "Solo eventos posteriores a este número" },
                    "limit": { "type": "integer", "description": "Máximo de eventos (por defecto 15)" },
                    "all": { "type": "boolean", "description": "Incluir también conexiones y acciones de herramientas" }
                }
            }
        },
        {
            "name": "team_message",
            "description": "Envía un mensaje a otro agente (o a todo el equipo). Le llega a su buzón y lo ve el usuario. Para responder a un mensaje, pon reply_to con su número.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "El mensaje, corto: la pregunta o el dato y las rutas (sin pegar archivos)" },
                    "to": { "type": "string", "description": "Agente destinatario; \"líder\" llega al líder actual (opcional; por defecto todo el equipo)" },
                    "reply_to": { "type": "integer", "description": "Número del mensaje al que respondes (lo marca como leído)" }
                },
                "required": ["text"]
            }
        },
        {
            "name": "team_inbox",
            "description": "Lee tu buzón: los mensajes que otros agentes te enviaron y aún no has leído. Quedan marcados como leídos.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "team_task_create",
            "description": "Crea una tarea en el tablero compartido. Con `parents` (ids de otras tareas) queda bloqueada hasta que todas ellas estén hechas: así se ordena el trabajo y lo independiente corre en paralelo.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "notes": { "type": "string", "description": "El encargo: objetivo, archivos, criterio de hecho y cómo comprobarlo (hasta 4000 caracteres)" },
                    "parents": { "type": "array", "items": { "type": "integer" }, "description": "Ids de las tareas que deben estar hechas antes de esta (opcional)" },
                    "level": { "type": "string", "enum": ["simple", "media", "dificil"], "description": "Dificultad: las difíciles van al líder" },
                    "assign": { "type": "string", "description": "Agente que debe hacerla (opcional)" }
                },
                "required": ["title"]
            }
        },
        {
            "name": "team_task_review",
            "description": "Solo el líder, en modo director: decide sobre una entrega en revisión. ok = aprobada; fix = vuelve a su dueño con tus órdenes en `notes`; take = la terminas tú.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer" },
                    "verdict": { "type": "string", "enum": ["ok", "fix", "take"] },
                    "notes": { "type": "string", "description": "Con fix: órdenes concretas y numeradas (archivo, qué cambiar, cómo comprobarlo)" }
                },
                "required": ["id", "verdict"]
            }
        },
        {
            "name": "team_task_list",
            "description": "Lista el tablero de tareas: las abiertas y en curso, y las últimas hechas con su entrega.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "all": { "type": "boolean", "description": "Incluir todas las tareas hechas, no solo las últimas 5" }
                }
            }
        },
        {
            "name": "team_task_claim",
            "description": "Marca una tarea como tuya (en progreso). Falla si ya es de otro agente o si espera a tareas aún sin hacer. Al reclamar recibes las entregas de las tareas de las que depende.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "integer" } },
                "required": ["id"]
            }
        },
        {
            "name": "team_task_done",
            "description": "Cierra una tarea con su entrega: qué hiciste, qué archivos tocaste y cómo lo comprobaste. Las tareas que dependen de esta recibirán tu entrega al reclamarlas.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer" },
                    "summary": { "type": "string", "description": "Qué hiciste y qué decidiste (obligatorio)" },
                    "files": { "type": "array", "items": { "type": "string" }, "description": "Archivos que tocaste" },
                    "evidence": { "type": "string", "description": "Cómo lo comprobaste (tests, comando, resultado)" },
                    "notes": { "type": "string", "description": "Alias antiguo de summary" }
                },
                "required": ["id", "summary"]
            }
        },
        {
            "name": "team_task_comment",
            "description": "Deja una nota en el tablón de una tarea: datos, decisiones o avisos para quien la lleve o dependa de ella. Mejor que el feed para cosas concretas de la tarea.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer" },
                    "text": { "type": "string", "description": "La nota (hasta 800 caracteres)" }
                },
                "required": ["id", "text"]
            }
        },
        {
            "name": "team_memory_list",
            "description": "Lista la memoria del proyecto (lo que el líder decidió que todos recuerden) y las propuestas pendientes.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "team_memory_propose",
            "description": "Propone algo para la memoria del proyecto (una decisión, un hecho, una convención o un aviso que valga para todos). El líder decide si se guarda. Si eres el líder, se guarda directamente.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "Una frase clara y autosuficiente (hasta 400 caracteres)" },
                    "kind": { "type": "string", "enum": ["decision", "hecho", "convencion", "aviso"] }
                },
                "required": ["text"]
            }
        },
        {
            "name": "team_memory_save",
            "description": "Solo líder: guarda una entrada en la memoria del proyecto.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": { "type": "string" },
                    "kind": { "type": "string", "enum": ["decision", "hecho", "convencion", "aviso"] }
                },
                "required": ["text"]
            }
        },
        {
            "name": "team_memory_resolve",
            "description": "Solo líder: acepta (opcionalmente reescribiéndola con `text`) o descarta una propuesta de memoria.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer" },
                    "accept": { "type": "boolean" },
                    "text": { "type": "string", "description": "Texto reescrito (opcional)" }
                },
                "required": ["id", "accept"]
            }
        },
        {
            "name": "team_memory_forget",
            "description": "Solo líder: quita una entrada de la memoria del proyecto (porque ya no vale).",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "integer" } },
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
        },
        {
            "name": "team_handover_save",
            "description": "Guarda tu relevo con memoria pegado a tu tarea: qué hiciste, decisiones tomadas, qué falta y archivos tocados. Úsalo cuando el contexto esté lleno o al terminar tu turno; la app compactará tu contexto después sin perder el hilo.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": { "type": "integer", "description": "Número de tu tarea actual (si la tienes)" },
                    "summary": { "type": "string", "description": "Resumen: qué hiciste, decisiones y qué falta" },
                    "files": { "type": "array", "items": { "type": "string" }, "description": "Archivos que tocaste (opcional)" }
                },
                "required": ["summary"]
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
            .map(|v| text_result(&render_context(&v, &std::env::var("LIENZO_AGENT").unwrap_or_default()), false)),
        "team_feed" => {
            let since = args["since_seq"].as_u64().unwrap_or(0);
            let limit = args["limit"].as_u64().unwrap_or(15).min(100);
            let quiet = if args["all"].as_bool().unwrap_or(false) { 0 } else { 1 };
            client
                .get(&format!("/feed?since_seq={}&limit={}&quiet={}", since, limit, quiet))
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
            let reply_to = args["reply_to"].as_u64().filter(|n| *n > 0);
            let body = trunc(args["text"].as_str().unwrap_or(""), 1500);
            let text = match reply_to {
                Some(n) => format!("↩ #{n} {body}"),
                None => body,
            };
            let to = args["to"].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
            client
                .post(
                    "/event",
                    &json!({ "session_id": sid, "kind": "message", "text": text, "to": to, "reply_to": reply_to }),
                )
                .map(|v| {
                    let seq = v["seq"].as_u64().unwrap_or(0);
                    let msg = match (v["to"].as_str(), v["online"].as_bool()) {
                        (Some(t), Some(true)) => format!("mensaje #{seq} enviado a {t}: le llega a su buzón"),
                        (Some(t), _) => format!("mensaje #{seq} guardado para {t} (ahora no está en línea: lo leerá al volver)"),
                        _ => format!("mensaje #{seq} enviado a todo el equipo"),
                    };
                    text_result(&msg, false)
                })
        }
        "team_inbox" => {
            let me = std::env::var("LIENZO_AGENT").unwrap_or_default();
            client
                .get(&format!("/inbox?agent={}&ack=1", url_part(&me)))
                .map(|v| text_result(&render_inbox(&v), false))
        }
        "team_task_create" => {
            let title = trunc(args["title"].as_str().unwrap_or(""), 200);
            let notes = trunc(args["notes"].as_str().unwrap_or(""), 4000);
            let parents: Vec<u64> = args["parents"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_u64()).collect())
                .unwrap_or_default();
            client
                .post(
                    "/task",
                    &json!({
                        "session_id": sid, "op": "create", "title": title, "notes": notes, "parents": parents,
                        "level": args["level"].as_str().unwrap_or(""), "assign": args["assign"].as_str().unwrap_or("")
                    }),
                )
                .map(|v| {
                    let blocked = v["task"]["parents"].as_array().map(|p| !p.is_empty()).unwrap_or(false);
                    let assign = v["task"]["assign"].as_str().filter(|a| !a.is_empty());
                    text_result(
                        &format!(
                            "tarea #{} creada: {}{}{}",
                            v["task"]["id"].as_u64().unwrap_or(0),
                            v["task"]["title"].as_str().unwrap_or(""),
                            assign.map(|a| format!(" → {a}")).unwrap_or_default(),
                            if blocked { " (bloqueada hasta que terminen sus padres)" } else { "" }
                        ),
                        false,
                    )
                })
        }
        "team_task_review" => {
            let id = args["id"].as_u64().unwrap_or(0);
            let notes = trunc(args["notes"].as_str().unwrap_or(""), 2000);
            client
                .post(
                    "/task",
                    &json!({
                        "session_id": sid, "op": "review", "id": id,
                        "verdict": args["verdict"].as_str().unwrap_or(""), "notes": notes
                    }),
                )
                .map(|v| text_result(v["ok"].as_str().unwrap_or("hecho"), false))
        }
        "team_task_list" => client
            .get("/state?limit=1")
            .map(|v| text_result(&render_tasks(&v, args["all"].as_bool().unwrap_or(false)), false)),
        "team_task_claim" | "team_task_done" => {
            let id = args["id"].as_u64().unwrap_or(0);
            let op = if name == "team_task_claim" { "claim" } else { "done" };
            let notes = trunc(args["notes"].as_str().unwrap_or(""), 500);
            let summary = trunc(args["summary"].as_str().unwrap_or(""), 1500);
            let evidence = trunc(args["evidence"].as_str().unwrap_or(""), 500);
            let files = str_array(&args["files"]);
            client
                .post(
                    "/task",
                    &json!({
                        "session_id": sid, "op": op, "id": id,
                        "notes": notes, "summary": summary, "evidence": evidence, "files": files
                    }),
                )
                .map(|v| {
                    let mut msg = match v["reviewer"].as_str() {
                        Some(leader) => format!(
                            "tarea #{} entregada: {leader} la revisará. Si pide cambios te llegarán al buzón; mientras, no la cierres de nuevo.",
                            v["task"]["id"].as_u64().unwrap_or(0)
                        ),
                        None => format!(
                            "tarea #{} ahora está: {}",
                            v["task"]["id"].as_u64().unwrap_or(0),
                            v["task"]["status"].as_str().unwrap_or("")
                        ),
                    };
                    // El encargo completo llega al reclamar (el aviso de despacho solo lleva el título).
                    if let Some(brief) = v["task"]["notes"].as_str().filter(|n| !n.trim().is_empty() && name == "team_task_claim") {
                        msg.push_str(&format!("\n\nEncargo:\n{}", brief.trim()));
                    }
                    if let Some(list) = v["parents_results"].as_array().filter(|l| !l.is_empty()) {
                        msg.push_str("\n\nEntregas de las tareas de las que depende (léelas antes de empezar):");
                        for r in list {
                            msg.push_str(&format!(
                                "\n- #{} {} ({}): {}",
                                r["id"].as_u64().unwrap_or(0),
                                trunc(r["title"].as_str().unwrap_or(""), 80),
                                r["by"].as_str().unwrap_or("?"),
                                trunc(r["summary"].as_str().unwrap_or(""), 600)
                            ));
                            let rf = str_array(&r["files"]);
                            if !rf.is_empty() {
                                msg.push_str(&format!("\n  archivos: {}", rf.join(", ")));
                            }
                            if let Some(ev) = r["evidence"].as_str().filter(|e| !e.is_empty()) {
                                msg.push_str(&format!("\n  evidencia: {}", trunc(ev, 300)));
                            }
                        }
                    }
                    if let Some(list) = v["comments"].as_array().filter(|l| !l.is_empty() && name == "team_task_claim") {
                        msg.push_str("\n\nNotas del tablón de esta tarea:");
                        for c in list.iter().rev().take(6).rev() {
                            msg.push_str(&format!(
                                "\n- {}: {}",
                                c["by"].as_str().unwrap_or("?"),
                                trunc(c["text"].as_str().unwrap_or(""), 400)
                            ));
                        }
                    }
                    text_result(&msg, false)
                })
        }
        "team_task_comment" => {
            let id = args["id"].as_u64().unwrap_or(0);
            let text = trunc(args["text"].as_str().unwrap_or(""), 800);
            client
                .post("/task", &json!({ "session_id": sid, "op": "comment", "id": id, "text": text }))
                .map(|_| text_result(&format!("nota añadida al tablón de la tarea #{id}"), false))
        }
        "team_memory_list" => client
            .post("/memory", &json!({ "session_id": sid, "op": "list" }))
            .map(|v| text_result(&render_memory(&v), false)),
        "team_memory_propose" | "team_memory_save" => {
            let op = if name == "team_memory_save" { "save" } else { "propose" };
            let text = trunc(args["text"].as_str().unwrap_or(""), 400);
            let kind = args["kind"].as_str().unwrap_or("hecho").to_string();
            client
                .post("/memory", &json!({ "session_id": sid, "op": op, "text": text, "kind": kind }))
                .map(|v| {
                    let id = v["entry"]["id"].as_u64().unwrap_or(0);
                    if v["saved"].as_bool().unwrap_or(false) {
                        text_result(&format!("guardado en la memoria del proyecto (#{id})"), false)
                    } else {
                        text_result(&format!("propuesta #{id} enviada: el líder decidirá si entra en la memoria"), false)
                    }
                })
        }
        "team_memory_resolve" => {
            let id = args["id"].as_u64().unwrap_or(0);
            let accept = args["accept"].as_bool().unwrap_or(true);
            let text = trunc(args["text"].as_str().unwrap_or(""), 400);
            client
                .post("/memory", &json!({ "session_id": sid, "op": "resolve", "id": id, "accept": accept, "text": text }))
                .map(|_| text_result(&format!("propuesta #{id} {}", if accept { "aceptada" } else { "descartada" }), false))
        }
        "team_memory_forget" => {
            let id = args["id"].as_u64().unwrap_or(0);
            client
                .post("/memory", &json!({ "session_id": sid, "op": "forget", "id": id }))
                .map(|_| text_result(&format!("entrada #{id} olvidada"), false))
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
        "team_handover_save" => {
            let summary = trunc(args["summary"].as_str().unwrap_or(""), 1500);
            let task_id = args["task_id"].as_u64().filter(|v| *v > 0);
            let files = str_array(&args["files"]);
            client
                .post(
                    "/handover",
                    &json!({ "session_id": sid, "task_id": task_id, "summary": summary, "files": files }),
                )
                .map(|_| {
                    text_result(
                        "relevo guardado en la tarea; la app compactará tu contexto para liberar espacio (no hace falta que lo hagas tú)",
                        false,
                    )
                })
        }
        other => return Err((-32602, format!("herramienta desconocida: {other}"))),
    };

    let result = result.map(|mut v| {
        if name != "team_inbox" {
            if let Some(note) = inbox_notice(client) {
                if let Some(t) = v["content"][0]["text"].as_str() {
                    v["content"][0]["text"] = json!(format!("{t}\n\n{note}"));
                }
            }
        }
        v
    });
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

/// Codifica lo justo para meter un nombre de agente en la query.
fn url_part(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' => (b as char).to_string(),
            _ => format!("%{:02X}", b),
        })
        .collect()
}

fn render_inbox(v: &Value) -> String {
    let empty = vec![];
    let list = v["messages"].as_array().unwrap_or(&empty);
    if list.is_empty() {
        return "No tienes mensajes sin leer.".to_string();
    }
    let mut out = format!("📬 {} mensaje(s) nuevo(s):\n", list.len());
    for m in list {
        let to = match m["to"].as_str() {
            Some(_) => "",
            None => " (a todo el equipo)",
        };
        out.push_str(&format!(
            "- #{} de {}{} · hace {}: {}\n",
            m["seq"].as_u64().unwrap_or(0),
            m["from"].as_str().unwrap_or("?"),
            to,
            ago(m["ts_ms"].as_u64().unwrap_or(0)),
            trunc(m["text"].as_str().unwrap_or(""), 1200)
        ));
    }
    out.push_str("Responde con team_message (to = quien escribió, reply_to = su número) solo si aporta algo.");
    out
}

/// «📬 tienes N mensajes» si hay algo sin leer en el buzón de este agente.
fn inbox_notice(client: &HubClient) -> Option<String> {
    let me = std::env::var("LIENZO_AGENT").ok().filter(|s| !s.is_empty())?;
    let v = client.get(&format!("/inbox?agent={}", url_part(&me))).ok()?;
    let n = v["unread"].as_u64().unwrap_or(0);
    if n == 0 {
        return None;
    }
    let mut from: Vec<String> = v["messages"]
        .as_array()
        .map(|l| l.iter().filter_map(|m| m["from"].as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    from.sort();
    from.dedup();
    Some(format!(
        "📬 Tienes {n} mensaje(s) sin leer de {}. Léelos con team_inbox.",
        from.join(", ")
    ))
}

fn read_resource(client: &HubClient, params: &Value) -> Result<Value, (i64, String)> {
    let uri = params["uri"].as_str().unwrap_or("").to_string();
    let state = client.get("/state?limit=40").map_err(|e| (-32000, e))?;
    let text = match uri.as_str() {
        "team://context" => render_context(&state, &std::env::var("LIENZO_AGENT").unwrap_or_default()),
        "team://feed" => render_feed(&json!({ "events": state["events"] })),
        "team://tasks" => render_tasks(&state, false),
        _ => return Err((-32602, format!("recurso desconocido: {uri}"))),
    };
    Ok(json!({ "contents": [ { "uri": uri, "mimeType": "text/markdown", "text": text } ] }))
}

/// Se une al hub como `agent` y devuelve el id de sesión (vacío si no se pudo).
fn join_hub(client: &HubClient, agent: &str) -> String {
    let cwd = std::env::current_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    client
        .post(
            "/join",
            &json!({ "name": agent, "project": cwd, "pid": std::process::id() }),
        )
        .ok()
        .and_then(|v| v["session_id"].as_str().map(|s| s.to_string()))
        .unwrap_or_default()
}

/// Las terminales que abre lienzo llevan `LIENZO_HUB`; un CLI abierto por su cuenta en la
/// misma carpeta (otra ventana, la app de escritorio) no, aunque lea la misma config.
fn outside_lienzo() -> bool {
    std::env::var_os("LIENZO_HUB").is_none()
}

fn mcp_mode() {
    let agent = std::env::var("LIENZO_AGENT").unwrap_or_else(|_| "agente".to_string());
    // Un Claude Code abierto fuera de lienzo lee el mismo `.mcp.json` del proyecto, pero no es
    // el agente del equipo: no se une, para no hacerse pasar por él en el chat. (OpenCode y
    // Antigravity sí pueden vivir fuera de una terminal de lienzo, p. ej. el servicio de OpenCode.)
    let guest = agent == "claude" && outside_lienzo();
    let client = if guest { None } else { HubClient::discover() };

    // La sesión vive en un Arc: si lienzo se reinicia (o aún no estaba abierto cuando arrancó
    // este puente), el latido detecta que el hub no la conoce y se vuelve a unir. Sin esto, un
    // puente de larga vida (el de OpenCode lo mantiene su servicio) quedaba mudo para siempre.
    let session: Arc<Mutex<String>> = Arc::new(Mutex::new(
        client.as_ref().map(|c| join_hub(c, &agent)).unwrap_or_default(),
    ));

    // Heartbeat so the hub knows this agent is alive (and re-join when it does not know us).
    if !guest {
        let sess = session.clone();
        let agent_name = agent.clone();
        let first = client.clone();
        std::thread::spawn(move || {
            let mut c = first;
            loop {
                std::thread::sleep(std::time::Duration::from_secs(8));
                if c.is_none() {
                    c = HubClient::discover();
                }
                let Some(cl) = c.clone() else { continue };
                let sid = sess.lock().map(|s| s.clone()).unwrap_or_default();
                let known = !sid.is_empty()
                    && cl
                        .post("/heartbeat", &json!({ "session_id": sid }))
                        .map(|v| v["known"].as_bool().unwrap_or(true))
                        .unwrap_or(false);
                if !known {
                    // El hub no nos conoce: unirse otra vez (descubriendo el hub vigente).
                    let fresh = HubClient::discover().unwrap_or(cl);
                    let nsid = join_hub(&fresh, &agent_name);
                    if !nsid.is_empty() {
                        if let Ok(mut s) = sess.lock() {
                            *s = nsid;
                        }
                        c = Some(fresh);
                    }
                }
            }
        });
    }

    // Telemetría de contexto para CLIs sin hooks (OpenCode, Codex): lee su
    // almacén local cada 12 s y lo reporta al hub sin ruido en el feed.
    if matches!(agent.as_str(), "opencode" | "codex") {
        if let Some(c) = client.clone() {
            let sess = session.clone();
            let agent_name = agent.clone();
            let cwd = std::env::current_dir()
                .map(|p| p.display().to_string())
                .unwrap_or_default();
            std::thread::spawn(move || {
                let mut win_cache: Option<(String, u64)> = None;
                let mut last: Option<(u64, u64)> = None;
                // Último mensaje de OpenCode ya sumado (-1 = aún sin línea base: lo anterior a
                // que arrancara el puente no se cuenta).
                let mut usage_mark: i64 = -1;
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(12));
                    let sid = sess.lock().map(|s| s.clone()).unwrap_or_default();
                    if sid.is_empty() {
                        continue;
                    }
                    if agent_name == "opencode" {
                        let items = opencode_usage(&cwd, &mut usage_mark);
                        if !items.is_empty() {
                            let _ = c.post("/usage", &json!({ "session_id": sid, "items": items }));
                        }
                    }
                    let Some(sample) = sample_telemetry(&agent_name, &cwd, &mut win_cache) else {
                        continue;
                    };
                    if last == Some((sample.used, sample.window)) {
                        continue;
                    }
                    last = Some((sample.used, sample.window));
                    let _ = c.post(
                        "/ctx",
                        &json!({
                            "session_id": sid,
                            "model": sample.model,
                            "ctx_tokens": sample.used,
                            "ctx_window": sample.window,
                        }),
                    );
                }
            });
        }
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
                Some(c) => {
                    let sid = session.lock().map(|s| s.clone()).unwrap_or_default();
                    Some(call_tool(c, &sid, &params))
                }
                None => Some(Ok(text_result(
                    if guest {
                        "Esta sesión de Claude no se abrió desde lienzo, así que no forma parte del equipo."
                    } else {
                        "La app de lienzo no está abierta: no puedo conectar con el equipo."
                    },
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

    let sid = session.lock().map(|s| s.clone()).unwrap_or_default();
    if let (Some(c), false) = (client, sid.is_empty()) {
        let _ = c.post("/leave", &json!({ "session_id": sid }));
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

    // Los hooks del proyecto también saltan en sesiones abiertas fuera de lienzo: esas no
    // publican nada ni reciben el contexto del equipo.
    if outside_lienzo() {
        return;
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
                // Herramientas de captura (MCP de navegador…): dónde guardaron la imagen.
                .or_else(|| input["filename"].as_str())
                .or_else(|| input["path"].as_str())
                .unwrap_or("");
            // Leer archivos es ruido, salvo cuando el agente mira una imagen (una captura):
            // eso sí se enseña en el chat.
            if tool == "Read" && !is_image_path(file) {
                return;
            }
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
        // Avisos de Claude que no piden nada («Claude Code login successful»): no lo bloquean.
        "waiting"
            if payload["message"]
                .as_str()
                .is_some_and(|m| m.to_lowercase().contains("successful")) =>
        {
            (
                "update",
                trunc(payload["message"].as_str().unwrap_or(""), 240),
                vec![],
            )
        }
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

    // Telemetría de contexto: Claude Code deja el uso real de tokens en el
    // transcript de la sesión; leemos su cola y lo mandamos junto al evento.
    let (model, ctx_tokens, ctx_window) = if agent == "claude" {
        transcript_usage(payload["transcript_path"].as_str().unwrap_or(""))
    } else {
        (None, None, None)
    };

    let mut body = json!({ "agent": agent, "kind": kind, "text": text, "files": files });
    // Id de la conversación del CLI: con él lienzo retoma la conversación del chat al reabrirlo.
    if !session_key.is_empty() {
        body["cli_session"] = json!(session_key);
    }
    if let Some(m) = &model {
        body["model"] = json!(m);
    }
    if let Some(t) = ctx_tokens {
        body["ctx_tokens"] = json!(t);
    }
    if let Some(w) = ctx_window {
        body["ctx_window"] = json!(w);
    }
    let _ = client.post("/event", &body);

    // Al acabar el turno, lo que el agente contestó en su terminal también va al chat
    // de lienzo: si no, una respuesta que no pasó por team_message no se ve en ningún sitio.
    if event == "stop" {
        // Claude Code lanza este hook antes de terminar de escribir su respuesta en el
        // transcript: si aún no está, se reintenta un momento.
        let path = payload["transcript_path"].as_str().unwrap_or("");
        let reply = payload["last_assistant_message"]
            .as_str()
            .map(|s| trunc(s.trim(), 6000))
            .filter(|s| !s.is_empty())
            .or_else(|| {
                (0..12).find_map(|i| {
                    if i > 0 {
                        std::thread::sleep(std::time::Duration::from_millis(250));
                    }
                    transcript_reply(path)
                })
            });
        if let Some(reply) = reply {
            let _ = client.post(
                "/event",
                &json!({ "agent": agent, "kind": "reply", "text": reply, "files": [] }),
            );
        }
    }

    // Consumo de tokens del turno (Claude Code lo deja en su transcript).
    if event == "stop" && agent == "claude" {
        let items = transcript_turn_usage(payload["transcript_path"].as_str().unwrap_or(""));
        if !items.is_empty() {
            let _ = client.post("/usage", &json!({ "agent": agent, "items": items }));
        }
    }

    let cache_path = hook_cache_path(&agent, &session_key);
    let mut cache = cache_path.as_deref().map(load_cache).unwrap_or_else(|| json!({}));

    // Broadcasts the user sent to the whole team that this session hasn't seen.
    let pending = fetch_pending(&client, &agent, &session_key);
    // Mensajes de otros agentes para este (su buzón).
    let inbox = fetch_inbox(&client, &agent);

    // On stop: if there are pending team messages, keep the turn alive with them.
    if event == "stop" && !pending.is_empty() {
        let joined: Vec<String> = pending.iter().map(|(_, t)| format!("- {}", t)).collect();
        let max_seq = pending.iter().map(|(s, _)| *s).max().unwrap_or(0);
        ack_pending(&client, &agent, &session_key, max_seq);
        let mut reason = format!(
            "📣 El usuario envió este mensaje a TODO el equipo (te llega ahora):\n{}\n\nActúa según tu rol: si eres el líder, reparte y coordina; si no, ejecuta tu parte y publícala con team_update. Mira team_context para el estado del equipo (compañeros, tareas y reservas); reserva los archivos con team_claim_files antes de editarlos y habla con los demás con team_message.",
            joined.join("\n")
        );
        if !inbox.is_empty() {
            reason.push_str(&format!("\n\n{}", inbox_text(&inbox)));
            ack_inbox(&client, &agent, &inbox);
        }
        println!("{}", json!({ "decision": "block", "reason": reason }));
        return;
    }

    // Al acabar el turno con mensajes de compañeros sin leer, el agente sigue para atenderlos.
    // Con tope: tres seguidos sin que el usuario escriba, para que dos agentes no se queden
    // contestándose en bucle.
    if event == "stop" {
        let streak = cache["inbox_blocks"].as_u64().unwrap_or(0);
        // Solo un mensaje dirigido a él merece otro turno; los de «todo el equipo» esperan a su
        // próximo mensaje o herramienta (cada turno extra relee todo su contexto).
        if inbox.iter().any(|m| m.3) && streak < 3 {
            ack_inbox(&client, &agent, &inbox);
            cache["inbox_blocks"] = json!(streak + 1);
            if let Some(p) = &cache_path {
                save_cache(p, &cache);
            }
            println!(
                "{}",
                json!({
                    "decision": "block",
                    "reason": format!(
                        "{}\n\nAtiéndelos si hace falta (team_message con to y reply_to) y vuelve a lo tuyo. No contestes agradecimientos ni confirmaciones.",
                        inbox_text(&inbox)
                    )
                })
            );
        }
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
            // Una sesión nueva (o recién compactada) no recuerda nada: contexto completo.
            // En cada mensaje después, solo lo que cambió desde el último.
            let (mut ctx, saved) = context_for_prompt(&state, &agent, &mut cache, event == "session");
            cache["inbox_blocks"] = json!(0);
            if !pending.is_empty() {
                ctx.push_str("\n📣 Mensajes del usuario para todo el equipo (nuevos):\n");
                for (_, t) in &pending {
                    ctx.push_str(&format!("- {}\n", t));
                }
                let max_seq = pending.iter().map(|(s, _)| *s).max().unwrap_or(0);
                ack_pending(&client, &agent, &session_key, max_seq);
            }
            if !inbox.is_empty() {
                ctx.push_str(&format!("\n{}\n", inbox_text(&inbox)));
                ack_inbox(&client, &agent, &inbox);
            }
            if let Some(p) = &cache_path {
                save_cache(p, &cache);
            }
            if saved > 0 {
                let _ = client.post("/usage", &json!({ "agent": agent, "saved": saved }));
            }
            if !ctx.trim().is_empty() {
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
}

// ---------------------------------------------------------------------------
// Memoria del hook entre llamadas, contexto por diferencias y buzón
// ---------------------------------------------------------------------------

/// Archivo temporal con lo que el hook ya inyectó en esta conversación.
fn hook_cache_path(agent: &str, session_key: &str) -> Option<std::path::PathBuf> {
    let safe: String = session_key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(64)
        .collect();
    if safe.is_empty() {
        return None;
    }
    let dir = std::env::temp_dir().join("lienzo-hooks");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join(format!("{agent}-{safe}.json")))
}

fn load_cache(path: &std::path::Path) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| json!({}))
}

fn save_cache(path: &std::path::Path, v: &Value) {
    let _ = std::fs::write(path, v.to_string());
}

fn fingerprint(text: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h);
    format!("{:x}", h.finish())
}

/// Lo que una parte del contexto dice cuando se queda vacía (si antes no lo estaba).
fn emptied_note(key: &str) -> &'static str {
    match key {
        "tasks" => "Ya no quedan tareas abiertas.\n",
        "claims" => "Ya no hay archivos reservados.\n",
        "memory" => "La memoria del proyecto quedó vacía.\n",
        _ => "",
    }
}

/// Contexto del equipo para un mensaje: completo la primera vez (`full`) y, después, solo
/// las partes que cambiaron y la actividad nueva. Devuelve el texto y los tokens que se
/// ahorraron frente a inyectar el contexto completo (estimados a 4 caracteres por token).
fn context_for_prompt(state: &Value, me: &str, cache: &mut Value, full: bool) -> (String, u64) {
    let sections = context_sections(state, me);
    let complete = render_context(state, me);
    let top_seq = state["events"]
        .as_array()
        .map(|l| l.iter().filter_map(|e| e["seq"].as_u64()).max().unwrap_or(0))
        .unwrap_or(0);
    let mut fps = serde_json::Map::new();
    for (k, t) in &sections {
        fps.insert(k.to_string(), json!(fingerprint(t)));
    }
    let known = !full && cache["fp"].is_object();
    let out = if !known {
        complete.clone()
    } else {
        let mut d = String::new();
        for (k, t) in &sections {
            if cache["fp"][*k].as_str() == fps[*k].as_str() {
                continue;
            }
            if t.is_empty() {
                d.push_str(emptied_note(k));
            } else {
                d.push_str(t);
            }
        }
        d.push_str(&context_events(state, cache["seq"].as_u64().unwrap_or(0), me));
        if d.is_empty() {
            String::new()
        } else {
            format!("[Equipo lienzo · novedades desde tu último mensaje]\n{d}")
        }
    };
    cache["fp"] = serde_json::Value::Object(fps);
    cache["seq"] = json!(top_seq);
    let saved = if known {
        (complete.chars().count().saturating_sub(out.chars().count()) / 4) as u64
    } else {
        0
    };
    (out, saved)
}

/// Mensajes sin leer del buzón del agente: (seq, de, texto).
fn fetch_inbox(client: &HubClient, agent: &str) -> Vec<(u64, String, String, bool)> {
    if agent.is_empty() {
        return vec![];
    }
    client
        .get(&format!("/inbox?agent={}", url_part(agent)))
        .ok()
        .and_then(|v| {
            v["messages"].as_array().map(|l| {
                l.iter()
                    .map(|m| {
                        (
                            m["seq"].as_u64().unwrap_or(0),
                            m["from"].as_str().unwrap_or("?").to_string(),
                            m["text"].as_str().unwrap_or("").to_string(),
                            m["to"].is_string(),
                        )
                    })
                    .collect()
            })
        })
        .unwrap_or_default()
}

fn inbox_text(list: &[(u64, String, String, bool)]) -> String {
    let mut out = format!("📬 Mensajes de tus compañeros ({}):\n", list.len());
    for (seq, from, text, _) in list {
        out.push_str(&format!("- #{seq} de {from}: {}\n", trunc(text, 1200)));
    }
    out.push_str("Para responder: team_message con to = quien escribió y reply_to = su número.");
    out
}

fn ack_inbox(client: &HubClient, agent: &str, list: &[(u64, String, String, bool)]) {
    if let Some(max) = list.iter().map(|m| m.0).max() {
        let _ = client.post("/inbox/ack", &json!({ "agent": agent, "seq": max }));
    }
}

/// Gasto de tokens del último turno en un transcript de Claude Code: cada mensaje del
/// asistente desde el último mensaje del usuario, una vez por id (el hub no repite ids).
fn transcript_turn_usage(path: &str) -> Vec<Value> {
    if path.is_empty() {
        return vec![];
    }
    let Some(text) = read_tail(std::path::Path::new(path), 512 * 1024) else {
        return vec![];
    };
    let mut by_id: Vec<(String, [u64; 4])> = Vec::new();
    for line in text.lines().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v["isSidechain"].as_bool().unwrap_or(false) {
            continue;
        }
        match v["type"].as_str().unwrap_or("") {
            "user" => {
                let content = &v["message"]["content"];
                let is_prompt = content.is_string()
                    || content
                        .as_array()
                        .is_some_and(|b| b.iter().any(|x| x["type"].as_str() == Some("text")));
                if is_prompt {
                    break;
                }
            }
            "assistant" => {
                let id = v["message"]["id"].as_str().unwrap_or("").to_string();
                let u = &v["message"]["usage"];
                if id.is_empty() || u.is_null() {
                    continue;
                }
                let vals = [
                    u["input_tokens"].as_u64().unwrap_or(0),
                    u["output_tokens"].as_u64().unwrap_or(0),
                    u["cache_read_input_tokens"].as_u64().unwrap_or(0),
                    u["cache_creation_input_tokens"].as_u64().unwrap_or(0),
                ];
                // Cada bloque de una respuesta va en su línea con el mismo id: vale el mayor.
                match by_id.iter_mut().find(|(k, _)| *k == id) {
                    Some((_, cur)) => {
                        for i in 0..4 {
                            cur[i] = cur[i].max(vals[i]);
                        }
                    }
                    None => by_id.push((id, vals)),
                }
            }
            _ => {}
        }
    }
    by_id
        .into_iter()
        .map(|(id, v)| {
            json!({
                "id": format!("cc:{id}"),
                "input": v[0], "output": v[1], "cache_read": v[2], "cache_write": v[3],
            })
        })
        .collect()
}

/// Lee la cola de un archivo de texto (la primera línea puede venir cortada;
/// los consumidores saltan JSON inválidos).
fn read_tail(path: &std::path::Path, max: u64) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let start = meta.len().saturating_sub(max);
    let mut file = std::fs::File::open(path).ok()?;
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).to_string())
}

/// Lee la primera línea completa de un archivo de texto. La `session_meta` de
/// Codex puede superar los 8 KB (instrucciones incluidas), así que nada de
/// cabeceras de tamaño fijo que la trunquen.
fn read_first_line(path: &std::path::Path) -> Option<String> {
    use std::io::BufRead;
    let file = std::fs::File::open(path).ok()?;
    let mut reader = std::io::BufReader::new(file);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    if line.is_empty() {
        return None;
    }
    Some(line)
}

/// Uso de contexto del último turno de un transcript de Claude Code (JSONL).
/// Devuelve (modelo, tokens de contexto usados, ventana del modelo).
fn transcript_usage(path: &str) -> (Option<String>, Option<u64>, Option<u64>) {
    if path.is_empty() {
        return (None, None, None);
    }
    // Solo la cola: los transcripts crecen mucho (resultados de herramientas).
    let Some(text) = read_tail(std::path::Path::new(path), 512 * 1024) else {
        return (None, None, None);
    };
    for line in text.lines().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v["type"].as_str() != Some("assistant") || v["isSidechain"].as_bool().unwrap_or(false) {
            continue;
        }
        let usage = &v["message"]["usage"];
        let used = usage["input_tokens"].as_u64().unwrap_or(0)
            + usage["cache_read_input_tokens"].as_u64().unwrap_or(0)
            + usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);
        if used == 0 {
            continue;
        }
        let model = v["message"]["model"].as_str().unwrap_or("").to_string();
        let model = if model.is_empty() { None } else { Some(model) };
        let mut window = model.as_deref().map(model_window).unwrap_or(200_000);
        // El transcript no dice si la sesión usa la variante de 1M de contexto: si el uso ya
        // pasa de 200k, la ventana no puede ser de 200k (si no, saldría un 350 % absurdo).
        if used > window {
            window = 1_000_000;
        }
        return (model, Some(used), Some(window));
    }
    (None, None, None)
}

/// Texto de la última respuesta del agente en un transcript de Claude Code (JSONL).
/// Cada bloque de una respuesta va en su propia línea con el mismo `message.id`:
/// se juntan los de texto de esa última respuesta, en orden.
fn transcript_reply(path: &str) -> Option<String> {
    if path.is_empty() {
        return None;
    }
    let text = read_tail(std::path::Path::new(path), 512 * 1024)?;
    let mut id: Option<String> = None;
    let mut parts: Vec<String> = Vec::new();
    for line in text.lines().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v["isSidechain"].as_bool().unwrap_or(false) {
            continue;
        }
        let kind = v["type"].as_str().unwrap_or("");
        if kind == "user" {
            // Ya tenemos la respuesta, o llegamos al mensaje que abrió el turno sin
            // encontrar texto (la respuesta de un turno anterior no se repite).
            let content = &v["message"]["content"];
            let is_prompt = content.is_string()
                || content
                    .as_array()
                    .is_some_and(|b| b.iter().any(|x| x["type"].as_str() == Some("text")));
            if id.is_some() || is_prompt {
                break;
            }
            continue;
        }
        if kind != "assistant" {
            continue;
        }
        let msg_id = v["message"]["id"].as_str().unwrap_or("").to_string();
        if let Some(cur) = &id {
            if *cur != msg_id {
                break;
            }
        }
        let texts: Vec<String> = v["message"]["content"]
            .as_array()
            .map(|blocks| {
                blocks
                    .iter()
                    .filter(|b| b["type"].as_str() == Some("text"))
                    .filter_map(|b| b["text"].as_str().map(|s| s.trim().to_string()))
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        if texts.is_empty() {
            continue;
        }
        if id.is_none() {
            id = Some(msg_id);
        }
        parts.push(texts.join("\n\n"));
    }
    if parts.is_empty() {
        return None;
    }
    parts.reverse();
    Some(trunc(&parts.join("\n\n"), 6000))
}

/// Tamaño de ventana de contexto por modelo (200k por defecto; `…-1m` → 1M).
fn model_window(model: &str) -> u64 {
    if model.to_lowercase().contains("1m") {
        1_000_000
    } else {
        200_000
    }
}

// ---------------------------------------------------------------------------
// Telemetría para CLIs sin hooks (OpenCode, Codex)
// ---------------------------------------------------------------------------

struct CtxSample {
    model: Option<String>,
    used: u64,
    window: u64,
}

fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
}

/// Normaliza una ruta para comparar directorios entre CLIs.
fn norm_dir(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

fn sample_telemetry(
    agent: &str,
    cwd: &str,
    win_cache: &mut Option<(String, u64)>,
) -> Option<CtxSample> {
    match agent {
        "opencode" => opencode_ctx(cwd, win_cache),
        "codex" => codex_ctx(cwd),
        _ => None,
    }
}

/// Contexto real de OpenCode: última sesión de este directorio en opencode.db
/// (tokens del último mensaje del asistente) + ventana del catálogo kv.
fn opencode_ctx(cwd: &str, win_cache: &mut Option<(String, u64)>) -> Option<CtxSample> {
    let db = home_dir()?.join(".local/share/opencode/opencode.db");
    if !db.is_file() {
        return None;
    }
    let con = rusqlite::Connection::open_with_flags(
        &db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    let want = norm_dir(cwd);
    let session: String = con
        .query_row(
            "select id from session_v2 where lower(replace(directory, '\\', '/')) = ?1 \
             order by time_updated desc limit 1",
            [&want],
            |r| r.get(0),
        )
        .ok()?;
    // El mensaje más nuevo puede estar en streaming (tokens: null), así que
    // buscamos hacia atrás el último que ya tenga telemetría de tokens.
    let mut stmt = con
        .prepare(
            "select data from session_message where session_id = ?1 and type = 'assistant' \
             order by rowid desc limit 25",
        )
        .ok()?;
    let rows = stmt
        .query_map([&session], |r| r.get::<_, String>(0))
        .ok()?;
    let mut found: Option<Value> = None;
    for row in rows.flatten() {
        let Ok(v) = serde_json::from_str::<Value>(&row) else {
            continue;
        };
        if v["tokens"].is_null() {
            continue;
        }
        found = Some(v);
        break;
    }
    let v = found?;
    let t = &v["tokens"];
    if t.is_null() {
        return None;
    }
    let used = t["input"].as_u64().unwrap_or(0)
        + t["cache"]["read"].as_u64().unwrap_or(0)
        + t["cache"]["write"].as_u64().unwrap_or(0);
    if used == 0 {
        return None;
    }
    let model = v["model"]["id"].as_str().map(|s| s.to_string());
    let window = match &model {
        Some(id) => {
            let cached = win_cache.as_ref().filter(|(c, _)| c == id).map(|(_, w)| *w);
            match cached {
                Some(w) => w,
                None => {
                    let w = opencode_window(&con, id).unwrap_or(200_000);
                    *win_cache = Some((id.clone(), w));
                    w
                }
            }
        }
        None => 200_000,
    };
    Some(CtxSample { model, used, window })
}

/// Gasto de los mensajes nuevos de OpenCode en este directorio, desde `mark` (rowid).
fn opencode_usage(cwd: &str, mark: &mut i64) -> Vec<Value> {
    let Some(db) = home_dir().map(|h| h.join(".local/share/opencode/opencode.db")) else {
        return vec![];
    };
    if !db.is_file() {
        return vec![];
    }
    let Ok(con) = rusqlite::Connection::open_with_flags(
        &db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return vec![];
    };
    let want = norm_dir(cwd);
    let scope = "session_id in (select id from session_v2 where lower(replace(directory, '\\', '/')) = ?1)";
    if *mark < 0 {
        *mark = con
            .query_row(
                &format!("select coalesce(max(rowid), 0) from session_message where type = 'assistant' and {scope}"),
                [&want],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(0);
        return vec![];
    }
    let Ok(mut stmt) = con.prepare(&format!(
        "select rowid, data from session_message where type = 'assistant' and rowid > ?2 and {scope} \
         order by rowid asc limit 200"
    )) else {
        return vec![];
    };
    let Ok(rows) = stmt.query_map(rusqlite::params![&want, *mark], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
    }) else {
        return vec![];
    };
    let mut out = Vec::new();
    for (rowid, data) in rows.flatten() {
        let Ok(v) = serde_json::from_str::<Value>(&data) else {
            *mark = rowid;
            continue;
        };
        let t = &v["tokens"];
        // Aún escribiéndose: se mira en la próxima vuelta.
        if t.is_null() {
            break;
        }
        *mark = rowid;
        out.push(json!({
            "id": format!("oc:{rowid}"),
            "input": t["input"].as_u64().unwrap_or(0),
            "output": t["output"].as_u64().unwrap_or(0) + t["reasoning"].as_u64().unwrap_or(0),
            "cache_read": t["cache"]["read"].as_u64().unwrap_or(0),
            "cache_write": t["cache"]["write"].as_u64().unwrap_or(0),
        }));
    }
    out
}

/// `limit.context` del modelo en el catálogo de OpenCode (tabla kv).
fn opencode_window(con: &rusqlite::Connection, model_id: &str) -> Option<u64> {
    let catalog: String = con
        .query_row(
            "select value from kv where key = 'models-dev:catalog'",
            [],
            |r| r.get(0),
        )
        .ok()?;
    let v: Value = serde_json::from_str(&catalog).ok()?;
    let body: Value = serde_json::from_str(v["body"].as_str()?).ok()?;
    for (_, provider) in body.as_object()? {
        if let Some(w) = provider["models"][model_id]["limit"]["context"].as_u64() {
            return Some(w);
        }
    }
    None
}

/// Contexto real de Codex: el rollout vivo más reciente cuyo cwd coincide,
/// con el último `token_count` (prompt + salida del último turno).
fn codex_ctx(cwd: &str) -> Option<CtxSample> {
    let root = home_dir()?.join(".codex/sessions");
    if !root.is_dir() {
        return None;
    }
    let (mtime, path) = newest_jsonl(&root, 4)?;
    if mtime.elapsed().map(|d| d.as_secs() > 900).unwrap_or(true) {
        return None;
    }
    let first = read_first_line(&path)?;
    let meta: Value = serde_json::from_str(&first).ok()?;
    let cwd_meta = meta["payload"]["cwd"].as_str()?;
    if norm_dir(cwd_meta) != norm_dir(cwd) {
        return None;
    }
    let tail = read_tail(&path, 512 * 1024)?;
    let mut model: Option<String> = None;
    for line in tail.lines().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if model.is_none() {
            model = v["payload"]["model"].as_str().map(|s| s.to_string());
        }
        if v["type"].as_str() != Some("event_msg") {
            continue;
        }
        let p = &v["payload"];
        if p["type"].as_str() != Some("token_count") {
            continue;
        }
        let used = p["info"]["last_token_usage"]["total_tokens"].as_u64()?;
        if used == 0 {
            continue;
        }
        let window = p["info"]["model_context_window"]
            .as_u64()
            .filter(|w| *w > 0)
            .unwrap_or(200_000);
        return Some(CtxSample { model, used, window });
    }
    None
}

/// El .jsonl más reciente bajo un árbol de carpetas (profundidad acotada).
fn newest_jsonl(
    dir: &std::path::Path,
    depth: u32,
) -> Option<(std::time::SystemTime, std::path::PathBuf)> {
    if depth == 0 {
        return None;
    }
    let mut best: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let path = e.path();
        let Ok(meta) = e.metadata() else { continue };
        let cand = if meta.is_dir() {
            newest_jsonl(&path, depth - 1)
        } else if path.extension().map(|x| x == "jsonl").unwrap_or(false) {
            meta.modified().ok().map(|t| (t, path))
        } else {
            None
        };
        if let Some((t, p)) = cand {
            let better = best.as_ref().map(|(bt, _)| t > *bt).unwrap_or(true);
            if better {
                best = Some((t, p));
            }
        }
    }
    best
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
