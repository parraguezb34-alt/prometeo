//! Prometeo en segundo plano: un icono en la bandeja de Windows (junto al reloj). Cerrar la
//! ventana la esconde y los agentes siguen trabajando; desde el icono se vuelve a abrir o se sale
//! de verdad.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Window, WindowEvent};

/// Se está saliendo de verdad (desde «Salir»): ya no se esconde, se cierra.
static QUITTING: AtomicBool = AtomicBool::new(false);

/// Trae la ventana principal al frente (desde el icono, un aviso o al abrir Prometeo otra vez).
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Sale de Prometeo de verdad (cierra terminales y la app en vivo, como al cerrar antes).
pub fn quit(app: &AppHandle) {
    QUITTING.store(true, Ordering::SeqCst);
    app.exit(0);
}

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "abrir", "Abrir Prometeo", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let exit = MenuItem::with_id(app, "salir", "Salir de Prometeo", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &sep, &exit])?;
    let mut tray = TrayIconBuilder::with_id("prometeo")
        .tooltip("Prometeo")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id().as_ref() {
            "abrir" => show_main(app),
            "salir" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// Cerrar la ventana principal la esconde (sigue en la bandeja) en vez de salir.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != "main" || QUITTING.load(Ordering::SeqCst) {
        return;
    }
    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = window.hide();
        // La interfaz avisa (la primera vez) de que Prometeo sigue en la bandeja.
        let _ = window.app_handle().emit_to("main", "app://bandeja", ());
    }
}
