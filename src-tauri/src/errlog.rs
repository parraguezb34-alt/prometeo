//! Registro de errores de lienzo: lo que falla en la interfaz, en el hub, en el historial o al
//! arrancar la app, con la hora y el detalle. Se guarda en `%APPDATA%/lienzo/errores.jsonl`
//! (una línea por error) y se ve en Ajustes → Errores.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

const KEEP: usize = 500;
const MSG_CAP: usize = 600;
const DETAIL_CAP: usize = 8000;

static LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ErrEntry {
    pub ts_ms: u64,
    /// De dónde viene: interfaz, hub, historial, app, agente, interno…
    pub source: String,
    pub message: String,
    #[serde(default)]
    pub detail: String,
}

fn file() -> PathBuf {
    match std::env::var("LIENZO_ERRLOG") {
        Ok(p) if !p.is_empty() => PathBuf::from(p),
        _ => crate::hub::data_dir().join("errores.jsonl"),
    }
}

fn cut(s: &str, n: usize) -> String {
    if s.len() <= n {
        return s.to_string();
    }
    let mut i = n;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    format!("{}…", &s[..i])
}

fn read_all() -> Vec<ErrEntry> {
    std::fs::read_to_string(file())
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

/// Anota un error (y lo saca también por la consola).
pub fn log(source: &str, message: &str, detail: &str) {
    let e = ErrEntry {
        ts_ms: crate::hub::now_ms(),
        source: cut(source.trim(), 40),
        message: cut(message.trim(), MSG_CAP),
        detail: cut(detail.trim(), DETAIL_CAP),
    };
    if e.message.is_empty() {
        return;
    }
    eprintln!("[{}] {}", e.source, e.message);
    {
        let Ok(_g) = LOCK.lock() else { return };
        let path = file();
        if let Ok(line) = serde_json::to_string(&e) {
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
                let _ = writeln!(f, "{line}");
            }
        }
        // De vez en cuando se recorta a los últimos KEEP.
        let all = read_all();
        if all.len() > KEEP + 100 {
            let keep = &all[all.len() - KEEP..];
            let text: String = keep.iter().filter_map(|x| serde_json::to_string(x).ok()).map(|l| l + "\n").collect();
            let _ = std::fs::write(&path, text);
        }
    }
    crate::hub::emit_ui("lienzo://error", e);
}

/// Los pánicos de Rust también quedan anotados (además del mensaje de siempre).
pub fn install_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "pánico sin mensaje".into());
        let at = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        let thread = std::thread::current().name().unwrap_or("sin nombre").to_string();
        log("interno", &format!("Fallo interno: {msg}"), &format!("en {at} (hilo {thread})"));
        prev(info);
    }));
}

#[tauri::command]
pub async fn errors_list() -> Result<Vec<ErrEntry>, String> {
    let _g = LOCK.lock().map_err(|e| e.to_string())?;
    let mut all = read_all();
    all.reverse();
    Ok(all)
}

#[tauri::command]
pub async fn errors_clear() -> Result<(), String> {
    let _g = LOCK.lock().map_err(|e| e.to_string())?;
    match std::fs::remove_file(file()) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Dónde está el archivo del registro (para enseñarlo en el explorador).
#[tauri::command]
pub async fn errors_file() -> Result<String, String> {
    let p = file();
    if !p.exists() {
        let _ = std::fs::write(&p, "");
    }
    Ok(p.display().to_string())
}

/// Lo que falla en la interfaz llega por aquí.
#[tauri::command]
pub async fn errors_report(source: String, message: String, detail: Option<String>) -> Result<(), String> {
    log(&source, &message, detail.as_deref().unwrap_or(""));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anota_lee_recorta_y_borra() {
        let p = std::env::temp_dir().join(format!("lienzo-err-{}.jsonl", std::process::id()));
        let _ = std::fs::remove_file(&p);
        unsafe { std::env::set_var("LIENZO_ERRLOG", &p) };
        log("hub", "  algo falló  ", "detalle");
        log("interfaz", "", "vacío: no se anota");
        log("app", &"x".repeat(2000), "");
        let all = tauri::async_runtime::block_on(errors_list()).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[1].message, "algo falló");
        assert_eq!(all[1].source, "hub");
        assert!(all[0].message.chars().count() <= MSG_CAP + 1);
        for i in 0..(KEEP + 120) {
            log("prueba", &format!("n{i}"), "");
        }
        let all = tauri::async_runtime::block_on(errors_list()).unwrap();
        assert!(all.len() <= KEEP + 100, "{}", all.len());
        assert_eq!(all[0].message, format!("n{}", KEEP + 119));
        tauri::async_runtime::block_on(errors_clear()).unwrap();
        assert!(tauri::async_runtime::block_on(errors_list()).unwrap().is_empty());
        unsafe { std::env::remove_var("LIENZO_ERRLOG") };
    }
}
