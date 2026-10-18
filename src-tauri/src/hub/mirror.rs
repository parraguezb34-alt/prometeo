//! Espejo de lo que hacen los CLIs que no tienen hooks (OpenCode, Antigravity).
//!
//! Claude Code y Codex avisan al hub de cada herramienta con sus hooks; OpenCode y
//! Antigravity no. Pero los dos guardan su conversación en disco: OpenCode en su
//! SQLite (`~/.local/share/opencode/opencode.db`) y Antigravity en un SQLite por
//! conversación (`~/.gemini/antigravity-cli/conversations/<id>.db`, pasos en
//! protobuf). Cada pocos segundos se lee lo nuevo de la conversación de la carpeta
//! del proyecto y se publica en el feed como si fueran hooks: herramientas
//! (`tool`), la respuesta final (`reply`) y las preguntas que esperan al usuario
//! (`waiting`). Solo lectura: nunca se escribe en sus bases.

use crate::hub;
use serde_json::Value;
use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Duration;
use tauri::AppHandle;

const TICK: Duration = Duration::from_secs(3);
const REPLY_CAP: usize = 6000;

struct Ev {
    agent: &'static str,
    kind: &'static str,
    text: String,
    files: Vec<String>,
}

/// Hasta dónde se leyó cada conversación. `None` = aún no se vio ninguna: la primera
/// vez se salta lo que ya había (no se repite el historial al abrir lienzo).
#[derive(Default)]
struct Cursor {
    conv: Option<String>,
    last: i64,
}

#[derive(Default)]
struct State {
    oc: Cursor,
    agy: Cursor,
    /// Preguntas de OpenCode ya avisadas (id de la llamada).
    asked: HashSet<String>,
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut st = State::default();
        loop {
            std::thread::sleep(TICK);
            let Some(project) = hub::with_inner(&app, |i| i.project.clone()).flatten() else {
                continue;
            };
            if project.trim().is_empty() {
                continue;
            }
            let mut evs = opencode(&project, &mut st);
            evs.extend(antigravity(&project, &mut st.agy));
            if evs.is_empty() {
                continue;
            }
            hub::with_inner(&app, |inner| {
                for e in evs {
                    let sid = session_of(inner, e.agent);
                    hub::push_event(inner, e.agent, &sid, e.kind, &e.text, e.files, None);
                }
                hub::persist(inner);
            });
            hub::notify_ui();
        }
    });
}

/// Sesión del hub del agente (para que el evento cuente como suyo), o una genérica.
fn session_of(inner: &hub::HubInner, agent: &str) -> String {
    inner
        .agents
        .values()
        .filter(|a| a.name == agent)
        .max_by_key(|a| a.last_seen_ms)
        .map(|a| a.session_id.clone())
        .unwrap_or_else(|| "mirror".to_string())
}

fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn norm(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

fn trunc(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max).collect::<String>())
    }
}

fn is_image(p: &str) -> bool {
    let l = p.to_lowercase();
    [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].iter().any(|e| l.ends_with(e))
}

fn open_ro(path: &PathBuf) -> Option<rusqlite::Connection> {
    rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()
}

/// Un paso de herramienta como el texto que mandan los hooks («Bash …», «Edit ruta»),
/// para que el chat lo pinte igual venga de quien venga. None = no merece salir.
fn tool_event(agent: &'static str, tool: &str, args: &Value) -> Option<Ev> {
    let s = |k: &str| args[k].as_str().unwrap_or("").to_string();
    let path = ["path", "filePath", "AbsolutePath", "TargetFile", "file_path"]
        .iter()
        .map(|k| s(k))
        .find(|p| !p.is_empty())
        .unwrap_or_default();
    let (text, files) = match tool {
        "shell" | "bash" | "run_command" => {
            let cmd = [s("command"), s("CommandLine")].into_iter().find(|c| !c.is_empty())?;
            (format!("Bash {}", trunc(&cmd, 160)), vec![])
        }
        "write" | "write_to_file" => (format!("Write {}", short(&path)), vec![path]),
        "edit" | "multiedit" | "patch" | "replace_file_content" | "multi_replace_file_content" => {
            (format!("Edit {}", short(&path)), vec![path])
        }
        // Leer solo cuenta si es una imagen (una captura): leer código es ruido.
        "read" | "view_file" if is_image(&path) => (format!("Read {}", short(&path)), vec![path]),
        "glob" | "grep" | "grep_search" | "find_by_name" | "list_dir" => {
            let q = [s("pattern"), s("Query"), s("Pattern"), s("SearchPath"), s("DirectoryPath")]
                .into_iter()
                .find(|q| !q.is_empty())
                .unwrap_or_default();
            (format!("Search {}", trunc(&q, 120)), vec![])
        }
        "webfetch" | "read_url_content" => (format!("Web {}", trunc(&[s("url"), s("Url")].concat(), 140)), vec![]),
        "websearch" | "search_web" => (format!("Web {}", trunc(&[s("query"), s("query_text")].concat(), 140)), vec![]),
        _ => return None,
    };
    Some(Ev { agent, kind: "tool", text, files })
}

