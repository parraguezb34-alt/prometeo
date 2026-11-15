//! Actualizarse sin pasar a mano por el instalador. Cuando en la carpeta del código de Prometeo hay
//! un instalador recién compilado distinto de lo que está corriendo, la app lo ofrece; al aceptar,
//! un script aparte espera a que Prometeo se cierre, instala en silencio y lo vuelve a abrir (la
//! interfaz reabre después las terminales de los agentes que estaban abiertas).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::Emitter;
use tauri_plugin_updater::UpdaterExt;

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
    /// Su número de versión (del nombre del instalador).
    version: String,
    /// Por qué no hay (en desarrollo, sin compilar…), para Ajustes.
    reason: String,
    /// Origen de la actualización: compilación local o GitHub Releases.
    source: String,
    /// Novedades publicadas con la versión de GitHub.
    notes: String,
}

#[derive(Debug, PartialEq, Eq)]
enum UpdateSource {
    Local,
    Github,
}

fn update_source(source: &Path) -> UpdateSource {
    if source.is_dir() { UpdateSource::Local } else { UpdateSource::Github }
}

#[derive(Serialize, Clone)]
struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
    stage: &'static str,
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

/// Al empaquetar, Tauri marca dentro del ejecutable con qué instalador va
/// (`__TAURI_BUNDLE_TYPE_VAR_UNK` → `…_NSS`): esos 3 bytes no cuentan al comparar.
const BUNDLE_MARK: &[u8] = b"__TAURI_BUNDLE_TYPE_VAR_";

fn unmark(mut b: Vec<u8>) -> Vec<u8> {
    let mut i = 0;
    while let Some(at) = b[i..].windows(BUNDLE_MARK.len()).position(|w| w == BUNDLE_MARK) {
        let end = i + at + BUNDLE_MARK.len();
        for x in b.iter_mut().skip(end).take(3) {
            *x = b'_';
        }
        i = end;
    }
    b
}

/// ¿Dos ejecutables son el mismo programa? (primero el tamaño; si coincide, el contenido).
fn same_file(a: &Path, b: &Path) -> bool {
    let (Ok(ma), Ok(mb)) = (std::fs::metadata(a), std::fs::metadata(b)) else { return false };
    if ma.len() != mb.len() {
        return false;
    }
    match (std::fs::read(a), std::fs::read(b)) {
        (Ok(x), Ok(y)) => x == y || unmark(x) == unmark(y),
        _ => false,
    }
}

/// La última comprobación (instalador y su fecha → resultado), para no leer los ejecutables enteros
/// cada vez que la interfaz pregunta.
static LAST: Mutex<Option<(String, u64, UpdateInfo)>> = Mutex::new(None);

pub fn check_in(source: &Path, current: &Path) -> UpdateInfo {
    let release = source.join("target").join("release");
    if current.starts_with(source.join("target")) {
        return UpdateInfo { source: "local".into(), reason: "Es la versión de desarrollo: se actualiza sola al compilar.".into(), ..Default::default() };
    }
    let Some(setup) = newest_setup(&release.join("bundle").join("nsis")) else {
        return UpdateInfo { source: "local".into(), reason: format!("Aún no hay ningún instalador compilado en {}.", release.display()), ..Default::default() };
    };
    let built = release.join("lienzo.exe");
    let built_ms = mtime_ms(&setup);
    let key = setup.display().to_string();
    if let Ok(last) = LAST.lock()
        && let Some((k, ms, info)) = last.as_ref()
            && *k == key && *ms == built_ms {
                return info.clone();
            }
    // El instalador lleva dentro el lienzo.exe recién compilado: si es igual al que corre, ya está.
    let available = built.is_file() && !same_file(&built, current);
    let info = UpdateInfo {
        available,
        version: setup_version(&key),
        setup: key.clone(),
        built_ms,
        reason: if available { String::new() } else { "Ya tienes la última versión compilada.".into() },
        source: "local".into(),
        notes: String::new(),
    };
    if let Ok(mut last) = LAST.lock() {
        *last = Some((key, built_ms, info.clone()));
    }
    info
}

