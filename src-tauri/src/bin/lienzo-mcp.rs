#![recursion_limit = "512"]
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
    } else if args.first().map(|a| a == "statusline").unwrap_or(false) {
        statusline_mode();
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

/// Fortalezas típicas de cada CLI, si el usuario no escribió las suyas (Ajustes → Equipo).
fn default_strength(name: &str) -> &'static str {
    let n = name.to_lowercase();
    if n.contains("claude") {
        "diseño, arquitectura y lo difícil"
    } else if n.contains("opencode") {
        "trabajo mecánico y en volumen (modelos gratis)"
    } else if n.contains("antigravity") || n.contains("agy") || n.contains("gemini") {
        "leer mucho, buscar en la web y contexto largo"
    } else if n.contains("codex") {
        "lo difícil junto al líder: código complejo, bugs y refactors (cuota propia)"
    } else {
        ""
    }
}

/// Cuánto le queda a un agente, en escalones (no en %: los hooks reinyectan una sección cuando
/// cambia, y un número que sube cada minuto la reenviaría sin parar).
fn usage_step(limits: &Value, now: u64) -> Option<String> {
    let windows = limits["windows"].as_array()?;
    let worst = windows
        .iter()
        .max_by(|a, b| a["used_pct"].as_f64().unwrap_or(0.0).total_cmp(&b["used_pct"].as_f64().unwrap_or(0.0)))?;
    let pct = worst["used_pct"].as_f64().unwrap_or(0.0);
    let label = worst["label"].as_str().unwrap_or("uso");
    let reset = worst["resets_at"].as_u64().filter(|t| *t > now).map(|t| {
        let h = (t - now) / 3_600_000;
        if h >= 48 { format!(", se reinicia en {} días", h / 24) } else if h >= 1 { format!(", se reinicia en {h} h") } else { ", se reinicia en menos de 1 h".into() }
    });
    Some(if pct >= 90.0 {
        format!("⛔ {label} casi agotado{}: no le des trabajo pesado", reset.unwrap_or_default())
    } else if pct >= 70.0 {
        format!("⚠ {label} alto{}: solo lo que necesite él", reset.unwrap_or_default())
    } else if pct >= 40.0 {
        format!("{label} a medias")
    } else {
        format!("{label} holgado")
    })
}

/// Quién está en línea y qué conviene darle: modelo, cuota que le queda y fortalezas.
fn team_roster(state: &Value, now: u64) -> String {
    let empty = vec![];
    let mut names: Vec<String> = state["agents"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .filter(|a| a["online"].as_bool().unwrap_or(false))
        .filter_map(|a| a["name"].as_str().map(|s| s.to_string()))
        .collect();
    names.sort();
    names.dedup();
    if names.is_empty() {
        return "No hay otros agentes en línea ahora mismo.\n".to_string();
    }
    let mut out = String::from("Agentes en línea (para repartir: skill lienzo-reparto):\n");
    for name in &names {
        let mut parts: Vec<String> = Vec::new();
        let model = state["agents"]
            .as_array()
            .unwrap_or(&empty)
            .iter()
            .filter(|a| a["name"].as_str() == Some(name))
            .find_map(|a| a["model"].as_str().filter(|m| !m.is_empty()).map(|m| m.to_string()));
        if let Some(m) = model {
            parts.push(m);
        }
        match usage_step(&state["limits"][name.as_str()], now) {
            Some(u) => {
                parts.push(format!("uso: {u}"));
                // El ritmo (en escalones, para no reinyectar el contexto a cada punto) dice quién
                // de los fuertes (Claude y Codex) debe llevarse lo difícil para que duren las dos cuotas.
                let low = name.to_lowercase();
                let pace = lienzo_lib::hub::limits_pace(&state["limits"][name.as_str()], now);
                if low.contains("claude") || low.contains("codex") {
                parts.push(
                    if pace == f64::INFINITY {
                        "ritmo: sin margen".into()
                    } else if pace >= 15.0 {
                        "ritmo: gasta rápido".into()
                    } else if pace <= -15.0 {
                        "ritmo: le sobra".into()
                    } else {
                        "ritmo: parejo".to_string()
                    },
                );
                }
            }
            None if name.to_lowercase().contains("opencode") => parts.push("uso: sin límite (modelos gratis)".into()),
            None => {}
        }
        let own = state["strengths"][name.as_str()].as_str().filter(|s| !s.trim().is_empty());
        let strength = own.map(|s| trunc(s, 120)).unwrap_or_else(|| default_strength(name).to_string());
        if !strength.is_empty() {
            parts.push(format!("se le da bien: {strength}"));
        }
        out.push_str(&format!("- {name}{}\n", if parts.is_empty() { String::new() } else { format!(" · {}", parts.join(" · ")) }));
    }
    out
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
revisa cada entrega con team_task_review (máx. {rounds} rondas de fix) y haz tú solo lo difícil. Pauta: skill lienzo-director.\n\
Ahorro: el aviso 🔎 de cada entrega ya trae su diff; para comprobar algo más usa Grep o Read con offset/limit, nunca un archivo entero.\n\
Cuota del usuario: nada de bancos de pruebas ni scripts que llamen en bucle a un modelo de pago (claude -p…), lo ejecute quien lo ejecute; \
usa los modelos gratis del equipo (opencode run) o pregunta antes con team_ask_user cuántas ejecuciones y con qué modelo. Tampoco subagentes tuyos: reparte.\n"
                ));
            } else {
                lead.push_str(&format!(
                    "Modo director: {leader} reparte y revisa tus entregas. Sigue el encargo al pie de la letra, \
entrega con evidencia real y corrige lo que te pida. \
No ejecutes en bucle nada que llame a un modelo de pago (claude -p…): gasta la cuota del usuario; una prueba y pregunta.\n"
                ));
                if me.eq_ignore_ascii_case("codex") {
                    lead.push_str(
                        "Eres además el primer revisor de las entregas simple y media: cuando te llegue un 🔎, \
revísala (skill lienzo-revision) y decide con team_task_review: ok, fix o lider (lo que dudes o sea delicado).\n",
                    );
                }
            }
        }
    }
    if let Some(charter) = state["charter"].as_str().filter(|s| !s.is_empty()) {
        lead.push_str(&format!("Normas del equipo:\n{}\n", trunc(charter, 520)));
    }
    sections.push(("lead", lead));

    sections.push(("online", team_roster(state, now_ms())));

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
    notes.sort_by_key(|a| std::cmp::Reverse(a.0));
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

