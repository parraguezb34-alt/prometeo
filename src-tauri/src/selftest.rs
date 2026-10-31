//! Comprobaciones manuales de la lista de la víspera. Solo corre al pulsar «Probar todo».
use serde::Serialize;
use std::{path::PathBuf, process::{Command, Output}};
use tauri::AppHandle;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub id: &'static str,
    pub title: &'static str,
    /// `ok`, `warn` o `err`, usados por los tonos verde, amarillo y rojo.
    pub tone: &'static str,
    pub detail: String,
    pub fix: String,
}

fn check(id: &'static str, title: &'static str, tone: &'static str, detail: impl Into<String>, fix: impl Into<String>) -> Check {
    Check { id, title, tone, detail: detail.into(), fix: fix.into() }
}

fn tailscale_exe() -> PathBuf {
    let installed = PathBuf::from(r"C:\Program Files\Tailscale\tailscale.exe");
    if cfg!(windows) && installed.exists() { installed } else { PathBuf::from("tailscale") }
}

fn output(args: &[&str]) -> Result<Output, String> {
    let mut cmd = Command::new(tailscale_exe());
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd.output().map_err(|e| e.to_string())
}

fn tailscale_connected() -> Result<bool, String> {
    let out = output(&["status", "--json"])?;
    if !out.status.success() { return Err("Tailscale no respondió correctamente".into()); }
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    Ok(json.get("BackendState").and_then(|v| v.as_str()) == Some("Running"))
}

fn serve_https_url(text: &str) -> Option<String> {
    let json: serde_json::Value = serde_json::from_str(text).ok()?;
    let web = json.get("Web")?.as_object()?;
    for (host_port, config) in web {
        let serves_prometeo = config.get("Handlers").and_then(|h| h.as_object()).is_some_and(|handlers| {
            handlers.values().any(|handler| handler.get("Proxy").and_then(|p| p.as_str()).is_some_and(|p| {
                p.trim_end_matches('/').ends_with(":47820")
            }))
        });
        if serves_prometeo {
            let host = host_port.strip_suffix(":443").unwrap_or(host_port);
            return Some(format!("https://{host}"));
        }
    }
    None
}

fn ac_timeout_minutes(args: &[&str]) -> Result<u64, String> {
    let out = powercfg(args)?;
    parse_ac_timeout(&String::from_utf8_lossy(&out.stdout))
}

fn parse_ac_timeout(text: &str) -> Result<u64, String> {
    text.lines().find_map(|line| {
        let lower = line.to_ascii_lowercase();
        let english = lower.contains("current ac power setting index");
        let spanish = lower.contains("corriente") && lower.contains("actual")
            || lower.contains("índice") && lower.contains("actual") && lower.contains("ca");
        if !english && !spanish { return None; }
        let (_, raw) = line.split_once(':')?;
        let raw = raw.trim().strip_prefix("0x").or_else(|| raw.trim().strip_prefix("0X"))?;
        u64::from_str_radix(raw, 16).ok()
    }).ok_or_else(|| "Windows no mostró el valor de corriente alterna; revisa powercfg /query".to_string())
}

fn powercfg(args: &[&str]) -> Result<Output, String> {
    let mut cmd = Command::new("powercfg");
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().map_err(|e| e.to_string())?;
    if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
    Ok(out)
}