async fn check_github(app: &tauri::AppHandle) -> UpdateInfo {
    let result = async {
        app.updater_builder()
            .timeout(std::time::Duration::from_secs(12))
            .build()?
            .check()
            .await
    }.await;
    match result {
        Ok(Some(update)) => UpdateInfo {
            available: true,
            version: update.version,
            notes: update.body.unwrap_or_default(),
            source: "github".into(),
            ..Default::default()
        },
        Ok(None) => UpdateInfo {
            source: "github".into(),
            reason: "Ya tienes la última versión publicada.".into(),
            ..Default::default()
        },
        Err(_) => UpdateInfo {
            source: "github".into(),
            reason: "No pude consultar GitHub. Comprueba la conexión y vuelve a intentarlo.".into(),
            ..Default::default()
        },
    }
}

#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> UpdateInfo {
    // Prometeo Dev se recompila con `npm run dev:app`; el instalador es del Prometeo normal.
    if crate::hub::IS_DEV {
        return UpdateInfo { source: "dev".into(), reason: "Prometeo Dev no se actualiza: se recompila con npm run dev:app".into(), ..Default::default() };
    }
    match update_source(&source_dir()) {
        UpdateSource::Local => match std::env::current_exe() {
            Ok(cur) => check_in(&source_dir(), &cur),
            Err(e) => UpdateInfo { source: "local".into(), reason: e.to_string(), ..Default::default() },
        },
        UpdateSource::Github => check_github(&app).await,
    }
}

/// Un commit de los que trae esta versión.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Change {
    hash: String,
    ts_ms: u64,
    subject: String,
}

/// Qué versión corre: número, commit, cuándo se compiló y sus últimos cambios.
#[derive(Serialize)]
pub struct About {
    version: &'static str,
    commit: &'static str,
    /// Se compiló con cambios aún sin guardar en git.
    dirty: bool,
    built_ms: u64,
    changes: Vec<Change>,
    /// Es Prometeo Dev (la versión de desarrollo, con sus datos aparte).
    dev: bool,
}

/// Las líneas `hash<US>fecha<US>asunto` que deja build.rs.
pub fn parse_changes(raw: &str) -> Vec<Change> {
    raw.lines()
        .filter_map(|l| {
            let mut it = l.splitn(3, '\u{1f}');
            let hash = it.next()?.trim().to_string();
            let ts: u64 = it.next()?.trim().parse().ok()?;
            let subject = it.next()?.trim().to_string();
            (!hash.is_empty()).then_some(Change { hash, ts_ms: ts * 1000, subject })
        })
        .collect()
}

#[tauri::command]
pub fn app_about() -> About {
    About {
        version: env!("CARGO_PKG_VERSION"),
        commit: env!("PROMETEO_COMMIT"),
        dirty: !env!("PROMETEO_DIRTY").is_empty(),
        built_ms: env!("PROMETEO_BUILT_MS").parse().unwrap_or(0),
        changes: parse_changes(include_str!(concat!(env!("OUT_DIR"), "/cambios.txt"))),
        dev: crate::hub::IS_DEV,
    }
}

/// «Prometeo_1.0.104_x64-setup.exe» → «1.0.104».
pub fn setup_version(setup: &str) -> String {
    let name = setup.rsplit(['\\', '/']).next().unwrap_or("");
    name.split('_').nth(1).filter(|v| v.chars().next().is_some_and(|c| c.is_ascii_digit())).unwrap_or("").to_string()
}

