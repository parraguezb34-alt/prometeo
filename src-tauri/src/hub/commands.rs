//! Comandos de Tauri del lado de la interfaz.

#![allow(unused_imports)]
use super::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

#[tauri::command]
pub fn team_state(hub: tauri::State<'_, Hub>) -> Result<serde_json::Value, String> {
    let inner = hub.0.lock().map_err(|e| e.to_string())?;
    Ok(snapshot(&inner, 200))
}

#[tauri::command]
pub fn team_details(hub: tauri::State<'_, Hub>) -> Result<serde_json::Value, String> {
    let inner = hub.0.lock().map_err(|e| e.to_string())?;
    let exe = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("lienzo-mcp.exe")))
        .map(|p| p.display().to_string());
    Ok(serde_json::json!({
        "url": format!("http://127.0.0.1:{}", inner.port),
        "token": inner.token,
        "mcp_exe": exe,
        "state_file": state_file().display().to_string(),
    }))
}

#[tauri::command]
pub fn team_project_set(hub: tauri::State<'_, Hub>, path: Option<String>) -> Result<(), String> {
    let path = validate_project_path(path)?;
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    // Historial desde el estado de ahora, antes de que nadie toque nada (si aún no lo había).
    if let Some(p) = path.clone().filter(|p| !p.trim().is_empty()) {
        std::thread::spawn(move || {
            if let Err(e) = crate::history::ensure(&p) {
                crate::errlog::log("historial", "No se pudo preparar el historial del proyecto", &e);
            }
        });
    }
    switch_project(&mut inner, path);
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(())
}

fn validate_project_path(path: Option<String>) -> Result<Option<String>, String> {
    if let Some(folder) = path.as_deref().map(str::trim).filter(|folder| !folder.is_empty())
        && !std::path::Path::new(folder).is_dir() {
            return Err(format!("La carpeta del proyecto ya no existe: {folder}"));
    }
    Ok(path)
}

#[cfg(test)]
mod project_set_tests {
    use super::validate_project_path;