fn run_checks(app: &AppHandle) -> Vec<Check> {
    let mut checks = Vec::new();
    let connected = match tailscale_connected() {
        Ok(true) => {
            checks.push(check("tailscale", "Tailscale conectado", "ok", "El PC aparece conectado a Tailscale.", ""));
            true
        }
        Ok(false) => {
            checks.push(check("tailscale", "Tailscale conectado", "err", "Tailscale no está conectado.", "Abre Tailscale en Windows e inicia sesión con la cuenta del iPad."));
            false
        }
        Err(e) => {
            checks.push(check("tailscale", "Tailscale conectado", "err", e, "Instala Tailscale y comprueba que está ejecutándose en Windows."));
            false
        }
    };

    if !connected {
        checks.push(check("https", "Enlace HTTPS de Tailscale Serve", "warn", "Comprueba primero que Tailscale esté conectado.", "En el PC ejecuta: tailscale serve --bg 47820"));
    } else {
        match output(&["serve", "status", "--json"]) {
            Ok(out) if out.status.success() => {
                let text = String::from_utf8_lossy(&out.stdout);
                if let Some(url) = serve_https_url(&text) {
                    checks.push(check("https", "Enlace HTTPS de Tailscale Serve", "ok", format!("Activo: {url}"), ""));
                } else {
                    checks.push(check("https", "Enlace HTTPS de Tailscale Serve", "err", "Tailscale Serve no publica el puerto de Prometeo (47820) por HTTPS.", "En el PC ejecuta: tailscale serve --bg 47820; acepta activar HTTPS si lo pide."));
                }
            }
            Ok(out) => checks.push(check("https", "Enlace HTTPS de Tailscale Serve", "err", String::from_utf8_lossy(&out.stderr).trim(), "En el PC ejecuta: tailscale serve --bg 47820.")),
            Err(e) => checks.push(check("https", "Enlace HTTPS de Tailscale Serve", "err", e, "Instala Tailscale y ejecuta: tailscale serve --bg 47820.")),
        }
    }

    match crate::autostart::autostart_status() {
        Ok(true) => checks.push(check("startup", "Prometeo inicia con Windows", "ok", "El inicio automático está activado para esta versión.", "")),
        Ok(false) => checks.push(check("startup", "Prometeo inicia con Windows", "warn", "El inicio automático está apagado.", "En Ajustes → General, activa «Abrir Prometeo al iniciar Windows».")),
        Err(e) => checks.push(check("startup", "Prometeo inicia con Windows", "err", e, "Revisa los permisos de la cuenta de Windows y vuelve a comprobarlo.")),
    }

    if cfg!(windows) {
        let sleep = ac_timeout_minutes(&["/query", "SCHEME_CURRENT", "SUB_SLEEP", "STANDBYIDLE"]);
        let hibernate = ac_timeout_minutes(&["/query", "SCHEME_CURRENT", "SUB_SLEEP", "HIBERNATEIDLE"]);
        match (sleep, hibernate) {
            (Ok(0), Ok(0)) => checks.push(check("power", "Sin suspensión ni hibernación con corriente", "ok", "Suspensión e hibernación están desactivadas con corriente.", "")),
            (Ok(sleep), Ok(hibernate)) => checks.push(check("power", "Sin suspensión ni hibernación con corriente", "err", format!("Suspensión: {sleep} min; hibernación: {hibernate} min."), "En una terminal del PC ejecuta `powercfg /change standby-timeout-ac 0` y `powercfg /change hibernate-timeout-ac 0`.")),
            (Err(e), _) | (_, Err(e)) => checks.push(check("power", "Sin suspensión ni hibernación con corriente", "warn", e, "Comprueba en el PC los valores con `powercfg /query`; corrígelos con los dos comandos de la lista de la víspera.")),
        }
    } else {
        checks.push(check("power", "Sin suspensión ni hibernación con corriente", "warn", "Solo se puede comprobar este ajuste en Windows.", "En el PC Windows, revisa la sección 4 de docs/acceso-remoto.md."));
    }

    let project = crate::hub::with_inner(app, |i| i.project.clone()).flatten();
    let pc = crate::pcstatus::collect(project.as_deref(), None);
    if !pc.warnings.is_empty() {
        checks.push(check("resources", "Disco, RAM y corriente", "warn", pc.warnings.join(" "), "Conecta el PC a la corriente y libera RAM o espacio de disco según el aviso."));
    } else if let (Some(ram), Some(disk), Some(true)) = (pc.ram_free_mb, pc.disk_free_mb, pc.on_ac) {
        checks.push(check("resources", "Disco, RAM y corriente", "ok", format!("RAM libre: {ram} MB · disco libre: {disk} MB; el PC está enchufado."), ""));
    } else {
        let detail = format!(
            "RAM libre: {} · disco libre: {} · corriente: {}.",
            pc.ram_free_mb.map(|v| format!("{v} MB")).unwrap_or_else(|| "sin datos".into()),
            pc.disk_free_mb.map(|v| format!("{v} MB")).unwrap_or_else(|| "sin datos".into()),
            if pc.on_ac == Some(false) { "desconectada" } else { "no confirmada" },
        );
        checks.push(check("resources", "Disco, RAM y corriente", "warn", detail, "Comprueba el botón PC, conecta el PC a la corriente y revisa el espacio disponible en Windows."));
    }
    checks
}

#[tauri::command]
pub async fn selftest_run(app: AppHandle) -> Result<Vec<Check>, String> {
    tauri::async_runtime::spawn_blocking(move || run_checks(&app))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_prometeo_serve_mapping() {
        let text = r#"{"Web":{"pc.tailnet.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:47820"}}}}}"#;
        assert_eq!(serve_https_url(text).as_deref(), Some("https://pc.tailnet.ts.net"));
        assert!(serve_https_url(r#"{"Web":{"pc.tailnet.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}}}"#).is_none());
    }

    #[test]
    fn parses_powercfg_ac_timeout() {
        assert_eq!(parse_ac_timeout("Current AC Power Setting Index: 0x00000000\r\n").unwrap(), 0);
        assert_eq!(parse_ac_timeout("Current AC Power Setting Index: 0x0000003c\r\n").unwrap(), 60);
        assert_eq!(parse_ac_timeout("Índice de configuración de corriente alterna actual: 0X00000000\r\n").unwrap(), 0);
        assert!(parse_ac_timeout("valor desconocido").is_err());
    }
}