fn short(p: &str) -> String {
    let parts: Vec<&str> = p.split(['/', '\\']).filter(|x| !x.is_empty()).collect();
    if parts.len() >= 2 {
        format!("{}/{}", parts[parts.len() - 2], parts[parts.len() - 1])
    } else {
        p.to_string()
    }
}

// ---- OpenCode ----------------------------------------------------------------------------

fn opencode(project: &str, st: &mut State) -> Vec<Ev> {
    let mut out = Vec::new();
    let Some(db) = home().map(|h| h.join(".local/share/opencode/opencode.db")) else {
        return out;
    };
    if !db.is_file() {
        return out;
    }
    let Some(con) = open_ro(&db) else { return out };
    let Ok(session) = con.query_row(
        "select id from session_v2 where lower(replace(directory, '\\', '/')) = ?1 \
         order by time_updated desc limit 1",
        [norm(project)],
        |r| r.get::<_, String>(0),
    ) else {
        return out;
    };
    let fresh = st.oc.conv.is_none();
    if st.oc.conv.as_deref() != Some(session.as_str()) {
        // Primera vez: se empieza desde lo último. Conversación nueva: desde el principio.
        st.oc.last = if fresh {
            con.query_row(
                "select coalesce(max(seq), -1) from session_message where session_id = ?1",
                [&session],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(-1)
        } else {
            -1
        };
        st.oc.conv = Some(session.clone());
    }
    let Ok(mut stmt) = con.prepare(
        "select seq, data from session_message where session_id = ?1 and type = 'assistant' \
         and seq > ?2 order by seq",
    ) else {
        return out;
    };
    let Ok(rows) = stmt.query_map(rusqlite::params![session, st.oc.last], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
    }) else {
        return out;
    };
    for (seq, data) in rows.flatten() {
        let Ok(v) = serde_json::from_str::<Value>(&data) else { continue };
        let parts = v["content"].as_array().cloned().unwrap_or_default();
        // Una pregunta al usuario sale en cuanto aparece, aunque el mensaje siga abierto.
        for p in &parts {
            if p["type"] == "tool" && p["name"] == "question" && p["state"]["status"] != "completed" {
                let id = p["id"].as_str().unwrap_or("").to_string();
                if !id.is_empty() && st.asked.insert(id) {
                    let q = &p["state"]["input"]["questions"][0];
                    let text = [q["question"].as_str(), q["header"].as_str()]
                        .into_iter()
                        .flatten()
                        .next()
                        .unwrap_or("te hace una pregunta");
                    out.push(Ev { agent: "opencode", kind: "waiting", text: trunc(text, 240), files: vec![] });
                }
            }
        }
        // El resto, cuando el mensaje termina (no se avanza el cursor hasta entonces).
        if v["time"]["completed"].is_null() {
            break;
        }
        st.oc.last = seq;
        let mut has_tools = false;
        for p in &parts {
            if p["type"] != "tool" {
                continue;
            }
            has_tools = true;
            let name = p["name"].as_str().unwrap_or("");
            if name == "execute" && p["state"]["input"]["code"].as_str().unwrap_or("").contains("lienzo-team") {
                continue; // herramientas del equipo: ya salen en el feed por su cuenta
            }
            if p["state"]["status"] != "completed" {
                continue;
            }
            if let Some(ev) = tool_event("opencode", name, &p["state"]["input"]) {
                out.push(ev);
            }
        }
        // Respuesta final: un mensaje que acaba el turno con texto y sin herramientas.
        if !has_tools && v["finish"].as_str() == Some("stop") {
            let text: Vec<String> = parts
                .iter()
                .filter(|p| p["type"] == "text")
                .filter_map(|p| p["text"].as_str())
                .map(|t| t.rsplit("</think>").next().unwrap_or(t).trim().to_string())
                .filter(|t| !t.is_empty())
                .collect();
            if !text.is_empty() {
                out.push(Ev { agent: "opencode", kind: "reply", text: trunc(&text.join("\n\n"), REPLY_CAP), files: vec![] });
            }
        }
    }
    out
}

// ---- Antigravity ---------------------------------------------------------------------------

/// Conversación de Antigravity de esta carpeta: la del último mensaje en su historial.
fn agy_conversation(project: &str) -> Option<String> {
    let path = home()?.join(".gemini/antigravity-cli/history.jsonl");
    let text = std::fs::read_to_string(&path).ok()?;
    let want = norm(project);
    text.lines().rev().find_map(|line| {
        let v: Value = serde_json::from_str(line).ok()?;
        if norm(v["workspace"].as_str()?) != want {
            return None;
        }
        v["conversationId"].as_str().map(|s| s.to_string())
    })
}

