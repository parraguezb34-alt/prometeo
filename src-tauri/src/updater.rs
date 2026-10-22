//! Actualizarse sin pasar a mano por el instalador. Cuando en la carpeta del código de Prometeo hay
//! un instalador recién compilado distinto de lo que está corriendo, la app lo ofrece; al aceptar,
//! un script aparte espera a que Prometeo se cierre, instala en silencio y lo vuelve a abrir (la
//! interfaz reabre después las terminales de los agentes que estaban abiertas).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

/// Dónde se compila Prometeo: la carpeta del código con la que se hizo esta versión.
fn source_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

#[derive(Serialize, Clone, Default)]
pub struct UpdateInfo {
    /// Hay una versión nueva lista para instalar.
    available: bool,
    /// El instalador que se usará.
    setup: String,
    /// Cuándo se compiló (ms epoch).
    built_ms: u64,
    /// Por qué no hay (en desarrollo, sin compilar…), para Ajustes.
    reason: String,
}

fn mtime_ms(p: &Path) -> u64 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// El instalador NSIS más nuevo de la carpeta de compilación.
fn newest_setup(nsis: &Path) -> Option<PathBuf> {
    std::fs::read_dir(nsis)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            let n = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
            n.ends_with("-setup.exe")
        })
        .max_by_key(|p| mtime_ms(p))
}

