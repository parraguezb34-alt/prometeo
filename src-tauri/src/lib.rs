mod pty;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(pty::PtyManager::default())
        .invoke_handler(tauri::generate_handler![
            pty::term_spawn,
            pty::term_write,
            pty::term_resize,
            pty::term_kill,
            pty::term_list,
            pty::term_scrollback,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
