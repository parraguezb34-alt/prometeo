//! Inicio de Prometeo al iniciar sesión en Windows.
use tauri::Manager;

pub const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
pub const STARTUP_ARG: &str = "--startup-minimized";
const APP_NAME: &str = "Prometeo";
const DEV_APP_NAME: &str = "Prometeo Dev";

fn value_name_for(is_dev: bool) -> &'static str {
    if is_dev { DEV_APP_NAME } else { APP_NAME }
}

fn run_value_for(executable: &str) -> String {
    format!("\"{executable}\" {STARTUP_ARG}")
}

pub fn started_minimized() -> bool {
    std::env::args_os().any(|arg| arg.to_string_lossy() == STARTUP_ARG)
}

#[tauri::command]
pub fn autostart_status() -> Result<bool, String> {
    #[cfg(windows)]
    {
        use winreg::{RegKey, enums::HKEY_CURRENT_USER};

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let key = match hkcu.open_subkey(RUN_KEY) {
            Ok(key) => key,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(format!("No pude leer el inicio de Windows: {error}")),
        };
        let expected = run_value_for(&std::env::current_exe().map_err(|e| e.to_string())?.to_string_lossy());
        match key.get_value::<String, _>(value_name_for(crate::hub::IS_DEV)) {
            Ok(value) => Ok(value == expected),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(format!("No pude leer el inicio de Windows: {error}")),
        }
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

#[tauri::command]
pub fn autostart_set(enabled: bool) -> Result<bool, String> {
    #[cfg(windows)]
    {
        use winreg::{RegKey, enums::{HKEY_CURRENT_USER, KEY_WRITE}};

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if enabled {
            let (key, _) = hkcu
                .create_subkey(RUN_KEY)
                .map_err(|e| format!("No pude configurar el inicio de Windows: {e}"))?;
            let executable = std::env::current_exe().map_err(|e| e.to_string())?;
            let value = run_value_for(&executable.to_string_lossy());
            key.set_value(value_name_for(crate::hub::IS_DEV), &value)
                .map_err(|e| format!("No pude configurar el inicio de Windows: {e}"))?;
            return Ok(true);
        }

        let key = match hkcu.open_subkey_with_flags(RUN_KEY, KEY_WRITE) {
            Ok(key) => key,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(format!("No pude quitar el inicio de Windows: {error}")),
        };
        match key.delete_value(value_name_for(crate::hub::IS_DEV)) {
            Ok(()) => Ok(false),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(format!("No pude quitar el inicio de Windows: {error}")),
        }
    }
    #[cfg(not(windows))]
    {
        if enabled {
            Err("El inicio automático solo está disponible en Windows.".into())
        } else {
            Ok(false)
        }
    }
}

/// Oculta la ventana solo al iniciar desde la clave Run; el icono de bandeja ya se crea en setup.
pub fn hide_for_startup(app: &tauri::AppHandle) {
    if !started_minimized() {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
        crate::tray::set_low_memory(&window, true);
    }
}

#[cfg(test)]
mod tests {
    use super::{RUN_KEY, STARTUP_ARG, value_name_for, run_value_for};

    #[test]
    fn uses_the_per_user_run_key() {
        assert_eq!(RUN_KEY, r"Software\Microsoft\Windows\CurrentVersion\Run");
    }

    #[test]
    fn quotes_the_executable_and_starts_minimized() {
        assert_eq!(
            run_value_for(r"C:\Program Files\Prometeo\lienzo.exe"),
            format!(r#""C:\Program Files\Prometeo\lienzo.exe" {STARTUP_ARG}"#),
        );
    }

    #[test]
    fn installed_and_dev_use_separate_run_value_names() {
        assert_eq!(value_name_for(false), "Prometeo");
        assert_eq!(value_name_for(true), "Prometeo Dev");
    }
}