/// ¿Dos ejecutables son el mismo? (primero el tamaño; si coincide, el contenido).
fn same_file(a: &Path, b: &Path) -> bool {
    let (Ok(ma), Ok(mb)) = (std::fs::metadata(a), std::fs::metadata(b)) else { return false };
    if ma.len() != mb.len() {
        return false;
    }
    match (std::fs::read(a), std::fs::read(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

/// La última comprobación (instalador y su fecha → resultado), para no leer los ejecutables enteros
/// cada vez que la interfaz pregunta.
static LAST: Mutex<Option<(String, u64, UpdateInfo)>> = Mutex::new(None);

pub fn check_in(source: &Path, current: &Path) -> UpdateInfo {
    let release = source.join("target").join("release");
    if current.starts_with(source.join("target")) {
        return UpdateInfo { reason: "Es la versión de desarrollo: se actualiza sola al compilar.".into(), ..Default::default() };
    }
    let Some(setup) = newest_setup(&release.join("bundle").join("nsis")) else {
        return UpdateInfo { reason: format!("Aún no hay ningún instalador compilado en {}.", release.display()), ..Default::default() };
    };
    let built = release.join("lienzo.exe");
    let built_ms = mtime_ms(&setup);
    let key = setup.display().to_string();
    if let Ok(last) = LAST.lock() {
        if let Some((k, ms, info)) = last.as_ref() {
            if *k == key && *ms == built_ms {
                return info.clone();
            }
        }
    }
    // El instalador lleva dentro el lienzo.exe recién compilado: si es igual al que corre, ya está.
    let available = built.is_file() && !same_file(&built, current);
    let info = UpdateInfo {
        available,
        setup: key.clone(),
        built_ms,
        reason: if available { String::new() } else { "Ya tienes la última versión compilada.".into() },
    };
    if let Ok(mut last) = LAST.lock() {
        *last = Some((key, built_ms, info.clone()));
    }
    info
}

#[tauri::command]
pub async fn update_check() -> UpdateInfo {
    match std::env::current_exe() {
        Ok(cur) => check_in(&source_dir(), &cur),
        Err(e) => UpdateInfo { reason: e.to_string(), ..Default::default() },
    }
}

/// Comillas simples de PowerShell.
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// El script que actualiza: espera a que Prometeo se cierre, cierra los puentes MCP de esta
/// instalación (si no, el instalador no puede reemplazarlos), instala en silencio y vuelve a abrir.
pub fn script(pid: u32, setup: &str, exe: &str, install_dir: &str) -> String {
    format!(
        "$ErrorActionPreference = 'SilentlyContinue'\r\n\
         Wait-Process -Id {pid} -Timeout 30\r\n\
         Get-Process lienzo -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -eq {exe} }} | Stop-Process -Force\r\n\
         Get-Process lienzo-mcp -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -like ({dir} + '\\*') }} | Stop-Process -Force\r\n\
         Start-Sleep -Milliseconds 800\r\n\
         $p = Start-Process -FilePath {setup} -ArgumentList '/S' -Wait -PassThru\r\n\
         Start-Process -FilePath {exe}\r\n",
        exe = ps_quote(exe),
        dir = ps_quote(install_dir),
        setup = ps_quote(setup),
    )
}

/// Instala la versión nueva: lanza el script aparte y cierra Prometeo.
#[tauri::command]
pub async fn update_apply(app: tauri::AppHandle) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let cur = std::env::current_exe().map_err(|e| e.to_string())?;
    let info = check_in(&source_dir(), &cur);
    if !info.available {
        return Err(if info.reason.is_empty() { "No hay ninguna versión nueva.".into() } else { info.reason });
    }
    let dir = cur.parent().ok_or("no sé dónde está instalado Prometeo")?;
    let body = script(std::process::id(), &info.setup, &cur.display().to_string(), &dir.display().to_string());
    let path = std::env::temp_dir().join(format!("prometeo-actualizar-{}.ps1", std::process::id()));
    std::fs::write(&path, body).map_err(|e| format!("No se pudo preparar la actualización: {e}"))?;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File"])
        .arg(&path)
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("No se pudo lanzar la actualización: {e}"))?;
    crate::errlog::log("update", "Actualizando Prometeo", &info.setup);
    // Un respiro para que la interfaz guarde lo que tenga pendiente.
    std::thread::sleep(std::time::Duration::from_millis(300));
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detecta_un_instalador_nuevo_y_distinto() {
        let base = std::env::temp_dir().join(format!("lienzo-upd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let src = base.join("src");
        let nsis = src.join("target/release/bundle/nsis");
        std::fs::create_dir_all(&nsis).unwrap();
        let inst = base.join("inst");
        std::fs::create_dir_all(&inst).unwrap();
        let cur = inst.join("lienzo.exe");
        std::fs::write(&cur, b"version-1").unwrap();

        // Sin instalador compilado.
        assert!(!check_in(&src, &cur).available);
        std::fs::write(src.join("target/release/lienzo.exe"), b"version-1").unwrap();
        std::fs::write(nsis.join("Prometeo_1.0.0_x64-setup.exe"), b"setup-1").unwrap();
        // El mismo programa que corre: nada que hacer.
        let i = check_in(&src, &cur);
        assert!(!i.available, "{}", i.reason);
        // Compilado otro distinto (y otro instalador): hay versión nueva.
        std::thread::sleep(std::time::Duration::from_millis(30));
        std::fs::write(src.join("target/release/lienzo.exe"), b"version-2").unwrap();
        std::fs::write(nsis.join("Prometeo_1.0.0_x64-setup.exe"), b"setup-2!").unwrap();
        let i = check_in(&src, &cur);
        assert!(i.available);
        assert!(i.setup.ends_with("-setup.exe"));
        // Corriendo desde la carpeta de compilación (desarrollo): nunca.
        assert!(!check_in(&src, &src.join("target/debug/lienzo.exe")).available);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn el_script_espera_instala_y_reabre() {
        let s = script(42, r"C:\src\Prometeo_1.0.0_x64-setup.exe", r"C:\Users\x\AppData\Local\Prometeo\lienzo.exe", r"C:\Users\x\AppData\Local\Prometeo");
        assert!(s.contains("Wait-Process -Id 42"));
        assert!(s.contains(r"-FilePath 'C:\src\Prometeo_1.0.0_x64-setup.exe' -ArgumentList '/S' -Wait"));
        assert!(s.contains(r"Start-Process -FilePath 'C:\Users\x\AppData\Local\Prometeo\lienzo.exe'"));
        assert!(s.contains(r"-like ('C:\Users\x\AppData\Local\Prometeo' + '\*')"));
        assert_eq!(ps_quote("it's"), "'it''s'");
    }
}
