pub mod hub;
mod pty;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
            hub::connectors::team_detect,
            hub::connectors::team_connect,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
