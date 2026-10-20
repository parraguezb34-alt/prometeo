//! Avisos de Prometeo fuera de la app: una ventanita propia en la esquina de la pantalla, con el
//! mismo diseño que la app (en vez del aviso de Windows, que no se puede personalizar). No
//! roba el foco; al pulsar un aviso se abre Prometeo en lo que avisa.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "aviso";
/// Ancho de la ventana (en puntos lógicos) y separación con el borde de la pantalla.
const WIDTH: f64 = 380.0;
const MARGIN: f64 = 12.0;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Aviso {
    pub id: String,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub agent: Option<String>,
    /// ask | done | reply | late | info
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub ts_ms: u64,
}

/// Avisos que la ventana aún no ha recogido (puede estar abriéndose).
static PENDING: Mutex<Vec<Aviso>> = Mutex::new(Vec::new());

fn place(win: &tauri::WebviewWindow, height: f64) {
    let mon = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| win.primary_monitor().ok().flatten());
    let Some(m) = mon else { return };
    let sf = m.scale_factor();
    let area = m.work_area();
    let w = (WIDTH * sf).round() as u32;
    let h = (height.clamp(40.0, 900.0) * sf).round() as u32;
    let x = area.position.x + area.size.width as i32 - w as i32 - (MARGIN * sf) as i32;
    let y = area.position.y + area.size.height as i32 - h as i32 - (MARGIN * sf) as i32;
    let _ = win.set_size(PhysicalSize::new(w, h));
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

/// Muestra un aviso en la esquina (abre la ventanita si no estaba).
#[tauri::command]
pub fn aviso_push(app: AppHandle, item: Aviso) -> Result<(), String> {
    PENDING.lock().map_err(|e| e.to_string())?.push(item);
    if app.get_webview_window(LABEL).is_some() {
        let _ = app.emit_to(LABEL, "aviso://poke", ());
        return Ok(());
    }
    let win = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html?aviso=1".into()))
        .title("Avisos de Prometeo")
        .inner_size(WIDTH, 110.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .build()
        .map_err(|e| e.to_string())?;
    place(&win, 110.0);
    Ok(())
}

/// La ventanita recoge los avisos pendientes.
#[tauri::command]
pub fn aviso_take() -> Vec<Aviso> {
    PENDING.lock().map(|mut p| std::mem::take(&mut *p)).unwrap_or_default()
}

/// La ventanita mide lo que ocupa: se ajusta y se queda pegada a la esquina.
#[tauri::command]
pub fn aviso_resize(app: AppHandle, height: f64) {
    if let Some(w) = app.get_webview_window(LABEL) {
        place(&w, height);
    }
}

#[tauri::command]
pub fn aviso_close(app: AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.close();
    }
}

/// Pulsaste un aviso: lienzo se pone delante y abre lo que avisaba.
#[tauri::command]
pub fn aviso_open(app: AppHandle, item: Aviso) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
    let _ = app.emit_to("main", "aviso://open", item);
}