/// Cuánto espera `team_ask_user` a que contestes antes de soltar el turno del agente.
const ASK_WAIT: std::time::Duration = std::time::Duration::from_secs(75);

/// Pregunta al usuario y espera su respuesta un rato (consultando al hub). Si no llega, el agente
/// acaba su turno y lienzo le escribirá la respuesta en la terminal cuando la haya.
fn ask_user(client: &HubClient, sid: &str, args: &Value) -> Result<Value, String> {
    let r = client.post(
        "/ask",
        &json!({ "session_id": sid, "questions": args["questions"], "context": args["context"].as_str().unwrap_or("") }),
    )?;
    let id = r["id"].as_u64().ok_or("el hub no devolvió la pregunta")?;
    let start = std::time::Instant::now();
    while start.elapsed() < ASK_WAIT {
        std::thread::sleep(std::time::Duration::from_millis(1500));
        if let Ok(s) = client.get(&format!("/ask?id={id}"))
            && s["done"].as_bool() == Some(true) {
                return Ok(text_result(s["text"].as_str().unwrap_or(""), false));
            }
    }
    let d = client.post("/ask/detach", &json!({ "id": id }))?;
    if d["done"].as_bool() == Some(true) {
        return Ok(text_result(d["text"].as_str().unwrap_or(""), false));
    }
    Ok(text_result(
        &format!(
            "Pregunta q{id} en el chat de lienzo, aún sin respuesta. Acaba tu turno ahora con una línea («Espero tu respuesta en el panel»): no sigas a ciegas. Cuando el usuario conteste, te llegará escrita en tu terminal."
        ),
        false,
    ))
}