/// Comillas simples de PowerShell.
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// El script que actualiza: espera a que Prometeo se cierre, cierra lo que quede de Prometeo (la
/// app y sus puentes MCP, estén donde estén: si no, el instalador no puede reemplazarlos), instala en
/// silencio, comprueba que quedó la versión `want` (si no, lo vuelve a intentar una vez) y lo abre de
/// nuevo. Cada paso queda en `%APPDATA%\lienzo\actualizar.log`, y un fallo, en Ajustes › Errores.
pub fn script(pid: u32, setup: &str, exe: &str, want: &str) -> String {
    format!(
        "$ErrorActionPreference = 'SilentlyContinue'\r\n\
         $log = Join-Path $env:APPDATA 'lienzo\\actualizar.log'\r\n\
         function Say($m) {{ Add-Content -Path $log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $m) -Encoding UTF8 }}\r\n\
         function Installed {{ (Get-Item -LiteralPath {exe}).VersionInfo.ProductVersion }}\r\n\
         function Ours {{ Get-Process lienzo, lienzo-mcp -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -like '*\\Prometeo\\*' }} }}\r\n\
         function CloseAll {{ Ours | Stop-Process -Force; $t = 0; while ((Ours) -and $t -lt 40) {{ Start-Sleep -Milliseconds 250; $t++ }}; Start-Sleep -Milliseconds 500 }}\r\n\
         Say ('Actualizar a ' + {want} + ' desde ' + (Installed) + ' con ' + {setup})\r\n\
         Wait-Process -Id {pid} -Timeout 30\r\n\
         CloseAll\r\n\
         $ok = $false\r\n\
         foreach ($n in 1..2) {{\r\n\
         \x20 $p = Start-Process -FilePath {setup} -ArgumentList '/S' -Wait -PassThru\r\n\
         \x20 $now = Installed\r\n\
         \x20 Say ('Intento ' + $n + ': el instalador terminó con código ' + $p.ExitCode + '; instalada ' + $now)\r\n\
         \x20 if ($p.ExitCode -eq 0 -and ({want} -eq '' -or $now -eq {want})) {{ $ok = $true; break }}\r\n\
         \x20 CloseAll\r\n\
         \x20 Start-Sleep -Seconds 2\r\n\
         }}\r\n\
         if (-not $ok) {{\r\n\
         \x20 $e = @{{ ts_ms = [DateTimeOffset]::Now.ToUnixTimeMilliseconds(); source = 'update'; message = 'La actualización no se instaló'; detail = ('Sigue la ' + (Installed) + '. Mira ' + $log) }} | ConvertTo-Json -Compress\r\n\
         \x20 Add-Content -Path (Join-Path $env:APPDATA 'lienzo\\errores.jsonl') -Value $e -Encoding UTF8\r\n\
         }}\r\n\
         Say ('Listo: ' + $(if ($ok) {{ 'instalada' }} else {{ 'NO se instaló' }}) + '; abro Prometeo')\r\n\
         Start-Process -FilePath {exe}\r\n",
        exe = ps_quote(exe),
        want = ps_quote(want),
        setup = ps_quote(setup),
    )
}

