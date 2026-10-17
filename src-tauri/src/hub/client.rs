//! Minimal HTTP client for talking to the hub from companion processes
//! (`lienzo-mcp.exe`, hook scripts). Hand-rolled on purpose: the hub is always
//! localhost + plain HTTP, so no TLS stack is needed.

use serde_json::Value;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

#[derive(Clone)]
pub struct HubClient {
    pub url: String,
    pub token: String,
}

impl HubClient {
    /// Hub from the environment (terminals spawned by lienzo).
    fn from_env() -> Option<HubClient> {
        let (Ok(url), Ok(token)) = (std::env::var("LIENZO_HUB"), std::env::var("LIENZO_TOKEN"))
        else {
            return None;
        };
        if url.trim().is_empty() || token.trim().is_empty() {
            return None;
        }
        Some(HubClient {
            url: url.trim().to_string(),
            token: token.trim().to_string(),
        })
    }

    /// Hub from the discovery file the app rewrites on every launch.
    fn from_file() -> Option<HubClient> {
        let base = std::env::var("APPDATA").ok()?;
        let path = std::path::PathBuf::from(base).join("lienzo").join("hub.json");
        let raw = std::fs::read_to_string(path).ok()?;
        let v: Value = serde_json::from_str(&raw).ok()?;
        Some(HubClient {
            url: v["url"].as_str()?.to_string(),
            token: v["token"].as_str()?.to_string(),
        })
    }

    /// Find the hub: environment first (terminals spawned by lienzo), then the
    /// discovery file written by the app.
    pub fn discover() -> Option<HubClient> {
        Self::from_env().or_else(Self::from_file)
    }

    fn hostport(&self) -> Result<String, String> {
        let rest = self
            .url
            .strip_prefix("http://")
            .ok_or("url del hub inválida")?;
        Ok(rest.trim_end_matches('/').to_string())
    }

    pub fn get(&self, path: &str) -> Result<Value, String> {
        self.request("GET", path, None)
    }

    pub fn post(&self, path: &str, body: &Value) -> Result<Value, String> {
        self.request("POST", path, Some(body))
    }

    /// Request with self-healing: if the call fails, the app may have been
    /// restarted (new port + token), so re-read `hub.json` once and retry
    /// against the fresh hub. Keeps long-lived bridges (agy, hooks) alive
    /// across a lienzo restart.
    fn request(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value, String> {
        match self.request_once(method, path, body) {
            Ok(v) => Ok(v),
            Err(e) => {
                if let Some(fresh) = Self::from_file() {
                    if fresh.url != self.url || fresh.token != self.token {
                        return fresh.request_once(method, path, body);
                    }
                }
                Err(e)
            }
        }
    }

    fn request_once(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value, String> {
        let hostport = self.hostport()?;
        let mut stream = TcpStream::connect(&hostport)
            .map_err(|e| format!("no se pudo conectar al hub de lienzo ({e})"))?;
        stream
            .set_read_timeout(Some(Duration::from_secs(8)))
            .ok();
        stream
            .set_write_timeout(Some(Duration::from_secs(8)))
            .ok();

        let body_str = body.map(|b| b.to_string()).unwrap_or_default();
        let request = format!(
            "{method} {path} HTTP/1.1\r\nHost: {hostport}\r\nX-Lienzo-Token: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            self.token,
            body_str.len(),
            body_str
        );
        stream
            .write_all(request.as_bytes())
            .map_err(|e| e.to_string())?;

        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&raw);
        let (head, payload) = text
            .split_once("\r\n\r\n")
            .ok_or("respuesta inválida del hub")?;

        let status = head.lines().next().unwrap_or("");
        if !status.contains(" 200") {
            // Try to surface the hub's error message.
            let msg = serde_json::from_str::<Value>(payload.trim())
                .ok()
                .and_then(|v| v["error"].as_str().map(|s| s.to_string()))
                .unwrap_or_else(|| status.trim().to_string());
            return Err(format!("el hub respondió: {msg}"));
        }

        let payload = if head.to_ascii_lowercase().contains("chunked") {
            dechunk(payload)?
        } else {
            payload.to_string()
        };
        serde_json::from_str(payload.trim()).map_err(|e| format!("json inválido del hub: {e}"))
    }
}

/// Tiny helper for chunked responses (the hub normally uses Content-Length).
fn dechunk(body: &str) -> Result<String, String> {
    let mut out = String::new();
    let mut rest = body;
    loop {
        let (size_line, tail) = rest.split_once("\r\n").ok_or("chunk inválido")?;
        let size = usize::from_str_radix(size_line.trim(), 16).map_err(|_| "chunk inválido")?;
        if size == 0 {
            break;
        }
        if tail.len() < size + 2 {
            return Err("chunk incompleto".into());
        }
        out.push_str(&tail[..size]);
        rest = &tail[size + 2..];
    }
    Ok(out)
}
