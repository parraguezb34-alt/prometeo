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
        set_low_memory(&w, false);
        // La interfaz vuelve a su ritmo normal (WebView2 no lo avisa con visibilitychange).
        let _ = app.emit_to("main", "app://mostrada", ());
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

/// Con la ventana minimizada u oculta, WebView2 puede soltar cachés y memoria que no ve
/// (nivel «Low»); al volver se pone en «Normal». La interfaz y sus eventos siguen vivos.
pub fn set_low_memory(window: &tauri::WebviewWindow, low: bool) {
    #[cfg(windows)]
    {
        let _ = window.with_webview(move |wv| unsafe {
            use webview2_com::Microsoft::Web::WebView2::Win32::{
                ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
            };
            use windows_core::Interface;
            let Ok(core) = wv.controller().CoreWebView2() else { return };
            let Ok(core19) = core.cast::<ICoreWebView2_19>() else { return };
            let level = if low {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
            } else {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
            };
            let _ = core19.SetMemoryUsageTargetLevel(level);
        });
    }
    #[cfg(not(windows))]
    let _ = (window, low);
}

fn main_webview(window: &Window) -> Option<tauri::WebviewWindow> {
    window.app_handle().get_webview_window(window.label())
}

/// Cerrar la ventana principal la esconde (sigue en la bandeja) en vez de salir.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != "main" || QUITTING.load(Ordering::SeqCst) {
        return;
    }
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = window.hide();
            if let Some(w) = main_webview(window) {
                set_low_memory(&w, true);
            }
            // La interfaz avisa (la primera vez) de que Prometeo sigue en la bandeja.
            let _ = window.app_handle().emit_to("main", "app://bandeja", ());
        }
        // Minimizar llega como un cambio de tamaño; restaurar también.
        WindowEvent::Resized(_) => {
            if let (Some(w), Ok(min)) = (main_webview(window), window.is_minimized()) {
                set_low_memory(&w, min);
            }
        }
        WindowEvent::Focused(true) => {
            if let Some(w) = main_webview(window) {
                set_low_memory(&w, false);
            }
        }
        _ => {}
    }
}