/// Instala la versión nueva: lanza el script aparte y cierra Prometeo.
async fn apply_github(app: tauri::AppHandle) -> Result<(), String> {
    let update = app
        .updater_builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("No hay ninguna versión nueva publicada.")?;
    let _ = app.emit("update://progress", UpdateProgress { downloaded: 0, total: None, stage: "downloading" });
    let progress_app = app.clone();
    let finish_app = app.clone();
    let mut downloaded = 0u64;
    update
        .download_and_install(
            move |chunk, total| {
                downloaded = downloaded.saturating_add(chunk as u64);
                let _ = progress_app.emit("update://progress", UpdateProgress { downloaded, total, stage: "downloading" });
            },
            move || {
                let _ = finish_app.emit("update://progress", UpdateProgress { downloaded: 0, total: None, stage: "installing" });
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    // En Windows el instalador cierra y reabre la app; en otros sistemas se hace aquí.
    #[cfg(not(windows))]
    app.restart();
    Ok(())
}

#[tauri::command]
pub async fn update_apply(app: tauri::AppHandle) -> Result<(), String> {
    if crate::hub::IS_DEV {
        return Err("Prometeo Dev se recompila; no instala actualizaciones.".into());
    }
    if update_source(&source_dir()) == UpdateSource::Github {
        return apply_github(app).await;
    }
    use std::os::windows::process::CommandExt;
    let cur = std::env::current_exe().map_err(|e| e.to_string())?;
    let info = check_in(&source_dir(), &cur);
    if !info.available {
        return Err(if info.reason.is_empty() { "No hay ninguna versión nueva.".into() } else { info.reason });
    }
    let body = script(std::process::id(), &info.setup, &cur.display().to_string(), &info.version);
    let path = std::env::temp_dir().join(format!("prometeo-actualizar-{}.ps1", std::process::id()));
    // Con BOM: PowerShell 5.1 lee como ANSI un .ps1 sin él y estropea las tildes.
    std::fs::write(&path, format!("\u{feff}{body}")).map_err(|e| format!("No se pudo preparar la actualización: {e}"))?;
    // Sin DETACHED_PROCESS: PowerShell sin consola se cierra sin hacer nada. Con CREATE_NO_WINDOW
    // tiene consola (oculta) y sigue vivo cuando Prometeo se cierra.
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File"])
        .arg(&path)
        .creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("No se pudo lanzar la actualización: {e}"))?;
    // Sin apunte en Errores: actualizar no es un fallo (cada paso queda en actualizar.log, y si
    // la instalación falla, el script sí lo apunta allí).
    // Un respiro para que la interfaz guarde lo que tenga pendiente.
    std::thread::sleep(std::time::Duration::from_millis(300));
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elige_local_solo_si_existe_la_carpeta_del_codigo() {
        let source = std::env::temp_dir().join(format!("lienzo-update-source-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&source);
        assert_eq!(update_source(&source), UpdateSource::Github);
        std::fs::create_dir_all(&source).unwrap();
        assert_eq!(update_source(&source), UpdateSource::Local);
        std::fs::remove_dir_all(&source).unwrap();
        assert_eq!(update_source(&source), UpdateSource::Github);
    }

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
        std::fs::write(&cur, b"version-1 __TAURI_BUNDLE_TYPE_VAR_NSS").unwrap();

        // Sin instalador compilado.
        assert!(!check_in(&src, &cur).available);
        std::fs::write(src.join("target/release/lienzo.exe"), b"version-1 __TAURI_BUNDLE_TYPE_VAR_UNK").unwrap();
        std::fs::write(nsis.join("Prometeo_1.0.0_x64-setup.exe"), b"setup-1").unwrap();
        // El mismo programa que corre (solo cambia la marca del instalador): nada que hacer.
        let i = check_in(&src, &cur);
        assert!(!i.available, "{}", i.reason);
        // Compilado otro distinto (y otro instalador): hay versión nueva.
        std::thread::sleep(std::time::Duration::from_millis(30));
        std::fs::write(src.join("target/release/lienzo.exe"), b"version-2 __TAURI_BUNDLE_TYPE_VAR_UNK").unwrap();
        std::fs::write(nsis.join("Prometeo_1.0.0_x64-setup.exe"), b"setup-2!").unwrap();
        let i = check_in(&src, &cur);
        assert!(i.available);
        assert!(i.setup.ends_with("-setup.exe"));
        // Corriendo desde la carpeta de compilación (desarrollo): nunca.
        assert!(!check_in(&src, &src.join("target/debug/lienzo.exe")).available);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn cambios_y_version_del_instalador() {
        let c = parse_changes("abc1234\u{1f}1792700000\u{1f}Chats en disco\nmal\n\u{1f}1\u{1f}x\ndef5678\u{1f}1792600000\u{1f}Uno: dos \u{1f} tres");
        assert_eq!(c.len(), 2);
        assert_eq!(c[0], Change { hash: "abc1234".into(), ts_ms: 1_792_700_000_000, subject: "Chats en disco".into() });
        assert_eq!(c[1].subject, "Uno: dos \u{1f} tres");
        assert_eq!(setup_version(r"C:\x\nsis\Prometeo_1.0.104_x64-setup.exe"), "1.0.104");
        assert_eq!(setup_version("raro-setup.exe"), "");
        // Lo que dejó build.rs se lee.
        assert!(!app_about().version.is_empty());
    }

    #[test]
    fn el_script_espera_instala_y_reabre() {
        let s = script(42, r"C:\src\Prometeo_1.0.104_x64-setup.exe", r"C:\Users\x\AppData\Local\Prometeo\lienzo.exe", "1.0.104");
        assert!(s.contains("Wait-Process -Id 42"));
        assert!(s.contains(r"-FilePath 'C:\src\Prometeo_1.0.104_x64-setup.exe' -ArgumentList '/S' -Wait"));
        assert!(s.contains(r"Start-Process -FilePath 'C:\Users\x\AppData\Local\Prometeo\lienzo.exe'"));
        // Cierra lo de Prometeo esté donde esté, comprueba la versión y reintenta.
        assert!(s.contains(r"$_.Path -like '*\Prometeo\*'"));
        assert!(s.contains("$now -eq '1.0.104'"));
        assert!(s.contains("foreach ($n in 1..2)"));
        assert!(s.contains("actualizar.log"));
        assert!(!s.contains(r"\x20"), "sin escapes sueltos");
        assert_eq!(ps_quote("it's"), "'it''s'");
    }
}
