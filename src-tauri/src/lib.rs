mod aviso;
mod devapp;
pub mod errlog;
pub mod history;
pub mod hub;
mod limits;
mod project;
mod pty;
mod rename;
mod research;
pub mod skills;

// Los tests también necesitan el manifiesto de Windows que tauri-build solo
// enlaza en los binarios (ver build.rs); sin él no llegan a arrancar.
#[cfg(all(test, windows))]
#[link(name = "resource", kind = "static", modifiers = "+whole-archive")]
unsafe extern "C" {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::PtyManager::default())
        .setup(|app| {
            errlog::install_panic_hook();
            if let Err(e) = hub::init(app.handle().clone()) {
                errlog::log("hub", "No se pudo iniciar el hub del equipo", &e);
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
            hub::team_answer,
            hub::team_limits_set,
            limits::opencode_go_usage,
            hub::team_leader,
            hub::team_usage_reset,
            hub::team_director,
            hub::team_strengths,
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
            project::project_save_attachment,
            project::project_attach_path,
            project::project_create_dir,
            skills::skills_list,
            skills::skills_set,
            skills::skills_remove,
            skills::skills_read,
            skills::skills_install,
            history::history_list,
            history::history_diff,
            history::history_revert,
            history::history_save,
            devapp::app_detect,
            devapp::app_start,
            devapp::app_stop,
            rename::project_rename,
            research::research_start,
            research::research_list,
            research::research_read,
            research::research_remove,
            devapp::app_status,
            errlog::errors_list,
            errlog::errors_clear,
            errlog::errors_file,
            errlog::errors_report,
            aviso::aviso_push,
            aviso::aviso_take,
            aviso::aviso_resize,
            aviso::aviso_close,
            aviso::aviso_open,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_, ev| {
            // Al cerrar lienzo, la app en vivo (npm run dev…) se cierra con él.
            if let tauri::RunEvent::Exit = ev {
                devapp::stop();
            }
        });
}