    #[test]
    fn no_acepta_un_proyecto_borrado_antes_de_cambiar_el_hub() {
        let folder = std::env::temp_dir().join(format!("lienzo-project-set-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        assert!(validate_project_path(Some(folder.display().to_string())).is_err());
        std::fs::create_dir_all(&folder).unwrap();
        assert!(validate_project_path(Some(folder.display().to_string())).is_ok());
        assert!(validate_project_path(None).is_ok());
        let _ = std::fs::remove_dir_all(&folder);
    }
}

/// Send a prompt to the whole team: feed event + pending deliveries for hooks.
#[tauri::command]
pub fn team_broadcast(hub: tauri::State<'_, Hub>, text: String) -> Result<u64, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("el mensaje está vacío".into());
    }
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    let seq = broadcast(&mut inner, &text).seq;
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(seq)
}

/// Mark broadcasts as already delivered to whole agents (typed into lienzo terminals).
#[tauri::command]
pub fn team_broadcast_ack(hub: tauri::State<'_, Hub>, agents: Vec<String>) -> Result<(), String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    let seq = last_broadcast_seq(&inner);
    for agent in agents {
        let name = agent.trim();
        if name.is_empty() {
            continue;
        }
        ack_broadcast(&mut inner, &format!("agent:{}", name), seq);
    }
    Ok(())
}

/// Set the shared team rules and/or the current leader.
#[tauri::command]
pub fn team_charter(
    hub: tauri::State<'_, Hub>,
    charter: Option<String>,
    leader: Option<String>,
) -> Result<(), String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    inner.charter = charter.and_then(|c| {
        let t = c.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    inner.leader = leader.and_then(|l| {
        let t = l.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(())
}

#[tauri::command]
pub fn team_add_task(
    hub: tauri::State<'_, Hub>,
    title: String,
    parents: Option<Vec<u64>>,
) -> Result<(), String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    let parents = check_parents(&inner.tasks, &parents.unwrap_or_default())?;
    inner.task_seq += 1;
    let id = inner.task_seq;
    let mut task = Task::new(id, title.trim().to_string(), String::new(), parents);
    // En modo director, lo que creas a mano espera a que el líder escriba el encargo.
    let leader = inner.leader.clone().filter(|_| inner.director);
    if leader.is_some() {
        task.status = "draft".into();
    }
    inner.tasks.push(task);
    push_event(
        &mut inner,
        "tú",
        "ui",
        "task",
        &format!("#{} creada: {}", id, title.trim()),
        vec![],
        None,
    );
    if let Some(leader) = leader {
        let text = format!(
            "📝 Nueva tarea #{id} «{}» del usuario: escribe su encargo con team_task_brief (notes con la plantilla, level y, si hace falta, assign). Hasta entonces no se reparte.",
            clean_text(&title, 120)
        );
        push_event_full(&mut inner, "lienzo", "hub", "message", &text, vec![], Some(leader), Some(id));
    }
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(())
}

#[tauri::command]
pub fn team_task_comment(hub: tauri::State<'_, Hub>, id: u64, text: String) -> Result<(), String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    add_task_comment(&mut inner, id, "tú", "ui", &text)?;
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(())
}

#[tauri::command]
pub fn team_memory_add(hub: tauri::State<'_, Hub>, text: String, kind: Option<String>) -> Result<(), String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    memory_add(&mut inner, "tú", &text, kind.as_deref().unwrap_or("hecho"), true)?;
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(())
}

#[tauri::command]
pub fn team_memory_resolve(
    hub: tauri::State<'_, Hub>,
    id: u64,
    accept: bool,
    text: Option<String>,
) -> Result<(), String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    memory_resolve(&mut inner, id, accept, text.as_deref(), "tú")?;
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(())
}

#[tauri::command]
pub fn team_memory_forget(hub: tauri::State<'_, Hub>, id: u64) -> Result<(), String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    memory_forget(&mut inner, id, "tú")?;
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(())
}

#[tauri::command]
pub fn team_task_op(hub: tauri::State<'_, Hub>, id: u64, op: String) -> Result<(), String> {
    // Aprobar o dar por hecha una tarea con carpeta aislada: antes, lo suyo se une al proyecto
    // (fuera del cerrojo: git puede tardar). Si choca, no se cierra.
    let isolated = {
        let inner = hub.0.lock().map_err(|e| e.to_string())?;
        let t = inner.tasks.iter().find(|t| t.id == id);
        match (t, inner.project.clone()) {
            (Some(t), Some(p)) if !t.workspace.is_empty() && (op == "approve" || op == "done") => {
                Some((p, t.workspace.clone(), t.title.clone(), if t.owner.is_empty() { "tú".to_string() } else { t.owner.clone() }))
            }
            _ => None,
        }
    };
    let merged = match &isolated {
        Some((project, ws, _, _)) => Some(merge_workspace(project, id, ws)?),
        None => None,
    };
    if let (Some((project, _, title, by)), Some(files)) = (isolated, merged) {
        after_merge(project, id, title, by, files);
        let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
        if let Some(t) = inner.tasks.iter_mut().find(|t| t.id == id) {
            t.workspace = String::new();
        }
        drop(inner);
    }
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    // Liberar la tarea que tiene otro agente: además se le avisa de que la deje.
    let others = inner.tasks.iter().any(|t| t.id == id && t.status == "claimed" && !t.owner.is_empty() && t.owner != "tú");
    if op == "delete" || op == "approve" || (op == "reopen" && others) {
        if op == "delete" {
            delete_task(&mut inner, id)?;
        } else if op == "reopen" {
            handoff_task(&mut inner, id, "tú", "ui", "", "")?;
        } else {
            review_task(&mut inner, id, "tú", "ui", "ok", "")?;
        }
        persist(&inner);
        drop(inner);
        notify_ui();
        return Ok(());
    }
    {
        let task = inner
            .tasks
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| "tarea no encontrada".to_string())?;
        match op.as_str() {
            "done" => {
                task.status = "done".into();
                if task.owner.is_empty() {
                    task.owner = "tú".into();
                }
            }
            "claim" => {
                task.status = "claimed".into();
                task.owner = "tú".into();
            }
            "reopen" => {
                task.status = "open".into();
                task.owner = String::new();
                task.result = None; // la entrega anterior ya no vale
                task.fix_rounds = 0;
            }
            _ => return Err("operación desconocida".into()),
        }
    }
    push_event(
        &mut inner,
        "tú",
        "ui",
        "task",
        &format!("tarea #{} -> {}", id, op),
        vec![],
        None,
    );
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(())
}

/// Change who coordinates the team, without touching the charter.
#[tauri::command]
pub fn team_leader(hub: tauri::State<'_, Hub>, leader: Option<String>) -> Result<(), String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    inner.leader = leader.and_then(|l| {
        let t = l.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(())
}

/// Modo director: el líder reparte y revisa; `fix_limit` = rondas de corrección antes de asumirla.
#[tauri::command]
pub fn team_director(hub: tauri::State<'_, Hub>, enabled: bool, fix_limit: Option<u32>) -> Result<(), String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    inner.director = enabled;
    if let Some(n) = fix_limit {
        inner.fix_limit = n.clamp(1, 5);
    }
    let text = if enabled {
        format!(
            "modo director activado: {} reparte y revisa las entregas (máx. {} rondas de corrección)",
            inner.leader.clone().unwrap_or_else(|| "el líder".into()),
            self::fix_limit(&inner)
        )
    } else {
        "modo director desactivado: las tareas se cierran sin revisión".to_string()
    };
    push_event(&mut inner, "tú", "ui", "update", &text, vec![], None);
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(())
}

/// Tareas programadas desde el tablero: approve · pause · resume · delete.
#[tauri::command]
pub fn team_schedule_op(hub: tauri::State<'_, Hub>, id: u64, op: String) -> Result<(), String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    schedule::op(&mut inner, id, &op)?;
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(())
}

/// La creas tú desde la sección Programadas (ya activa) o la editas (`id`).
#[tauri::command]
pub fn team_schedule_save(hub: tauri::State<'_, Hub>, id: Option<u64>, draft: schedule::Draft) -> Result<schedule::Schedule, String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    let s = match id {
        Some(id) => schedule::update(&mut inner, id, &draft)?,
        None => schedule::create_by_user(&mut inner, &draft)?,
    };
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(s)
}