fn render_skills(v: &Value) -> String {
    let empty = vec![];
    let list = v["skills"].as_array().unwrap_or(&empty);
    let mut on = Vec::new();
    let mut off = Vec::new();
    for s in list {
        let name = s["name"].as_str().unwrap_or("");
        let cat = s["category"].as_str().unwrap_or("");
        let desc = trunc(s["description"].as_str().unwrap_or(""), 110);
        if s["enabled"].as_bool().unwrap_or(false) {
            let mode = if s["mode"].as_str() == Some("always") { "obligatoria" } else { "a demanda" };
            on.push(format!("- `{name}` ({cat}, {mode}): {desc}"));
        } else {
            off.push(format!("- `{name}` ({cat}): {desc}"));
        }
    }
    let mut out = format!("## Skills encendidas ({})\n{}\n", on.len(), on.join("\n"));
    if !off.is_empty() {
        out.push_str(&format!(
            "\n## En la biblioteca, apagadas ({})\n{}\n\nSi alguna ayudaría, propónla con team_skill_propose (source = su nombre).",
            off.len(),
            off.join("\n")
        ));
    }
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
                // Tus respuestas van enteras: recortadas, el agente se quedaría con la primera.
                if e["kind"].as_str() == Some("answer") {
                    trunc(&e["text"].as_str().unwrap_or("").replace('\n', " · "), 1500)
                } else {
                    trunc(&e["text"].as_str().unwrap_or("").replace('\n', " "), 160)
                },
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
    if status == "draft" {
        return "borrador·sin encargo".to_string();
    }
    if status == "plan" {
        return "plan·espera el OK del usuario".to_string();
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
    if let Some(c) = client
        && let Ok(state) = c.get("/state?limit=1") {
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

/// Herramientas que casi nunca hacen falta: con el servidor en `alwaysLoad` (Claude Code), estas
/// siguen tras el buscador de herramientas para no ocupar contexto en cada petición.
const RARE_TOOLS: &[&str] = &[
    "team_schedule_create",
    "team_schedule_list",
    "team_feed_search",
    "team_task_handoff",
    "team_plan_approve",
    "team_memory_list",
    "team_memory_propose",
    "team_memory_save",
    "team_memory_resolve",
    "team_memory_forget",
    "team_skill_list",
    "team_skill_propose",
];

/// Marca las herramientas raras para que Claude Code las difiera (`_meta` es estándar en MCP: los
/// demás clientes lo ignoran).
fn with_load_hints(mut catalog: Value) -> Value {
    if let Some(list) = catalog.as_array_mut() {
        for t in list {
            if t["name"].as_str().is_some_and(|n| RARE_TOOLS.contains(&n)) {
                t["_meta"] = json!({ "anthropic/alwaysLoad": false });
            }
        }
    }
    catalog
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
            "name": "team_task_brief",
            "description": "Solo el líder: escribe el encargo de una tarea (p. ej. una que creó el usuario sin detalles). Un borrador queda listo para repartir.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer" },
                    "notes": { "type": "string", "description": "El encargo completo (plantilla de lienzo-director)" },
                    "level": { "type": "string", "enum": ["simple", "media", "dificil"] },
                    "assign": { "type": "string", "description": "Agente que debe hacerla (opcional)" }
                },
                "required": ["id", "notes"]
            }
        },
        {
            "name": "team_task_review",
            "description": "Modo director: decide sobre una entrega en revisión (el líder, o el primer revisor al que le llegó el aviso 🔎). ok = aprobada; fix = vuelve a su dueño con tus órdenes en `notes`; take = la terminas tú (solo el líder); lider = el primer revisor se la pasa al líder.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer" },
                    "verdict": { "type": "string", "enum": ["ok", "fix", "take", "lider"] },
                    "notes": { "type": "string", "description": "Con fix: órdenes concretas y numeradas (archivo, qué cambiar, cómo comprobarlo)" }
                },
                "required": ["id", "verdict"]
            }
        },
        {
            "name": "team_schedule_create",
            "description": "Programa una tarea que se repite (revisar algo cada mañana, actualizar un informe…). Escribe el encargo una vez, completo y con rutas absolutas; Prometeo crea una tarea normal a cada hora y la reparte (mejor a un agente económico con `assign`). Queda PENDIENTE hasta que el usuario la apruebe en la sección Programadas. Pregúntale antes si no te la pidió.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "notes": { "type": "string", "description": "El encargo de cada ejecución: qué hacer, archivos, criterio de hecho y cómo comprobarlo" },
                    "every": { "type": "string", "description": "«cada 30 min», «cada 2 h», «cada día 9:00», «lun-vie 8:30» o «lun,mie,vie 18:00» (mínimo 15 min)" },
                    "assign": { "type": "string", "description": "Agente que la ejecuta (vacío = el primero libre)" },
                    "level": { "type": "string", "enum": ["simple", "media", "dificil"] },
                    "model": { "type": "string", "description": "Si la ejecuta Claude: sonnet, haiku u opus; si la ejecuta Antigravity u OpenCode, el id de su modelo (se reinicia con él). Vacío = el suyo" },
                    "daily_cap": { "type": "integer", "description": "Máximo de ejecuciones al día (6 por defecto)" }
                },
                "required": ["title", "notes", "every"]
            }
        },
        {
            "name": "team_schedule_list",
            "description": "Lista las tareas programadas: frecuencia, estado (pendiente, activa, en pausa), a quién van y cuántas veces se ejecutaron.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "team_feed_search",
            "description": "Busca en todo el historial del equipo, también lo que ya no sale en team_feed (que solo muestra lo último): decisiones, entregas, mensajes. Todas las palabras de `query` deben aparecer; `#67` encuentra lo de la tarea 67.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Palabras a buscar (o #id de tarea)" },
                    "agent": { "type": "string", "description": "Solo de este agente (opcional)" },
                    "limit": { "type": "integer", "description": "Máximo de resultados (20 por defecto, hasta 50)" }
                },
                "required": ["query"]
            }
        },
        {
            "name": "team_task_handoff",
            "description": "Solo el líder: pasa una tarea tomada por otro agente que se paró o se bloqueó a `to` (o la deja libre para quien esté libre). Su antiguo dueño recibe la orden de dejarla.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer" },
                    "to": { "type": "string", "description": "Agente que debe hacerla (vacío = el primero libre)" },
                    "notes": { "type": "string", "description": "Por qué se la pasas (corto)" }
                },
                "required": ["id"]
            }
        },
        {
            "name": "team_plan_approve",
            "description": "Solo el líder, en modo plan: cuando el usuario apruebe el plan por escrito («sí», «dale», «sigue»), suelta sus tareas para que se repartan. Hasta entonces nadie puede tomarlas.",
            "inputSchema": { "type": "object", "properties": {} }
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
            "name": "team_ask_user",
            "description": "Pregunta al usuario cuando una decisión dependa de su gusto o de información que no tienes (diseño, alcance, prioridades, tecnología, qué incluir). Le sale en el chat de lienzo un panel con tus opciones para que elija (siempre puede escribir otra). Hasta 4 preguntas a la vez, cada una con 2–4 opciones concretas y distintas; pon primero la que recomiendas y di por qué en su description. En modo plan, pregunta ANTES de proponer el plan si algo no está claro. Espera la respuesta un rato; si no llega, acaba tu turno: te llegará escrita en tu terminal.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "context": { "type": "string", "description": "Una frase: para qué necesitas saberlo (opcional)" },
                    "questions": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 4,
                        "items": {
                            "type": "object",
                            "properties": {
                                "question": { "type": "string", "description": "La pregunta, clara y terminada en «?»" },
                                "header": { "type": "string", "description": "Etiqueta de 1–2 palabras («Estilo», «Alcance»)" },
                                "options": {
                                    "type": "array",
                                    "minItems": 2,
                                    "maxItems": 4,
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "label": { "type": "string", "description": "La opción en 1–5 palabras" },
                                            "description": { "type": "string", "description": "Qué implica elegirla" }
                                        },
                                        "required": ["label"]
                                    }
                                },
                                "multiSelect": { "type": "boolean", "description": "true si puede elegir varias" }
                            },
                            "required": ["question", "options"]
                        }
                    }
                },
                "required": ["questions"]
            }
        },
        {
            "name": "team_skill_list",
            "description": "Lista las skills (guías) de la biblioteca de lienzo: cuáles están encendidas, en qué modo y de qué categoría.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "team_skill_propose",
            "description": "Propón al usuario instalar o encender una skill que ayudaría al trabajo (p. ej. una guía de diseño para una web). Le sale en el chat una tarjeta para instalarla; tú no instalas nada. `source`: el nombre de una skill de team_skill_list, o un enlace de GitHub (repositorio o carpeta de la skill) o a un SKILL.md.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "source": { "type": "string" },
                    "reason": { "type": "string", "description": "Por qué la necesita el equipo, en una frase" }
                },
                "required": ["source", "reason"]
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
        "team_ask_user" => ask_user(client, &sid, &args),
        "team_skill_list" => client.get("/skills").map(|v| text_result(&render_skills(&v), false)),
        "team_skill_propose" => {
            let source = trunc(args["source"].as_str().unwrap_or("").trim(), 400);
            let reason = trunc(args["reason"].as_str().unwrap_or("").trim(), 400);
            if source.is_empty() {
                Err("falta `source`: el nombre de una skill o un enlace".into())
            } else {
                client
                    .post(
                        "/event",
                        &json!({ "session_id": sid, "kind": "skill", "text": reason, "files": [source], "to": "tú" }),
                    )
                    .map(|_| {
                        text_result(
                            "Propuesta enviada: al usuario le sale una tarjeta para instalarla. No esperes: sigue con lo tuyo; si la instala, aparecerá en team_skill_list.",
                            false,
                        )
                    })
            }
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
                            "tarea #{} creada: {}{}{}{}",
                            v["task"]["id"].as_u64().unwrap_or(0),
                            v["task"]["title"].as_str().unwrap_or(""),
                            assign.map(|a| format!(" → {a}")).unwrap_or_default(),
                            if blocked { " (bloqueada hasta que terminen sus padres)" } else { "" },
                            v["note"].as_str().map(|n| format!(". {n}")).unwrap_or_default()
                        ),
                        false,
                    )
                })
        }
        "team_task_brief" => {
            let id = args["id"].as_u64().unwrap_or(0);
            client
                .post(
                    "/task",
                    &json!({
                        "session_id": sid, "op": "brief", "id": id,
                        "notes": trunc(args["notes"].as_str().unwrap_or(""), 4000),
                        "level": args["level"].as_str().unwrap_or(""),
                        "assign": args["assign"].as_str().unwrap_or("")
                    }),
                )
                .map(|v| text_result(v["ok"].as_str().unwrap_or("hecho"), false))
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
        "team_schedule_create" => client
            .post(
                "/schedule",
                &json!({
                    "session_id": sid, "op": "create",
                    "title": trunc(args["title"].as_str().unwrap_or(""), 160),
                    "notes": trunc(args["notes"].as_str().unwrap_or(""), 4000),
                    "every": args["every"].as_str().unwrap_or(""),
                    "assign": args["assign"].as_str().unwrap_or(""),
                    "level": args["level"].as_str().unwrap_or(""),
                    "model": args["model"].as_str().unwrap_or(""),
                    "daily_cap": args["daily_cap"].as_u64().unwrap_or(0)
                }),
            )
            .map(|v| {
                text_result(
                    &format!(
                        "programación P{} creada y PENDIENTE: el usuario la aprueba en la sección Programadas de Prometeo. Hasta entonces no se ejecuta.",
                        v["schedule"]["id"].as_u64().unwrap_or(0)
                    ),
                    false,
                )
            }),
        "team_schedule_list" => client.post("/schedule", &json!({ "session_id": sid, "op": "list" })).map(|v| {
            let list = v["schedules"].as_array().cloned().unwrap_or_default();
            if list.is_empty() {
                return text_result("No hay tareas programadas.", false);
            }
            let lines: Vec<String> = list
                .iter()
                .map(|s| {
                    let to = s["assign"].as_str().filter(|a| !a.is_empty()).unwrap_or("quien esté libre");
                    let skip = s["skipped"].as_str().filter(|x| !x.is_empty()).map(|x| format!(" · última vez saltada: {x}")).unwrap_or_default();
                    format!(
                        "P{} [{}] «{}» · {} → {} · {} ejecuciones{}",
                        s["id"].as_u64().unwrap_or(0),
                        s["status"].as_str().unwrap_or("?"),
                        s["title"].as_str().unwrap_or(""),
                        s["every"].as_str().unwrap_or(""),
                        to,
                        s["runs_total"].as_u64().unwrap_or(0),
                        skip
                    )
                })
                .collect();
            text_result(&lines.join("\n"), false)
        }),
        "team_feed_search" => client
            .post(
                "/feed/search",
                &json!({
                    "query": trunc(args["query"].as_str().unwrap_or(""), 200),
                    "agent": args["agent"].as_str().unwrap_or(""),
                    "limit": args["limit"].as_u64().unwrap_or(20)
                }),
            )
            .map(|v| {
                if v["events"].as_array().is_none_or(|a| a.is_empty()) {
                    text_result("Nada en el historial con esas palabras.", false)
                } else {
                    text_result(&render_feed(&v), false)
                }
            }),
        "team_task_handoff" => client
            .post(
                "/task",
                &json!({
                    "session_id": sid, "op": "handoff", "id": args["id"].as_u64().unwrap_or(0),
                    "assign": args["to"].as_str().unwrap_or(""),
                    "notes": trunc(args["notes"].as_str().unwrap_or(""), 300)
                }),
            )
            .map(|v| text_result(v["ok"].as_str().unwrap_or("hecho"), false)),
        "team_plan_approve" => client
            .post("/task", &json!({ "session_id": sid, "op": "plan_approve" }))
            .map(|v| text_result(v["ok"].as_str().unwrap_or("hecho"), false)),
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
                    // Carpeta aislada: lo primero, porque cambia dónde se trabaja.
                    if let Some(ws) = v["workspace"].as_str() {
                        let root = v["project_root"].as_str().unwrap_or("");
                        msg.push_str(&format!(
                            "\n\n📁 CARPETA AISLADA: {ws}\nEs tu copia del proyecto para esta tarea. Lee, edita, compila y prueba SOLO ahí: \
                             donde el encargo diga {root}\\…, usa {ws}\\… (la misma ruta relativa). Las rutas fuera del proyecto se usan tal cual. \
                             No hace falta reservar archivos: nadie más toca tu copia. Al entregar, lienzo une tus cambios al proyecto; \
                             si chocan con algo que cambió mientras tanto, te lo dirá y lo dejará marcado en tu copia."
                        ));
                    } else if let Some(e) = v["workspace_error"].as_str() {
                        msg.push_str(&format!("\n\n(No se pudo preparar tu carpeta aislada: {e}. Trabaja en el proyecto como siempre, reservando archivos.)"));
                    }
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
                    let relative = str_array(&v["relative"]);
                    if !relative.is_empty() {
                        let ok = if granted.is_empty() {
                            String::new()
                        } else {
                            format!(" Sí reservaste: {}.", granted.join(", "))
                        };
                        text_result(
                            &format!(
                                "⚠️ Sin reservar (ruta relativa): {}. Repite con la ruta absoluta (C:\\…): cada agente trabaja en su carpeta y una ruta relativa no dice qué archivo es.{}",
                                relative.join(", "),
                                ok
                            ),
                            true,
                        )
                    } else if conflicts.is_empty() {
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
        if name != "team_inbox"
            && let Some(note) = inbox_notice(client)
                && let Some(t) = v["content"][0]["text"].as_str() {
                    v["content"][0]["text"] = json!(format!("{t}\n\n{note}"));
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
        out.push_str(&diff_block(m));
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
    if matches!(agent.as_str(), "opencode" | "codex")
        && let Some(c) = client.clone() {
            let sess = session.clone();
            let agent_name = agent.clone();
            let cwd = std::env::current_dir()
                .map(|p| p.display().to_string())
                .unwrap_or_default();
            std::thread::spawn(move || {
                let mut win_cache: Option<(String, u64)> = None;
                let mut last: Option<(u64, u64)> = None;
                let mut last_limits: Option<Vec<Value>> = None;
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
                    // Codex trae los límites de la suscripción en cada turno: al hub si cambian.
                    if !sample.limits.is_empty() && last_limits.as_ref() != Some(&sample.limits) {
                        let _ = c.post("/limits", &json!({ "agent": agent_name, "windows": sample.limits, "exact": true }));
                        last_limits = Some(sample.limits.clone());
                    }
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
            "tools/list" => Some(Ok(json!({ "tools": with_load_hints(tools_catalog()) }))),
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

/// Una ventana de límite de la «status line» de Claude Code (`rate_limits.five_hour`…):
/// porcentaje usado y cuándo se reinicia (en ms).
fn rate_window(v: &Value) -> Option<(f64, Option<u64>)> {
    let pct = v["used_percentage"].as_f64()?;
    let reset = v["resets_at"]
        .as_f64()
        .or_else(|| v["reset_at"].as_f64())
        .or_else(|| v["resets_at"].as_str().and_then(|s| s.parse().ok()))
        // Llega en segundos; si ya viene en milisegundos se deja.
        .map(|t| if t < 1e12 { (t * 1000.0) as u64 } else { t as u64 });
    Some((pct, reset))
}

/// `lienzo-mcp statusline`: Claude Code nos pasa su estado (modelo, contexto y los límites de
/// la suscripción). Mandamos los límites al hub y devolvemos la línea que pinta abajo.
fn statusline_mode() {
    let mut raw = String::new();
    let _ = std::io::stdin().read_to_string(&mut raw);
    let p: Value = serde_json::from_str(raw.trim()).unwrap_or_else(|_| json!({}));
    let rl = &p["rate_limits"];
    let five = rate_window(&rl["five_hour"]);
    let week = rate_window(&rl["seven_day"]);

    if (five.is_some() || week.is_some()) && !outside_lienzo()
        && let Some(client) = HubClient::discover() {
            let mut windows = vec![];
            if let Some((pct, reset)) = five {
                windows.push(json!({ "key": "session", "label": "Sesión (5 h)", "used_pct": pct, "resets_at": reset }));
            }
            if let Some((pct, reset)) = week {
                windows.push(json!({ "key": "week", "label": "Semana", "used_pct": pct, "resets_at": reset }));
            }
            let _ = client.post("/limits", &json!({ "agent": "claude", "windows": windows, "exact": true }));
        }

    let mut parts: Vec<String> = vec![];
    if let Some(m) = p["model"]["display_name"].as_str().filter(|s| !s.is_empty()) {
        parts.push(m.to_string());
    }
    if let Some((pct, _)) = five {
        parts.push(format!("sesión {pct:.0}%"));
    }
    if let Some((pct, _)) = week {
        parts.push(format!("semana {pct:.0}%"));
    }
    println!("{}", parts.join(" · "));
}

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
    // publican nada ni reciben el contexto del equipo. Codex es aparte: sus hooks los lanza su
    // servicio (app-server), que no hereda el entorno de la terminal, así que se mira quién abrió
    // la conversación.
    let codex = agent == "codex";
    if outside_lienzo() && !codex {
        return;
    }

    let mut raw = String::new();
    let _ = std::io::stdin().read_to_string(&mut raw);
    let payload: Value = serde_json::from_str(raw.trim()).unwrap_or_else(|_| json!({}));
    if codex && outside_lienzo() && codex_from_desktop(payload["transcript_path"].as_str().unwrap_or("")) {
        return;
    }

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
    // Al retomar, Claude Code estrena id pero no escribe su transcript hasta el primer mensaje:
    // hasta que exista, se sigue con el id anterior (si no, reabrirlo falla con «No conversation found»).
    let transcript = payload["transcript_path"].as_str().unwrap_or("");
    let written = transcript.is_empty() || std::path::Path::new(transcript).is_file();
    if !session_key.is_empty() && written {
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
                    if codex {
                        read_tail(std::path::Path::new(path), 512 * 1024).and_then(|t| codex_reply(&t))
                    } else {
                        transcript_reply(path)
                    }
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
                let _ = save_cache(p, &cache);
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
    if (event == "prompt" || event == "session")
        && let Ok(state) = client.get("/state?limit=30") {
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
                let _ = save_cache(p, &cache);
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

static CACHE_TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn save_cache(path: &std::path::Path, v: &Value) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    let seq = CACHE_TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    name.push(format!(".tmp-{}-{}-{}", std::process::id(), now_ms(), seq));
    let tmp = path.with_file_name(name);
    let written = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(v.to_string().as_bytes())?;
        f.sync_all()
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    let mut result = std::fs::rename(&tmp, path);
    for _ in 0..5 {
        if result.is_ok() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
        result = std::fs::rename(&tmp, path);
    }
    if let Err(ref e) = result {
        let _ = std::fs::remove_file(&tmp);
        eprintln!("lienzo-mcp: error al guardar caché de hooks en {}: {e}", path.display());
    }
    result
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
                            format!("{}{}", trunc(m["text"].as_str().unwrap_or(""), 1200), diff_block(m)),
                            m["to"].is_string(),
                        )
                    })
                    .collect()
            })
        })
        .unwrap_or_default()
}

