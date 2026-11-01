mod aviso;
mod autostart;
mod cleanup;

/// Argumentos del visor web (los mismos en `tauri.conf.json` y en la ventana de avisos): los de
/// Tauri por defecto, una caché de 20 MB (sin tope llegó a ~180 MB para una app local) y sin las
/// descargas de componentes de Edge que no hacen falta aquí (Widevine, filtro de anuncios).
pub const WEBVIEW_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disk-cache-size=20971520 --disable-component-update";
mod chatstore;
mod devapp;
pub mod errlog;
pub mod history;
pub mod hub;
pub mod workspace;
mod limits;
mod project;
mod pcshot;
mod pcstatus;
mod selftest;
mod pty;
mod rename;
mod remote;
mod remote_files;
mod research;
pub mod skills;
mod tray;
mod updater;
mod viewer;

// Los tests también necesitan el manifiesto de Windows que tauri-build solo
// enlaza en los binarios (ver build.rs); sin él no llegan a arrancar.
#[cfg(all(test, windows))]
#[link(name = "resource", kind = "static", modifiers = "+whole-archive")]
unsafe extern "C" {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Antes de que exista el visor web: lo que su perfil guardó y ya sobra.
    cleanup::at_startup();
    tauri::Builder::default()
        // Una sola Prometeo: abrirla otra vez (p. ej. con ella en la bandeja) trae la que ya está.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| tray::show_main(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::PtyManager::default())
        .setup(|app| {
            errlog::install_panic_hook();
            if let Err(e) = hub::init(app.handle().clone()) {
                errlog::log("hub", "No se pudo iniciar el hub del equipo", &e);
            }
            // Un acceso remoto que ya estaba encendido no debe aceptar RPC antes de que `Hub`
            // exista en el estado de Tauri (en especial `team_state` al abrir el enlace).
            remote::init(app.handle().clone());
            // Las skills de esta versión de Prometeo al proyecto abierto (y su lista en CLAUDE.md y
            // AGENTS.md): si los agentes ya estaban conectados, nadie más las pondría al día.
            let project = hub::with_inner(app.handle(), |i| i.project.clone()).flatten();
            std::thread::spawn(move || {
                skills::apply(project);
            });
            // Antigravity se actualiza sin ventana, en segundo plano, una vez al día.
            std::thread::spawn(|| {
                std::thread::sleep(std::time::Duration::from_secs(90));
                hub::connectors::update_agy_daily();
            });
            if let Err(e) = tray::init(app.handle()) {
                errlog::log("bandeja", "No se pudo crear el icono de la bandeja", &e.to_string());
            }
            autostart::hide_for_startup(app.handle());
            Ok(())
        })
        .on_window_event(tray::on_window_event)
        .invoke_handler(tauri::generate_handler![
            autostart::autostart_status,
            autostart::autostart_set,
            selftest::selftest_run,
            remote::remote_status,
            remote::remote_set,
            remote::remote_rotate_token,
            remote::remote_layout_set,
            remote::remote_layout_get,
            remote::remote_push_vapid_key,
            remote::remote_push_subscribe,
            remote::remote_push_unsubscribe,
            remote::remote_push_send,
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
            hub::team_sleep_decision,
            limits::opencode_go_usage,
            hub::team_leader,
            hub::team_usage_reset,
            hub::team_director,
            hub::team_plan,
            hub::team_isolate,
            hub::team_schedule_op,
            hub::team_schedule_fire,
            hub::team_schedule_save,
            hub::team_schedule_link,
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
            chatstore::chats_read,
            chatstore::chats_write,
            viewer::file_blob,
            viewer::file_text,
            viewer::file_open_external,
            viewer::file_reveal,
            viewer::file_office,
            viewer::export_save,
            updater::update_check,
            updater::app_about,
            updater::update_apply,
            hub::team_events_range,
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
                // Lo que el hub aún no había guardado (guarda como mucho una vez por segundo).
                hub::flush_pending();
            }
        });
}

#[cfg(test)]
mod webview_args_tests {
    #[test]
    fn la_ventana_principal_y_la_de_avisos_arrancan_igual() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["app"]["windows"][0]["additionalBrowserArgs"], super::WEBVIEW_ARGS);
        assert!(super::WEBVIEW_ARGS.contains("msWebOOUI"), "sin perder los de Tauri por defecto");
    }
}

#[cfg(test)]
mod no_console_tests {
    /// La app instalada no tiene consola: cada programa que lance sin `CREATE_NO_WINDOW` abre una
    /// ventana negra que parpadea. Todo `Command::new` del código de la app debe ocultarla (cerca
    /// de él tiene que aparecer `creation_flags`, `no_window` o `hidden`).
    #[test]
    fn ningun_proceso_abre_ventana_de_consola() {
        let mut missing = vec![];
        let mut stack = vec![std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/src"))];
        while let Some(dir) = stack.pop() {
            for e in std::fs::read_dir(&dir).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    // El puente lo lanzan los agentes desde su terminal, no la app.
                    if p.file_name().is_some_and(|n| n != "bin") {
                        stack.push(p);
                    }
                    continue;
                }
                if p.extension().is_none_or(|x| x != "rs") {
                    continue;
                }
                let text = std::fs::read_to_string(&p).unwrap();
                let lines: Vec<&str> = text.lines().collect();
                for (i, l) in lines.iter().enumerate() {
                    if !l.contains("Command::new(") || l.trim_start().starts_with("//") || l.contains("contains(\"Command::new(\")") {
                        continue;
                    }
                    let near = lines[i.saturating_sub(3)..(i + 20).min(lines.len())].join("\n");
                    // `sh` solo existe fuera de Windows; `run(` de skills.rs ya pasa por `hidden`.
                    let prev = if i > 0 { lines[i - 1] } else { "" };
                    let via_run = (l.contains("run(") || prev.trim_end().ends_with("run(")) && text.contains("hidden(cmd).output()");
                    let ok = ["creation_flags", "no_window(", "hidden("].iter().any(|k| near.contains(k))
                        || l.contains("\"sh\"")
                        || via_run;
                    if !ok {
                        missing.push(format!("{}:{}", p.display(), i + 1));
                    }
                }
            }
        }
        assert!(missing.is_empty(), "Procesos que abrirían una ventana de consola: {missing:?}");
    }
}
