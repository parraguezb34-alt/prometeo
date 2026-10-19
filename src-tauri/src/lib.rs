pub mod hub;
mod project;
mod pty;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(pty::PtyManager::default())
        .setup(|app| {
            if let Err(e) = hub::init(app.handle().clone()) {
                eprintln!("[hub] no se pudo iniciar el hub de equipo: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::term_spawn,
            pty::term_write,
            pty::term_resize,
            pty::term_kill,
            pty::term_list,
            pty::term_scrollback,
            hub::team_state,
            hub::team_details,
            hub::team_project_set,
            hub::team_add_task,
            hub::team_task_op,
            hub::team_task_comment,
            hub::team_memory_add,
            hub::team_memory_resolve,
            hub::team_memory_forget,
            hub::team_dm,
            hub::team_leader,
            hub::team_usage_reset,
            hub::team_broadcast,
            hub::team_broadcast_ack,
            hub::team_charter,
            hub::connectors::team_detect,
            hub::connectors::team_connect,
            hub::connectors::team_open,
            hub::connectors::team_models,
            hub::connectors::opencode_compact,
            hub::connectors::team_agent_session,
            project::project_info,
            project::project_status,
            project::project_list,
            project::project_read,
            project::project_recent,
            project::project_diff_paths,
            project::project_commit_paths,
            project::project_revert_paths,
            project::image_data,
            project::project_save_image,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