/// Los cambios de una entrega que acompañan a un aviso de revisión, si los hay.
fn diff_block(m: &Value) -> String {
    match m["diff"].as_str().filter(|d| !d.trim().is_empty()) {
        Some(d) => format!("\n```diff\n{}\n```\n", d.trim_end()),
        None => String::new(),
    }
}

fn inbox_text(list: &[(u64, String, String, bool)]) -> String {
    let mut out = format!("📬 Mensajes de tus compañeros ({}):\n", list.len());
    for (seq, from, text, _) in list {
        out.push_str(&format!("- #{seq} de {from}: {text}\n"));
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
        if let Some(cur) = &id
            && *cur != msg_id {
                break;
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
    /// Ventanas de límite de la suscripción (solo Codex: `rate_limits` de su rollout).
    limits: Vec<Value>,
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
    Some(CtxSample { model, used, window, limits: vec![] })
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

/// ¿La conversación de Codex la abrió su app de escritorio? (`originator` de la primera línea del
/// rollout). Esa no es el agente del equipo aunque trabaje en la misma carpeta.
fn codex_from_desktop(rollout: &str) -> bool {
    if rollout.is_empty() {
        return false;
    }
    read_first_line(std::path::Path::new(rollout))
        .and_then(|l| serde_json::from_str::<Value>(&l).ok())
        .and_then(|m| m["payload"]["originator"].as_str().map(|o| o.to_lowercase().contains("desktop")))
        .unwrap_or(false)
}

/// La respuesta del último turno en un rollout de Codex: su último mensaje al usuario, siempre que
/// vaya después del último mensaje del usuario (si aún no está escrito, `None` y se reintenta).
fn codex_reply(tail: &str) -> Option<String> {
    for line in tail.lines().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let p = &v["payload"];
        if v["type"].as_str() != Some("response_item") || p["type"].as_str() != Some("message") {
            continue;
        }
        let text = |kind: &str| -> String {
            p["content"]
                .as_array()
                .map(|c| {
                    c.iter()
                        .filter(|x| x["type"].as_str() == Some(kind))
                        .filter_map(|x| x["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default()
        };
        match p["role"].as_str() {
            Some("assistant") => {
                let t = text("output_text");
                if !t.trim().is_empty() {
                    return Some(trunc(t.trim(), 6000));
                }
            }
            // Las instrucciones (AGENTS.md, entorno) también van como «user»: esas no cuentan.
            Some("user") => {
                let t = text("input_text");
                if !t.trim_start().starts_with('<') && !t.trim_start().starts_with("# AGENTS.md") {
                    return None;
                }
            }
            _ => {}
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
        let Some(used) = p["info"]["last_token_usage"]["total_tokens"].as_u64() else {
            continue;
        };
        if used == 0 {
            continue;
        }
        let window = p["info"]["model_context_window"]
            .as_u64()
            .filter(|w| *w > 0)
            .unwrap_or(200_000);
        let ts = v["timestamp"].as_str().and_then(iso_secs);
        let limits = codex_rate_windows(&p["rate_limits"], ts);
        return Some(CtxSample { model, used, window, limits });
    }
    None
}

/// Las ventanas de `rate_limits` de un `token_count` de Codex (`primary`: 5 h, `secondary`:
/// la semana) con la forma de `/limits`. `ts` (segundos) sirve para las versiones que mandan
/// `resets_in_seconds` en vez de `resets_at`.
fn codex_rate_windows(rl: &Value, ts: Option<u64>) -> Vec<Value> {
    ["primary", "secondary"]
        .iter()
        .filter_map(|k| {
            let w = &rl[*k];
            let pct = w["used_percent"].as_f64()?;
            let mins = w["window_minutes"].as_u64().unwrap_or(0);
            let (key, label) = match mins {
                m if m >= 7 * 24 * 60 - 60 => ("week".to_string(), "Semana".to_string()),
                m if (240..=360).contains(&m) => ("session".to_string(), "Sesión (5 h)".to_string()),
                0 => (k.to_string(), if *k == "primary" { "Sesión".to_string() } else { "Semana".to_string() }),
                m if m % 60 == 0 => (k.to_string(), format!("{} h", m / 60)),
                m => (k.to_string(), format!("{m} min")),
            };
            let reset = w["resets_at"]
                .as_u64()
                .or_else(|| Some(ts? + w["resets_in_seconds"].as_u64()?))
                .map(|s| s * 1000);
            Some(json!({ "key": key, "label": label, "used_pct": pct, "resets_at": reset }))
        })
        .collect()
}

/// `2026-10-06T21:58:42.867Z` → segundos Unix (UTC). Solo esa forma.
fn iso_secs(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[10] != b'T' {
        return None;
    }
    let n = |a: usize, z: usize| s.get(a..z)?.parse::<i64>().ok();
    let (y, mo, d) = (n(0, 4)?, n(5, 7)?, n(8, 10)?);
    let (h, mi, se) = (n(11, 13)?, n(14, 16)?, n(17, 19)?);
    // Días desde 1970 (algoritmo de Howard Hinnant).
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(days * 86_400 + h * 3600 + mi * 60 + se).ok()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_respuesta_del_turno() {
        let user = |t: &str| json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":t}]}}).to_string();
        let bot = |t: &str| json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":t}]}}).to_string();
        let ev = json!({"type":"event_msg","payload":{"type":"task_complete"}}).to_string();
        let log = [user("# AGENTS.md instructions"), user("hola"), bot("¡Hola! ¿En qué te ayudo?"), ev].join("\n");
        assert_eq!(codex_reply(&log).as_deref(), Some("¡Hola! ¿En qué te ayudo?"));
        // Turno nuevo sin respuesta escrita todavía: nada (no la del turno anterior).
        let pending = [log.clone(), user("otra cosa")].join("\n");
        assert_eq!(codex_reply(&pending), None);
        // Lo que inyecta el entorno como «user» no corta la búsqueda.
        let env = [log, user("<environment_context>…</environment_context>")].join("\n");
        assert_eq!(codex_reply(&env).as_deref(), Some("¡Hola! ¿En qué te ayudo?"));
    }

    #[test]
    fn codex_lee_sus_limites() {
        let rl = json!({
            "primary": { "used_percent": 93.0, "window_minutes": 300, "resets_at": 1791330799u64 },
            "secondary": { "used_percent": 91.5, "window_minutes": 10080, "resets_in_seconds": 60 },
        });
        let ts = iso_secs("2026-10-06T21:58:42.867Z");
        assert_eq!(ts, Some(1791323922));
        let w = codex_rate_windows(&rl, ts);
        assert_eq!(w.len(), 2);
        assert_eq!(w[0]["key"], "session");
        assert_eq!(w[0]["used_pct"], 93.0);
        assert_eq!(w[0]["resets_at"], 1791330799000u64);
        assert_eq!(w[1]["label"], "Semana");
        assert_eq!(w[1]["resets_at"], (1791323922u64 + 60) * 1000);
        assert!(codex_rate_windows(&Value::Null, ts).is_empty(), "con clave de API no hay límites");
    }

    /// Herramientas que atiende `call_tool`: los nombres de sus ramas (`"team_x" =>`, `"a" | "b" =>`).
    fn handled_tools() -> std::collections::BTreeSet<String> {
        let src = include_str!("lienzo-mcp.rs");
        let start = src.find("fn call_tool(").expect("call_tool");
        let end = start + src[start..].find("herramienta desconocida").expect("rama por defecto");
        let mut out = std::collections::BTreeSet::new();
        for line in src[start..end].lines() {
            let arm = line.trim_start();
            // Solo las ramas del match de primer nivel: empiezan por el nombre entre comillas y acaban en «=>».
            if !arm.starts_with("\"team_") || !arm.contains("=>") {
                continue;
            }
            for name in arm.split("=>").next().unwrap_or("").split('|') {
                let name = name.trim().trim_matches('"');
                if name.starts_with("team_") {
                    out.insert(name.to_string());
                }
            }
        }
        out
    }

    #[test]
    fn every_announced_tool_is_handled_and_viceversa() {
        let announced: std::collections::BTreeSet<String> = tools_catalog()
            .as_array()
            .expect("lista de herramientas")
            .iter()
            .filter_map(|t| t["name"].as_str().map(String::from))
            .collect();
        let handled = handled_tools();
        let missing: Vec<_> = announced.difference(&handled).collect();
        let hidden: Vec<_> = handled.difference(&announced).collect();
        assert!(missing.is_empty(), "anunciadas sin atender: {missing:?}");
        assert!(hidden.is_empty(), "atendidas pero sin anunciar: {hidden:?}");
        assert!(announced.len() >= 20, "se leyó mal la lista: {}", announced.len());
    }

    #[test]
    fn every_tool_has_description_and_valid_schema() {
        for t in tools_catalog().as_array().expect("lista") {
            let name = t["name"].as_str().unwrap_or("?");
            let desc = t["description"].as_str().unwrap_or("");
            assert!(desc.len() >= 20, "{name}: falta la descripción");
            assert_eq!(t["inputSchema"]["type"], "object", "{name}: el esquema debe ser un objeto");
            let props = t["inputSchema"]["properties"].as_object().cloned().unwrap_or_default();
            for req in t["inputSchema"]["required"].as_array().cloned().unwrap_or_default() {
                let r = req.as_str().unwrap_or("");
                assert!(props.contains_key(r), "{name}: «{r}» es obligatorio pero no está en properties");
            }
        }
    }

    #[test]
    fn only_rare_tools_stay_behind_tool_search() {
        let tools = with_load_hints(tools_catalog());
        let list = tools.as_array().expect("lista");
        for name in RARE_TOOLS {
            assert!(list.iter().any(|t| t["name"] == *name), "{name} no existe en el catálogo");
        }
        for t in list {
            let rare = RARE_TOOLS.contains(&t["name"].as_str().unwrap_or(""));
            assert_eq!(t["_meta"]["anthropic/alwaysLoad"] == json!(false), rare, "{}", t["name"]);
        }
        // Lo que más usan el líder y los trabajadores va siempre cargado.
        for core in ["team_task_review", "team_task_create", "team_task_claim", "team_task_done", "team_message"] {
            assert!(list.iter().any(|t| t["name"] == core && t.get("_meta").is_none()));
        }
    }

    #[test]
    fn lista_del_equipo_con_uso_y_fortalezas() {
        let now = 1_800_000_000_000u64;
        let state = json!({
            "agents": [
                { "name": "claude", "online": true, "model": "Sonnet 5" },
                { "name": "opencode", "online": true },
                { "name": "opencode", "online": true },
                { "name": "antigravity", "online": true },
                { "name": "codex", "online": false }
            ],
            "strengths": { "antigravity": "investigar en la web" },
            "limits": {
                "claude": { "windows": [
                    { "label": "Sesión (5 h)", "used_pct": 11.0, "resets_at": null },
                    { "label": "Semana", "used_pct": 92.0, "resets_at": now + 3 * 86_400_000 }
                ] },
                "antigravity": { "windows": [ { "label": "Gemini · semana", "used_pct": 14.0, "resets_at": null } ] }
            }
        });
        let r = team_roster(&state, now);
        assert!(r.contains("- claude · Sonnet 5 · uso: ⛔ Semana casi agotado, se reinicia en 3 días: no le des trabajo pesado · ritmo: sin margen"), "{r}");
        assert!(r.contains("se le da bien: diseño, arquitectura y lo difícil"), "{r}");
        assert!(r.contains("- opencode · uso: sin límite (modelos gratis)"), "{r}");
        assert_eq!(r.matches("- opencode").count(), 1, "sin repetidos: {r}");
        assert!(r.contains("- antigravity · uso: Gemini · semana holgado · se le da bien: investigar en la web"), "{r}");
        assert!(!r.contains("codex"), "solo los que están en línea: {r}");
        assert_eq!(team_roster(&json!({ "agents": [] }), now), "No hay otros agentes en línea ahora mismo.\n");
    }

    #[test]
    fn cache_hooks_escritura_atomica() {
        let dir = std::env::temp_dir().join(format!("test-hooks-{}", now_ms()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("cache.json");
        let initial = json!({ "key": "valor_inicial" });
        save_cache(&path, &initial).expect("guardar inicial");
        assert_eq!(load_cache(&path), initial);

        let updated = json!({ "key": "valor_actualizado" });
        save_cache(&path, &updated).expect("guardar actualizado");
        assert_eq!(load_cache(&path), updated);

        let entries: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).collect();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].file_name(), "cache.json");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