/// Liga una programación a un chat (la interfaz sabe en qué chat se pidió).
#[tauri::command]
pub fn team_schedule_link(hub: tauri::State<'_, Hub>, id: u64, chat: String, title: String) -> Result<(), String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    schedule::link(&mut inner, id, &chat, &title)?;
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(())
}

/// Le toca a una programación (lo decide el reloj de la interfaz, que sabe la hora local): crea su
/// tarea o se la salta (`skip` con el motivo). Devuelve la tarea creada, si hubo.
#[tauri::command]
pub fn team_schedule_fire(
    hub: tauri::State<'_, Hub>,
    id: u64,
    day: String,
    skip: Option<String>,
    manual: Option<bool>,
) -> Result<Option<u64>, String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    let out = schedule::fire(&mut inner, id, &day, skip.as_deref(), manual.unwrap_or(false))?;
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(out)
}

/// Carpetas aisladas: cada tarea tomada trabaja en su copia del proyecto (ver `workspace.rs`).
#[tauri::command]
pub fn team_isolate(hub: tauri::State<'_, Hub>, enabled: bool) -> Result<(), String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    inner.isolate = enabled;
    let text = if enabled {
        "carpetas aisladas activadas: cada tarea que se tome trabaja en su copia del proyecto y se une al entregar"
    } else {
        "carpetas aisladas desactivadas: las tareas nuevas trabajan en el proyecto (las que ya tienen copia la terminan allí)"
    };
    push_event(&mut inner, "tú", "ui", "update", text, vec![], None);
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(())
}