fn antigravity(project: &str, cur: &mut Cursor) -> Vec<Ev> {
    let mut out = Vec::new();
    let Some(conv) = agy_conversation(project) else { return out };
    let Some(db) = home().map(|h| h.join(format!(".gemini/antigravity-cli/conversations/{conv}.db"))) else {
        return out;
    };
    if !db.is_file() {
        return out;
    }
    let Some(con) = open_ro(&db) else { return out };
    let fresh = cur.conv.is_none();
    if cur.conv.as_deref() != Some(conv.as_str()) {
        cur.last = if fresh {
            con.query_row("select coalesce(max(idx), -1) from steps", [], |r| r.get::<_, i64>(0))
                .unwrap_or(-1)
        } else {
            -1
        };
        cur.conv = Some(conv.clone());
    }
    let Ok(mut stmt) = con.prepare(
        "select idx, step_type, status, step_payload from steps where idx > ?1 order by idx",
    ) else {
        return out;
    };
    let Ok(rows) = stmt.query_map([cur.last], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, Option<Vec<u8>>>(3)?,
        ))
    }) else {
        return out;
    };
    for (idx, kind, status, payload) in rows.flatten() {
        // 3 = terminado. Un paso a medias se vuelve a mirar en la próxima vuelta.
        if status != 3 {
            break;
        }
        cur.last = idx;
        let Some(buf) = payload else { continue };
        match kind {
            // Herramienta ejecutada: campo 5 → 4 → {2: nombre, 3: argumentos JSON}.
            132 => {
                let Some(call) = pb_get(&buf, &[5, 4]) else { continue };
                let name = pb_str(call, 2).unwrap_or_default();
                let args: Value = pb_str(call, 3)
                    .and_then(|j| serde_json::from_str(&j).ok())
                    .unwrap_or(Value::Null);
                if name == "call_mcp_tool" {
                    continue; // herramientas del equipo: ya salen en el feed
                }
                if let Some(ev) = tool_event("antigravity", &name, &args) {
                    out.push(ev);
                }
            }
            // Turno del modelo: campo 20 → {1: respuesta, 3: razonamiento, 7: llamada}.
            15 => {
                let Some(turn) = pb_get(&buf, &[20]) else { continue };
                if pb_get(turn, &[7]).is_some() {
                    continue; // texto de paso antes de usar una herramienta
                }
                if let Some(text) = pb_str(turn, 1).filter(|t| !t.trim().is_empty()) {
                    out.push(Ev { agent: "antigravity", kind: "reply", text: trunc(text.trim(), REPLY_CAP), files: vec![] });
                }
            }
            _ => {}
        }
    }
    out
}

// ---- protobuf mínimo (sin esquema) ----------------------------------------------------------

fn varint(b: &[u8], i: &mut usize) -> Option<u64> {
    let mut x = 0u64;
    let mut shift = 0;
    loop {
        let c = *b.get(*i)?;
        *i += 1;
        x |= u64::from(c & 0x7f) << shift;
        if c & 0x80 == 0 {
            return Some(x);
        }
        shift += 7;
        if shift > 63 {
            return None;
        }
    }
}

/// Primer campo `field` de tipo «longitud» de un mensaje.
fn pb_field(b: &[u8], field: u64) -> Option<&[u8]> {
    let mut i = 0;
    while i < b.len() {
        let key = varint(b, &mut i)?;
        let (f, wt) = (key >> 3, key & 7);
        match wt {
            0 => {
                varint(b, &mut i)?;
            }
            1 => i += 8,
            5 => i += 4,
            2 => {
                let len = varint(b, &mut i)? as usize;
                let end = i.checked_add(len).filter(|e| *e <= b.len())?;
                if f == field {
                    return Some(&b[i..end]);
                }
                i = end;
            }
            _ => return None,
        }
    }
    None
}

fn pb_get<'a>(b: &'a [u8], path: &[u64]) -> Option<&'a [u8]> {
    let mut cur = b;
    for f in path {
        cur = pb_field(cur, *f)?;
    }
    Some(cur)
}

fn pb_str(b: &[u8], field: u64) -> Option<String> {
    pb_field(b, field).and_then(|s| String::from_utf8(s.to_vec()).ok())
}

/// Diagnóstico (`lienzo-mcp mirror-dump <carpeta>`): lo que el espejo publicaría con los
/// últimos pasos ya guardados de cada agente, sin tocar el hub.
pub fn replay(project: &str, back_oc: i64, back_agy: i64) -> Vec<String> {
    let mut st = State::default();
    let _ = opencode(project, &mut st);
    let _ = antigravity(project, &mut st.agy);
    st.oc.last -= back_oc;
    st.agy.last -= back_agy;
    let mut evs = opencode(project, &mut st);
    evs.extend(antigravity(project, &mut st.agy));
    evs.iter()
        .map(|e| format!("{:<11} {:<7} {} {:?}", e.agent, e.kind, trunc(&e.text.replace('\n', " ⏎ "), 150), e.files))
        .collect()
}