/// Tras unir una carpeta aislada: lo unido queda en el historial como entrega y la copia se borra.
pub fn after_merge(project: String, id: u64, title: String, by: String, files: Vec<String>) {
    std::thread::spawn(move || {
        if !files.is_empty()
            && let Err(e) = crate::history::record(&project, id, &title, &by, &files) {
                crate::errlog::log("historial", &format!("No se guardó la entrega de #{id} en el historial"), &e);
            }
        if let Err(e) = crate::workspace::discard(&project, id) {
            crate::errlog::log("carpetas", &format!("No se pudo borrar la carpeta aislada de #{id}"), &e);
        }
    });
}

/// Une al proyecto lo hecho en la carpeta aislada de una tarea (si tiene). Devuelve las rutas que
/// cambiaron, o un error que explica el choque (queda marcado en la copia para resolverlo allí).
pub fn merge_workspace(project: &str, id: u64, workspace: &str) -> Result<Vec<String>, String> {
    match crate::workspace::deliver(project, id)? {
        crate::workspace::Delivery::Merged(files) => Ok(files),
        crate::workspace::Delivery::Conflict(files) => Err(format!(
            "la entrega de #{id} choca con cambios que hubo en el proyecto mientras tanto ({}). \
             Los dejé marcados con <<<<<<< en la carpeta aislada {workspace}: resuélvelos allí (deja \
             la versión buena, sin marcas) y vuelve a entregar con team_task_done.",
            files.join(", ")
        )),
    }
}

/// Modo plan: `hold` (pediste un plan: lo que se cree espera tu OK), `free`, `approve` o `discard`.
/// Devuelve las tareas afectadas.
#[tauri::command]
pub fn team_plan(hub: tauri::State<'_, Hub>, op: String) -> Result<Vec<u64>, String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    let ids = match op.as_str() {
        "hold" => {
            inner.plan_hold = true;
            Vec::new()
        }
        // Escribes fuera del modo plan: lo nuevo ya no espera (lo del plan sigue esperando tu OK).
        "free" => {
            inner.plan_hold = false;
            Vec::new()
        }
        "approve" => approve_plan(&mut inner, "tú", "ui"),
        "discard" => discard_plan(&mut inner, "tú", "ui"),
        _ => return Err(format!("operación de plan desconocida: {op}")),
    };
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(ids)
}

/// Log a direct user message to one agent in the feed (the text itself is typed
/// into its terminal by the UI, so the agent receives it as a prompt).
#[tauri::command]
pub fn team_dm(hub: tauri::State<'_, Hub>, agent: String, text: String) -> Result<(), String> {
    let agent = agent.trim().to_string();
    let text = text.trim().to_string();
    if agent.is_empty() || text.is_empty() {
        return Err("el mensaje está vacío".into());
    }
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    push_event(&mut inner, "tú", "ui", "message", &text, vec![], Some(agent));
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(())
}

/// Contestas la pregunta de un agente (`answers` vacío = la descartas). Devuelve a quién y, si
/// su herramienta ya no esperaba, el texto que la app le escribe en la terminal.
#[tauri::command]
pub fn team_answer(hub: tauri::State<'_, Hub>, id: u64, answers: Option<Vec<QAnswer>>) -> Result<serde_json::Value, String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    let (agent, late) = answer_question(&mut inner, id, answers)?;
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(serde_json::json!({ "agent": agent, "late": late }))
}

/// Empieza a contar el consumo de tokens desde cero.
#[tauri::command]
pub fn team_usage_reset(hub: tauri::State<'_, Hub>) -> Result<(), String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    inner.usage.clear();
    inner.usage_since = now_ms();
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(())
}

/// Qué se le da bien a un agente (vacío = olvidarlo). El líder lo ve al repartir.
#[tauri::command]
pub fn team_strengths(hub: tauri::State<'_, Hub>, agent: String, text: String) -> Result<(), String> {
    let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
    let text = clean_text(&text, 200);
    if text.is_empty() {
        inner.strengths.remove(&agent);
    } else {
        inner.strengths.insert(agent, text);
    }
    persist(&inner);
    drop(inner);
    notify_ui();
    Ok(())
}
