//! Servidor web local para abrir Prometeo desde el iPad por Tailscale.
//!
//! Escucha solo en 127.0.0.1 (para `tailscale serve`) y en la IP 100.x de Tailscale del PC,
//! nunca en 0.0.0.0: la wifi de casa o de la hackatón no llega al puerto. Además se rechaza
//! cualquier petición cuyo origen no sea loopback ni 100.64.0.0/10.
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket},
    path::PathBuf,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Listener, Manager};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};
use web_push_native::p256::elliptic_curve::sec1::ToEncodedPoint;
use web_push_native::{
    Auth, WebPushBuilder, jwt_simple::algorithms::ES256KeyPair, p256::PublicKey,
};

const PORT: u16 = 47820;
const MAX_BODY: usize = 1024 * 1024;
const MAX_UPLOAD_BODY: usize = 40 * 1024 * 1024;
const MAX_LAYOUT: usize = 256 * 1024;
const TOKEN_LEN: usize = 64;
const PUSH_SERVICE_WORKER: &str = r#"
self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let message = {};
    try { message = event.data ? event.data.json() : {}; } catch { message = {}; }
    const kind = ['ask', 'delivery', 'file'].includes(message.kind) ? message.kind : 'equipo';
    await self.registration.showNotification(message.title || 'Prometeo', {
      body: message.body || 'Hay una novedad del equipo.',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: `prometeo-${kind}`,
      data: { url: message.url || '/' }
    });
  })());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) { await client.focus(); return; }
    }
    await self.clients.openWindow(event.notification.data?.url || '/');
  })());
});
"#;

#[derive(Clone, Serialize, Deserialize)]
struct Persisted {
    enabled: bool,
    token: String,
    #[serde(default)]
    layout: Option<String>,
    #[serde(default)]
    push_vapid_private: Option<String>,
    #[serde(default)]
    push_subscriptions: Vec<PushSubscription>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PushSubscription {
    endpoint: String,
    keys: PushKeys,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PushKeys {
    p256dh: String,
    auth: String,
}

struct Remote {
    app: AppHandle,
    path: PathBuf,
    config: Mutex<Persisted>,
    push_visible_at: Mutex<Option<Instant>>,
    stop: Mutex<Option<(std::sync::Arc<AtomicBool>, std::thread::JoinHandle<()>)>>,
}
static REMOTE: OnceLock<Remote> = OnceLock::new();

fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn data_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("remote.json"))
        .map_err(|e| e.to_string())
}

fn save(path: &PathBuf, config: &Persisted) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = serde_json::to_vec(config).map_err(|e| e.to_string())?;
    std::fs::write(path, bytes).map_err(|e| e.to_string())
}

pub fn init(app: AppHandle) {
    let Ok(path) = data_path(&app) else {
        return;
    };
    let persisted = std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Persisted>(&b).ok());
    let config = Persisted {
        enabled: persisted.as_ref().is_some_and(|p| p.enabled),
        token: persisted
            .as_ref()
            .map(|p| p.token.clone())
            .filter(|t| t.len() == TOKEN_LEN)
            .unwrap_or_else(|| new_token().unwrap_or_default()),
        layout: None,
        push_vapid_private: persisted
            .as_ref()
            .and_then(|p| p.push_vapid_private.clone()),
        push_subscriptions: persisted.map(|p| p.push_subscriptions).unwrap_or_default(),
    };
    let enabled = config.enabled;
    if REMOTE
        .set(Remote {
            app: app.clone(),
            path,
            config: Mutex::new(config),
            push_visible_at: Mutex::new(None),
            stop: Mutex::new(None),
        })
        .is_ok()
        && enabled
    {
        let _ = start_server();
    }
}

fn remote() -> Result<&'static Remote, String> {
    REMOTE
        .get()
        .ok_or_else(|| "servidor remoto no inicializado".into())
}

#[derive(Serialize)]
pub struct Status {
    enabled: bool,
    port: u16,
    /// Enlaces para el iPad: el https de `tailscale serve` (si está) y el de la IP 100.x.
    urls: Vec<String>,
    token: String,
    /// IP de Tailscale del PC; `None` = Tailscale no está conectado.
    tailscale: Option<String>,
    /// `https://<pc>.<red>.ts.net` si `tailscale serve` apunta a este puerto.
    https: Option<String>,
}

#[tauri::command]
pub async fn remote_status() -> Result<Status, String> {
    // async: `tailscale serve status` lanza un proceso y no debe frenar la ventana.
    let r = remote()?;
    let (enabled, token) = {
        let c = r.config.lock().map_err(|e| e.to_string())?;
        (c.enabled, c.token.clone())
    };
    let tailscale = tailscale_ipv4();
    let https = if tailscale.is_some() {
        tailscale_serve_url()
    } else {
        None
    };
    let mut urls = Vec::new();
    if let Some(u) = &https {
        urls.push(u.clone());
    }
    if let Some(ip) = tailscale {
        urls.push(format!("http://{ip}:{PORT}"));
    }
    Ok(Status {
        enabled,
        port: PORT,
        urls,
        token,
        tailscale: tailscale.map(|ip| ip.to_string()),
        https,
    })
}

fn push_endpoint_allowed(endpoint: &str) -> bool {
    if endpoint.len() > 4096 || !endpoint.starts_with("https://") {
        return false;
    }
    let authority = endpoint[8..].split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains('@') {
        return false;
    }
    let host = authority.strip_suffix(":443").unwrap_or(authority);
    matches!(
        host.to_ascii_lowercase().as_str(),
        "web.push.apple.com" | "fcm.googleapis.com" | "updates.push.services.mozilla.com"
    )
}

fn load_vapid_key(r: &Remote) -> Result<ES256KeyPair, String> {
    let mut config = r.config.lock().map_err(|e| e.to_string())?;
    if config.push_vapid_private.is_none() {
        let pair = ES256KeyPair::generate();
        config.push_vapid_private = Some(URL_SAFE_NO_PAD.encode(pair.to_bytes()));
        save(&r.path, &config)?;
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(config.push_vapid_private.as_deref().unwrap_or_default())
        .map_err(|e| format!("clave VAPID inválida: {e}"))?;
    ES256KeyPair::from_bytes(&bytes).map_err(|e| format!("clave VAPID inválida: {e}"))
}

#[tauri::command]
pub fn remote_push_vapid_key() -> Result<String, String> {
    let key = load_vapid_key(remote()?)?;
    let public =
        PublicKey::from_sec1_bytes(&key.public_key().to_bytes()).map_err(|e| e.to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(public.to_encoded_point(false).as_bytes()))
}

#[tauri::command]
pub fn remote_push_subscribe(subscription: PushSubscription) -> Result<(), String> {
    if !push_endpoint_allowed(&subscription.endpoint) {
        return Err("El proveedor de avisos debe ser un endpoint HTTPS compatible.".into());
    }
    if subscription.keys.p256dh.len() > 128 || subscription.keys.auth.len() > 64 {
        return Err("Las claves de la suscripción no son válidas.".into());
    }
    let p256dh = URL_SAFE_NO_PAD
        .decode(&subscription.keys.p256dh)
        .map_err(|_| "La clave pública de la suscripción no es válida.")?;
    PublicKey::from_sec1_bytes(&p256dh)
        .map_err(|_| "La clave pública de la suscripción no es válida.")?;
    let auth = URL_SAFE_NO_PAD
        .decode(&subscription.keys.auth)
        .map_err(|_| "La clave de autenticación de la suscripción no es válida.")?;
    if auth.len() != 16 {
        return Err("La clave de autenticación de la suscripción no es válida.".into());
    }

    let r = remote()?;
    let mut config = r.config.lock().map_err(|e| e.to_string())?;
    if let Some(existing) = config
        .push_subscriptions
        .iter_mut()
        .find(|s| s.endpoint == subscription.endpoint)
    {
        *existing = subscription;
    } else {
        if config.push_subscriptions.len() >= 8 {
            return Err("Ya hay demasiados iPad suscritos a los avisos.".into());
        }
        config.push_subscriptions.push(subscription);
    }
    save(&r.path, &config)
}

#[tauri::command]
pub fn remote_push_unsubscribe(endpoint: String) -> Result<(), String> {
    let r = remote()?;
    let mut config = r.config.lock().map_err(|e| e.to_string())?;
    config.push_subscriptions.retain(|s| s.endpoint != endpoint);
    save(&r.path, &config)
}

fn push_copy(kind: &str, agent: &str) -> Option<(String, String)> {
    let who = match agent.to_ascii_lowercase().as_str() {
        "claude" => "Claude",
        "codex" => "Codex",
        "opencode" => "OpenCode",
        "antigravity" => "Antigravity",
        _ => "Un agente",
    };
    match kind {
        "ask" => Some((
            format!("{who} necesita tu respuesta"),
            "Abre Prometeo para revisar la solicitud.".into(),
        )),
        "delivery" => Some((
            format!("Nueva entrega de {who}"),
            "Hay una tarea lista para revisar en Prometeo.".into(),
        )),
        "file" => Some((
            format!("{who} compartió un archivo"),
            "Abre Prometeo para consultar el archivo.".into(),
        )),
        _ => None,
    }
}

#[tauri::command]
pub fn remote_push_send(kind: String, agent: Option<String>) -> Result<(), String> {
    let Some((title, body)) = push_copy(&kind, agent.as_deref().unwrap_or_default()) else {
        return Ok(());
    };
    let r = remote()?;
    if remote_push_is_visible(r) {
        return Ok(());
    }
    let (private, subscriptions) = {
        let config = r.config.lock().map_err(|e| e.to_string())?;
        if !config.enabled {
            return Ok(());
        }
        let Some(private) = config.push_vapid_private.clone() else {
            return Ok(());
        };
        (private, config.push_subscriptions.clone())
    };
    if subscriptions.is_empty() {
        return Ok(());
    }
    let payload = serde_json::to_vec(&serde_json::json!({
        "title": title,
        "body": body,
        "kind": kind,
        "url": "/"
    }))
    .map_err(|e| e.to_string())?;
    std::thread::spawn(move || send_pushes(private, subscriptions, payload));
    Ok(())
}

fn remote_push_visibility_recent(last_visible: Option<Instant>, now: Instant) -> bool {
    last_visible.is_some_and(|last| now.saturating_duration_since(last) <= Duration::from_secs(30))
}

fn remote_push_is_visible(r: &Remote) -> bool {
    r.push_visible_at
        .lock()
        .map(|last| remote_push_visibility_recent(*last, Instant::now()))
        .unwrap_or(false)
}

#[tauri::command]
pub fn remote_push_visibility(visible: bool) -> Result<(), String> {
    let r = remote()?;
    let mut last = r.push_visible_at.lock().map_err(|e| e.to_string())?;
    *last = visible.then(Instant::now);
    Ok(())
}

fn send_pushes(private: String, subscriptions: Vec<PushSubscription>, payload: Vec<u8>) {
    let Ok(private_bytes) = URL_SAFE_NO_PAD.decode(private) else {
        return;
    };
    let Ok(key_pair) = ES256KeyPair::from_bytes(&private_bytes) else {
        return;
    };
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(5)))
        .https_only(true)
        .max_redirects(0)
        .build();
    let agent: ureq::Agent = config.into();
    let mut expired = Vec::new();
    for subscription in subscriptions {
        match send_push(&agent, &key_pair, &subscription, &payload) {
            Err(Some(404 | 410)) => expired.push(subscription.endpoint),
            _ => {}
        }
    }
    if !expired.is_empty()
        && let Some(remote) = REMOTE.get()
        && let Ok(mut config) = remote.config.lock()
    {
        config
            .push_subscriptions
            .retain(|s| !expired.contains(&s.endpoint));
        let _ = save(&remote.path, &config);
    }
}

fn send_push(
    agent: &ureq::Agent,
    key_pair: &ES256KeyPair,
    subscription: &PushSubscription,
    payload: &[u8],
) -> Result<(), Option<u16>> {
    if !push_endpoint_allowed(&subscription.endpoint) {
        return Err(None);
    }
    let public = URL_SAFE_NO_PAD
        .decode(&subscription.keys.p256dh)
        .map_err(|_| None)?;
    let public = PublicKey::from_sec1_bytes(&public).map_err(|_| None)?;
    let auth = URL_SAFE_NO_PAD
        .decode(&subscription.keys.auth)
        .map_err(|_| None)?;
    if auth.len() != 16 {
        return Err(None);
    }
    let auth = Auth::clone_from_slice(&auth);
    let request = WebPushBuilder::new(
        subscription.endpoint.parse().map_err(|_| None)?,
        public,
        auth,
    )
    .with_vapid(key_pair, "mailto:prometeo@localhost")
    .build(payload.to_vec())
    .map_err(|_| None)?;
    let (parts, body) = request.into_parts();
    let mut builder = ureq::http::Request::builder()
        .method(parts.method)
        .uri(parts.uri);
    for name in parts.headers.keys() {
        for value in parts.headers.get_all(name).iter() {
            builder = builder.header(name, value);
        }
    }
    let request = builder.body(body).map_err(|_| None)?;
    agent.run(request).map(|_| ()).map_err(|e| match e {
        ureq::Error::StatusCode(code) => Some(code),
        _ => None,
    })
}

fn route_ipv4(target: &str) -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect(target).ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) => Some(ip),
        IpAddr::V6(_) => None,
    }
}

/// 100.64.0.0/10: el rango de Tailscale (CGNAT).
fn is_tailscale_ipv4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 100 && (64..=127).contains(&o[1])
}

/// La IP 100.x del PC: la que el sistema usaría para llegar al DNS de Tailscale. Sin Tailscale
/// la ruta sale por la puerta de enlace normal y la IP no es del rango.
fn tailscale_ipv4() -> Option<Ipv4Addr> {
    route_ipv4("100.100.100.100:53").filter(|ip| is_tailscale_ipv4(*ip))
}

/// Solo el propio PC (loopback, por donde entra `tailscale serve`) y la red de Tailscale.
fn allowed_peer(addr: Option<&SocketAddr>) -> bool {
    match addr.map(|a| a.ip()) {
        Some(IpAddr::V4(ip)) => ip.is_loopback() || is_tailscale_ipv4(ip),
        Some(IpAddr::V6(ip)) => {
            ip.is_loopback()
                || ip
                    .to_ipv4_mapped()
                    .is_some_and(|v4| v4.is_loopback() || is_tailscale_ipv4(v4))
        }
        None => false,
    }
}

fn tailscale_exe() -> PathBuf {
    let installed = PathBuf::from(r"C:\Program Files\Tailscale\tailscale.exe");
    if installed.exists() {
        installed
    } else {
        PathBuf::from("tailscale")
    }
}

/// Si `tailscale serve` publica este puerto, su dirección https (MagicDNS, con certificado).
fn tailscale_serve_url() -> Option<String> {
    let mut cmd = std::process::Command::new(tailscale_exe());
    cmd.args(["serve", "status", "--json"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // sin ventana de consola
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    serve_url_from_json(&String::from_utf8_lossy(&out.stdout))
}

fn serve_url_from_json(text: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let web = v.get("Web")?.as_object()?;
    let needle = format!(":{PORT}");
    for (host_port, cfg) in web {
        let ours = cfg
            .get("Handlers")
            .and_then(|h| h.as_object())
            .is_some_and(|h| {
                h.values().any(|x| {
                    x.get("Proxy")
                        .and_then(|p| p.as_str())
                        .is_some_and(|p| p.trim_end_matches('/').ends_with(&needle))
                })
            });
        if ours {
            let host = host_port.strip_suffix(":443").unwrap_or(host_port);
            return Some(format!("https://{host}"));
        }
    }
    None
}

#[tauri::command]
pub fn remote_set(enabled: bool) -> Result<(), String> {
    let r = remote()?;
    if enabled {
        start_server()?;
    }
    let mut c = r.config.lock().map_err(|e| e.to_string())?;
    let old = c.enabled;
    c.enabled = enabled;
    if let Err(e) = save(&r.path, &c) {
        c.enabled = old;
        drop(c);
        if enabled {
            stop_server();
        }
        return Err(e);
    }
    drop(c);
    if !enabled {
        stop_server();
    }
    Ok(())
}

#[tauri::command]
pub fn remote_rotate_token() -> Result<String, String> {
    let r = remote()?;
    let token = new_token()?;
    let mut c = r.config.lock().map_err(|e| e.to_string())?;
    let old = std::mem::replace(&mut c.token, token.clone());
    if let Err(e) = save(&r.path, &c) {
        c.token = old;
        return Err(e);
    }
    Ok(token)
}

#[tauri::command]
pub fn remote_layout_set(json: String) -> Result<(), String> {
    if json.len() > MAX_LAYOUT {
        return Err("la disposición supera 256 KB".into());
    }
    let _: serde_json::Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let r = remote()?;
    r.config.lock().map_err(|e| e.to_string())?.layout = Some(json);
    Ok(())
}

#[tauri::command]
pub fn remote_layout_get() -> Option<String> {
    remote().ok()?.config.lock().ok()?.layout.clone()
}

fn start_server() -> Result<(), String> {
    let r = remote()?;
    let mut state = r.stop.lock().map_err(|e| e.to_string())?;
    if state.is_some() {
        return Ok(());
    }
    // Loopback siempre (y aquí, para que un puerto ocupado se vea como error al encender).
    let local = Server::http((Ipv4Addr::LOCALHOST, PORT)).map_err(|e| e.to_string())?;
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    let app = r.app.clone();
    let join = std::thread::Builder::new()
        .name("prometeo-remote".into())
        .spawn(move || supervise(app, local, thread_stop))
        .map_err(|e| e.to_string())?;
    *state = Some((stop, join));
    Ok(())
}

/// Atiende loopback y vigila la IP de Tailscale: si aparece (Tailscale arrancó después que
/// Prometeo) o cambia, se enlaza a ella sin reiniciar nada; si desaparece, deja de escuchar.
fn supervise(app: AppHandle, local: Server, stop: Arc<AtomicBool>) {
    let local_join = listen_on(app.clone(), local, stop.clone());
    let mut ts: Option<(Ipv4Addr, Arc<AtomicBool>, JoinHandle<()>)> = None;
    let mut next_check = Instant::now();
    while !stop.load(Ordering::Relaxed) {
        if Instant::now() >= next_check {
            next_check = Instant::now() + Duration::from_secs(5);
            let ip = tailscale_ipv4();
            if ip != ts.as_ref().map(|t| t.0) {
                if let Some((_, s, j)) = ts.take() {
                    s.store(true, Ordering::Relaxed);
                    let _ = j.join();
                }
                // Si el enlace falla (la interfaz aún no está lista) se reintenta en 5 s.
                if let Some(ip) = ip
                    && let Ok(server) = Server::http((ip, PORT))
                {
                    let s = Arc::new(AtomicBool::new(false));
                    let j = listen_on(app.clone(), server, s.clone());
                    ts = Some((ip, s, j));
                }
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    if let Some((_, s, j)) = ts.take() {
        s.store(true, Ordering::Relaxed);
        let _ = j.join();
    }
    let _ = local_join.join();
}

fn listen_on(app: AppHandle, server: Server, stop: Arc<AtomicBool>) -> JoinHandle<()> {
    std::thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_millis(250)) {
                let app = app.clone();
                let _ = std::thread::Builder::new()
                    .name("prometeo-remote-request".into())
                    .spawn(move || handle(app, req));
            }
        }
    })
}

fn stop_server() {
    if let Some(r) = REMOTE.get()
        && let Ok(mut s) = r.stop.lock()
        && let Some((stop, join)) = s.take()
    {
        stop.store(true, Ordering::Relaxed);
        let _ = join.join();
    }
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name, value).expect("valid HTTP header")
}
fn json(status: u16, value: serde_json::Value) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_data(value.to_string().into_bytes())
        .with_status_code(StatusCode(status))
        .with_header(header("Content-Type", "application/json; charset=utf-8"))
}

fn query_token(url: &str) -> Option<String> {
    url.split_once('?')?.1.split('&').find_map(|p| {
        let (k, v) = p.split_once('=')?;
        (k == "t").then(|| percent_decode(v))
    })
}
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16)
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
fn valid_token(a: &str, b: &str) -> bool {
    let aa = a.as_bytes();
    let bb = b.as_bytes();
    let mut diff = (aa.len() ^ TOKEN_LEN) | (bb.len() ^ TOKEN_LEN);
    for i in 0..TOKEN_LEN {
        diff |= usize::from(aa.get(i).copied().unwrap_or(0) ^ bb.get(i).copied().unwrap_or(0));
    }
    diff == 0
}
fn auth_status(
    method: &Method,
    path: &str,
    bearer: Option<&str>,
    query: Option<&str>,
    expected: &str,
) -> u16 {
    let exempt = *method == Method::Get
        && !path.starts_with("/rpc/")
        && path != "/events"
        && path != "/files";
    if exempt
        || bearer.is_some_and(|v| valid_token(v, expected))
        || query.is_some_and(|v| valid_token(v, expected))
    {
        200
    } else {
        401
    }
}
fn authorized(req: &Request, token: &str) -> bool {
    let bearer = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("Authorization"))
        .map(|h| h.value.as_str())
        .and_then(|v| v.strip_prefix("Bearer "));
    auth_status(
        req.method(),
        req.url().split('?').next().unwrap_or("/"),
        bearer,
        query_token(req.url()).as_deref(),
        token,
    ) == 200
}

fn handle(app: AppHandle, req: Request) {
    if !allowed_peer(req.remote_addr()) {
        let _ = req.respond(json(403, serde_json::json!({"error":"solo por Tailscale"})));
        return;
    }
    let url = req.url().to_string();
    let path = url.split('?').next().unwrap_or("/");
    let method = req.method().clone();
    let token = REMOTE
        .get()
        .and_then(|r| r.config.lock().ok().map(|c| c.token.clone()))
        .unwrap_or_default();
    let is_static = method == Method::Get
        && !path.starts_with("/rpc/")
        && path != "/events"
        && path != "/files";
    if !is_static && !authorized(&req, &token) {
        let _ = req.respond(json(401, serde_json::json!({"error":"token inválido"})));
        return;
    }
    if method == Method::Get && path == "/events" {
        serve_events(app, req);
        return;
    }
    if method == Method::Get && path == "/files" {
        crate::remote_files::serve(&app, &url, req);
        return;
    }
    if method == Method::Post && path.starts_with("/rpc/") {
        serve_rpc(&app, &path[5..], req);
        return;
    }
    if method == Method::Get {
        serve_static(&app, path, req);
        return;
    }
    let _ = req.respond(json(404, serde_json::json!({"error":"no encontrado"})));
}

fn serve_static(app: &AppHandle, path: &str, req: Request) {
    if path == "/sw.js" {
        let response = Response::from_data(PUSH_SERVICE_WORKER.as_bytes().to_vec())
            .with_header(header(
                "Content-Type",
                "application/javascript; charset=utf-8",
            ))
            .with_header(header("Cache-Control", "no-cache"))
            .with_header(header("Service-Worker-Allowed", "/"));
        let _ = req.respond(response);
        return;
    }
    let clean = path.trim_start_matches('/');
    let asset_path = if clean.is_empty() || !clean.rsplit('/').next().unwrap_or("").contains('.') {
        "index.html"
    } else {
        clean
    };
    let asset = app
        .asset_resolver()
        .get(asset_path.to_string())
        .or_else(|| {
            if asset_path == "index.html"
                || !asset_path.rsplit('/').next().unwrap_or("").contains('.')
            {
                app.asset_resolver().get("index.html".into())
            } else {
                None
            }
        });
    match asset {
        Some(asset) => {
            let cache = cache_policy(path, asset_path);
            let mime = static_mime(asset_path, &asset.mime_type);
            let response = Response::from_data(asset.bytes)
                .with_header(header("Content-Type", mime))
                .with_header(header("Cache-Control", cache));
            let _ = req.respond(response);
        }
        None => {
            let _ = req.respond(json(
                404,
                serde_json::json!({"error":"asset no encontrado"}),
            ));
        }
    }
}

/// El resolvedor de Tauri no conoce `.webmanifest` (lo da como text/html) y Safari lo ignoraría.
fn static_mime<'a>(asset_path: &str, guessed: &'a str) -> &'a str {
    if asset_path.ends_with(".webmanifest") {
        "application/manifest+json"
    } else {
        guessed
    }
}

fn cache_policy(path: &str, asset_path: &str) -> &'static str {
    if asset_path == "index.html" {
        "no-store"
    } else if path.starts_with("/assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    }
}

fn serve_events(app: AppHandle, req: Request) {
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let mut ids = Vec::new();
    for name in [
        "pty://data",
        "pty://exit",
        "team://update",
        "remote://action-result",
    ] {
        let tx = tx.clone();
        let event_name = name.to_string();
        ids.push(app.listen_any(name, move |event| {
            let payload = event.payload();
            let frame = format!("event: {event_name}\ndata: {payload}\n\n");
            let _ = tx.send(frame.into_bytes());
        }));
    }
    drop(tx);
    let _listeners = EventListeners { app, ids };
    let writer = req.into_writer();
    let _ = write_sse_stream(writer, rx);
}

struct EventListeners {
    app: AppHandle,
    ids: Vec<tauri::EventId>,
}
impl Drop for EventListeners {
    fn drop(&mut self) {
        for id in self.ids.drain(..) {
            self.app.unlisten(id);
        }
    }
}

fn write_sse_stream(mut writer: impl Write, rx: mpsc::Receiver<Vec<u8>>) -> std::io::Result<()> {
    writer.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n")?;
    writer.flush()?;
    loop {
        let frame = match rx.recv_timeout(Duration::from_secs(15)) {
            Ok(frame) => frame,
            // Latido visible para el navegador (un comentario «: ping» no le llega a JS): el iPad
            // lo usa para notar una conexión muerta que Safari no cierra.
            Err(mpsc::RecvTimeoutError::Timeout) => b"event: ping\ndata: 1\n\n".to_vec(),
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
        };
        writer.write_all(&frame)?;
        writer.flush()?;
    }
}

fn arg<T: serde::de::DeserializeOwned>(args: &serde_json::Value, name: &str) -> Result<T, String> {
    let value = args.get(name).cloned().unwrap_or(serde_json::Value::Null);
    serde_json::from_value(value).map_err(|e| format!("argumento {name}: {e}"))
}
fn out<T: Serialize>(result: Result<T, String>) -> Result<serde_json::Value, String> {
    result.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}
macro_rules! a {
    ($args:expr,$name:literal,$ty:ty) => {
        arg::<$ty>($args, $name)?
    };
}
macro_rules! sync {
    ($e:expr) => {
        out($e)
    };
}
macro_rules! async_call {
    ($e:expr) => {
        out(tauri::async_runtime::block_on($e))
    };
}

fn dispatch_rpc_command_allowed(command: &str) -> bool {
    matches!(
        command,
        "term_spawn"
            | "term_write"
            | "term_resize"
            | "term_kill"
            | "term_list"
            | "term_scrollback"
            | "team_state"
            | "team_details"
            | "team_project_set"
            | "team_add_task"
            | "team_task_op"
            | "team_task_comment"
            | "team_memory_add"
            | "team_memory_resolve"
            | "team_memory_forget"
            | "team_dm"
            | "team_answer"
            | "team_limits_set"
            | "team_leader"
            | "team_usage_reset"
            | "team_director"
            | "team_plan"
            | "team_isolate"
            | "team_schedule_op"
            | "team_schedule_fire"
            | "team_schedule_save"
            | "team_schedule_link"
            | "team_strengths"
            | "team_broadcast"
            | "team_broadcast_ack"
            | "team_charter"
            | "team_events_range"
            | "team_detect"
            | "team_connect"
            | "team_open"
            | "team_models"
            | "opencode_compact"
            | "team_agent_session"
            | "project_info"
            | "project_status"
            | "project_list"
            | "project_read"
            | "project_recent"
            | "project_diff_paths"
            | "project_commit_paths"
            | "project_revert_paths"
            | "project_save_image"
            | "project_save_attachment"
            | "project_attach_path"
            | "project_create_dir"
            | "image_data"
            | "chats_read"
            | "chats_write"
            | "file_blob"
            | "file_text"
            | "export_save"
            | "history_list"
            | "history_diff"
            | "history_revert"
            | "history_save"
            | "app_detect"
            | "app_start"
            | "app_stop"
            | "app_status"
            | "research_start"
            | "research_list"
            | "research_read"
            | "research_remove"
            | "skills_list"
            | "skills_read"
            | "errors_list"
            | "app_about"
            | "opencode_go_usage"
            | "remote_layout_get"
            | "remote_push_vapid_key"
            | "remote_push_subscribe"
            | "remote_push_unsubscribe"
            | "remote_push_visibility"
            | "remote_action"
            | "pc_status"
    )
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum RemoteAction {
    LaunchSquad,
    OpenAgent { agent: String },
    CloseAgent { agent: String },
    RestartAgent { agent: String },
    SwitchProject { path: String },
}

#[derive(Debug, Clone, serde::Serialize)]
struct RemoteActionRequest {
    id: String,
    action: RemoteAction,
}

fn valid_remote_request_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn valid_remote_action(action: RemoteAction) -> Result<RemoteAction, String> {
    match &action {
        RemoteAction::LaunchSquad => {}
        RemoteAction::OpenAgent { agent }
        | RemoteAction::CloseAgent { agent }
        | RemoteAction::RestartAgent { agent } => {
            if agent.trim().is_empty() || agent.len() > 80 || agent.chars().any(char::is_control) {
                return Err("agente no válido".into());
            }
        }
        RemoteAction::SwitchProject { path } => {
            if path.trim().is_empty() || path.len() > 4096 || path.chars().any(char::is_control) {
                return Err("proyecto no válido".into());
            }
        }
    }
    Ok(action)
}

fn remote_action(app: &AppHandle, args: &serde_json::Value) -> Result<serde_json::Value, String> {
    let id = a!(args, "request_id", String);
    if !valid_remote_request_id(&id) {
        return Err("identificador de acción no válido".into());
    }
    let action = valid_remote_action(arg::<RemoteAction>(args, "action")?)?;
    if let RemoteAction::OpenAgent { agent }
    | RemoteAction::CloseAgent { agent }
    | RemoteAction::RestartAgent { agent } = &action
    {
        let detected =
            tauri::async_runtime::block_on(crate::hub::connectors::team_detect(app.clone()))?;
        let available = detected
            .get("agents")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|agents| {
                agents.iter().any(|item| {
                    item.get("id").and_then(serde_json::Value::as_str) == Some(agent.as_str())
                        && (item.get("cli_found").and_then(serde_json::Value::as_bool)
                            == Some(true)
                            || item
                                .get("config_dir_found")
                                .and_then(serde_json::Value::as_bool)
                                == Some(true))
                })
            });
        if !available {
            return Err("ese agente no está instalado en el PC".into());
        }
    }
    app.emit_to(
        "main",
        "remote://action",
        &RemoteActionRequest { id, action },
    )
    .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "accepted": true }))
}

/// Estado del PC para el panel del iPad (solo lectura).
fn pc_status(app: &AppHandle) -> crate::pcstatus::PcStatus {
    let project = crate::hub::with_inner(app, |i| i.project.clone()).flatten();
    crate::pcstatus::collect(
        project.as_deref(),
        tailscale_ipv4().map(|ip| ip.to_string()),
    )
}

fn dispatch_rpc(
    app: &AppHandle,
    command: &str,
    args: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    use crate::{
        chatstore, devapp, errlog, history, hub, limits, project, pty, research, skills, updater,
        viewer,
    };
    if !dispatch_rpc_command_allowed(command) {
        return Err(format!("comando no permitido: {command}"));
    }
    match command {
        "term_spawn" => async_call!(pty::term_spawn(
            app.clone(),
            app.state::<pty::PtyManager>(),
            a!(args, "cwd", Option<String>),
            a!(args, "cols", u16),
            a!(args, "rows", u16),
            a!(args, "command", Option<String>)
        )),
        "term_write" => sync!(pty::term_write(
            app.state::<pty::PtyManager>(),
            a!(args, "id", String),
            a!(args, "data", String)
        )),
        "term_resize" => sync!(pty::term_resize(
            app.state::<pty::PtyManager>(),
            a!(args, "id", String),
            a!(args, "cols", u16),
            a!(args, "rows", u16)
        )),
        "term_kill" => async_call!(pty::term_kill(
            app.state::<pty::PtyManager>(),
            a!(args, "id", String)
        )),
        "term_list" => async_call!(pty::term_list(app.state::<pty::PtyManager>())),
        "term_scrollback" => async_call!(pty::term_scrollback(
            app.state::<pty::PtyManager>(),
            a!(args, "id", String),
            a!(args, "max", Option<usize>)
        )),
        "team_state" => sync!(hub::team_state(app.state::<hub::Hub>())),
        "team_details" => sync!(hub::team_details(app.state::<hub::Hub>())),
        "team_project_set" => sync!(hub::team_project_set(
            app.state::<hub::Hub>(),
            a!(args, "path", Option<String>)
        )),
        "team_add_task" => sync!(hub::team_add_task(
            app.state::<hub::Hub>(),
            a!(args, "title", String),
            a!(args, "parents", Option<Vec<u64>>)
        )),
        "team_task_op" => sync!(hub::team_task_op(
            app.state::<hub::Hub>(),
            a!(args, "id", u64),
            a!(args, "op", String)
        )),
        "team_task_comment" => sync!(hub::team_task_comment(
            app.state::<hub::Hub>(),
            a!(args, "id", u64),
            a!(args, "text", String)
        )),
        "team_memory_add" => sync!(hub::team_memory_add(
            app.state::<hub::Hub>(),
            a!(args, "text", String),
            a!(args, "kind", Option<String>)
        )),
        "team_memory_resolve" => sync!(hub::team_memory_resolve(
            app.state::<hub::Hub>(),
            a!(args, "id", u64),
            a!(args, "accept", bool),
            a!(args, "text", Option<String>)
        )),
        "team_memory_forget" => sync!(hub::team_memory_forget(
            app.state::<hub::Hub>(),
            a!(args, "id", u64)
        )),
        "team_dm" => sync!(hub::team_dm(
            app.state::<hub::Hub>(),
            a!(args, "agent", String),
            a!(args, "text", String)
        )),
        "team_answer" => sync!(hub::team_answer(
            app.state::<hub::Hub>(),
            a!(args, "id", u64),
            a!(args, "answers", Option<Vec<hub::QAnswer>>)
        )),
        "team_limits_set" => sync!(hub::team_limits_set(
            app.state::<hub::Hub>(),
            a!(args, "agent", String),
            a!(args, "windows", serde_json::Value),
            a!(args, "exact", bool),
            a!(args, "note", Option<String>)
        )),
        "team_leader" => sync!(hub::team_leader(
            app.state::<hub::Hub>(),
            a!(args, "leader", Option<String>)
        )),
        "team_usage_reset" => sync!(hub::team_usage_reset(app.state::<hub::Hub>())),
        "team_director" => sync!(hub::team_director(
            app.state::<hub::Hub>(),
            a!(args, "enabled", bool),
            a!(args, "fixLimit", Option<u32>)
        )),
        "team_plan" => sync!(hub::team_plan(
            app.state::<hub::Hub>(),
            a!(args, "op", String)
        )),
        "team_isolate" => sync!(hub::team_isolate(
            app.state::<hub::Hub>(),
            a!(args, "enabled", bool)
        )),
        "team_schedule_op" => sync!(hub::team_schedule_op(
            app.state::<hub::Hub>(),
            a!(args, "id", u64),
            a!(args, "op", String)
        )),
        "team_schedule_fire" => sync!(hub::team_schedule_fire(
            app.state::<hub::Hub>(),
            a!(args, "id", u64),
            a!(args, "day", String),
            a!(args, "skip", Option<String>),
            a!(args, "manual", Option<bool>)
        )),
        "team_schedule_save" => sync!(hub::team_schedule_save(
            app.state::<hub::Hub>(),
            a!(args, "id", Option<u64>),
            a!(args, "draft", hub::schedule::Draft)
        )),
        "team_schedule_link" => sync!(hub::team_schedule_link(
            app.state::<hub::Hub>(),
            a!(args, "id", u64),
            a!(args, "chat", String),
            a!(args, "title", String)
        )),
        "team_strengths" => sync!(hub::team_strengths(
            app.state::<hub::Hub>(),
            a!(args, "agent", String),
            a!(args, "text", String)
        )),
        "team_broadcast" => sync!(hub::team_broadcast(
            app.state::<hub::Hub>(),
            a!(args, "text", String)
        )),
        "team_broadcast_ack" => sync!(hub::team_broadcast_ack(
            app.state::<hub::Hub>(),
            a!(args, "agents", Vec<String>)
        )),
        "team_charter" => sync!(hub::team_charter(
            app.state::<hub::Hub>(),
            a!(args, "charter", Option<String>),
            a!(args, "leader", Option<String>)
        )),
        "team_events_range" => async_call!(hub::team_events_range(
            app.state::<hub::Hub>(),
            a!(args, "fromMs", u64),
            a!(args, "toMs", Option<u64>)
        )),
        "team_detect" => async_call!(hub::connectors::team_detect(app.clone())),
        "team_connect" => async_call!(hub::connectors::team_connect(
            app.clone(),
            a!(args, "agent", String),
            a!(args, "project", Option<String>)
        )),
        "team_open" => async_call!(hub::connectors::team_open(
            app.clone(),
            a!(args, "agent", String),
            a!(args, "mode", Option<String>),
            a!(args, "model", Option<String>),
            a!(args, "effort", Option<String>),
            a!(args, "resume", Option<bool>)
        )),
        "team_models" => async_call!(hub::connectors::team_models(a!(args, "agent", String))),
        "opencode_compact" => async_call!(hub::connectors::opencode_compact(a!(
            args, "project", String
        ))),
        "team_agent_session" => {
            let v = tauri::async_runtime::block_on(hub::connectors::team_agent_session(
                a!(args, "agent", String),
                a!(args, "project", String),
            ));
            serde_json::to_value(v).map_err(|e| e.to_string())
        }
        "project_info" => async_call!(project::project_info(a!(args, "path", String))),
        "project_status" => async_call!(project::project_status(a!(args, "path", String))),
        "project_list" => async_call!(project::project_list(
            a!(args, "path", String),
            a!(args, "rel", String)
        )),
        "project_read" => async_call!(project::project_read(
            a!(args, "path", String),
            a!(args, "rel", String)
        )),
        "project_recent" => async_call!(project::project_recent(
            a!(args, "path", String),
            a!(args, "exts", Vec<String>),
            a!(args, "limit", Option<usize>)
        )),
        "project_diff_paths" => async_call!(project::project_diff_paths(
            a!(args, "path", String),
            a!(args, "paths", Vec<String>)
        )),
        "project_commit_paths" => async_call!(project::project_commit_paths(
            a!(args, "path", String),
            a!(args, "paths", Vec<String>),
            a!(args, "message", String)
        )),
        "project_revert_paths" => async_call!(project::project_revert_paths(
            a!(args, "path", String),
            a!(args, "paths", Vec<String>)
        )),
        "project_save_image" => async_call!(project::project_save_image(
            a!(args, "path", String),
            a!(args, "data", String),
            a!(args, "ext", Option<String>)
        )),
        "project_save_attachment" => async_call!(project::project_save_attachment(
            a!(args, "path", String),
            a!(args, "name", String),
            a!(args, "data", String)
        )),
        "project_attach_path" => async_call!(project::project_attach_path(
            a!(args, "path", String),
            a!(args, "src", String)
        )),
        "project_create_dir" => async_call!(project::project_create_dir(
            a!(args, "parent", String),
            a!(args, "name", String)
        )),
        "image_data" => async_call!(project::image_data(
            a!(args, "path", String),
            a!(args, "project", Option<String>)
        )),
        "chats_read" => sync!(Ok::<_, String>(chatstore::chats_read(a!(
            args, "project", String
        )))),
        "chats_write" => sync!(chatstore::chats_write(
            a!(args, "project", String),
            a!(args, "chats", serde_json::Value)
        )),
        "file_blob" => async_call!(viewer::file_blob(
            a!(args, "project", Option<String>),
            a!(args, "rel", String)
        )),
        "file_text" => async_call!(viewer::file_text(
            a!(args, "project", Option<String>),
            a!(args, "rel", String)
        )),
        "export_save" => async_call!(viewer::export_save(
            a!(args, "path", String),
            a!(args, "text", String)
        )),
        "history_list" => async_call!(history::history_list(a!(args, "path", String))),
        "history_diff" => async_call!(history::history_diff(
            a!(args, "path", String),
            a!(args, "id", String)
        )),
        "history_revert" => async_call!(history::history_revert(
            a!(args, "path", String),
            a!(args, "id", String),
            a!(args, "redo", bool),
            a!(args, "force", bool)
        )),
        "history_save" => async_call!(history::history_save(
            a!(args, "path", String),
            a!(args, "title", String)
        )),
        "app_detect" => async_call!(devapp::app_detect(a!(args, "path", String))),
        "app_start" => async_call!(devapp::app_start(a!(args, "path", String))),
        "app_stop" => async_call!(devapp::app_stop()),
        "app_status" => async_call!(devapp::app_status()),
        "research_start" => sync!(research::research_start(
            app.state::<hub::Hub>(),
            a!(args, "project", String),
            a!(args, "question", String),
            a!(args, "mode", String),
            a!(args, "leader", String),
            a!(args, "workers", Vec<String>)
        )),
        "research_list" => sync!(Ok::<_, String>(research::research_list(a!(
            args, "project", String
        )))),
        "research_read" => sync!(research::research_read(
            a!(args, "project", String),
            a!(args, "id", String),
            a!(args, "file", String)
        )),
        "research_remove" => sync!(research::research_remove(
            a!(args, "project", String),
            a!(args, "id", String)
        )),
        "skills_list" => Ok(tauri::async_runtime::block_on(skills::skills_list())),
        "skills_read" => async_call!(skills::skills_read(a!(args, "name", String))),
        "errors_list" => async_call!(errlog::errors_list()),
        "app_about" => sync!(Ok::<_, String>(updater::app_about())),
        "opencode_go_usage" => async_call!(limits::opencode_go_usage()),
        "remote_layout_get" => sync!(Ok::<_, String>(remote_layout_get())),
        "remote_push_vapid_key" => sync!(remote_push_vapid_key()),
        "remote_push_subscribe" => sync!(remote_push_subscribe(a!(
            args,
            "subscription",
            PushSubscription
        ))),
        "remote_push_unsubscribe" => sync!(remote_push_unsubscribe(a!(args, "endpoint", String))),
        "remote_push_visibility" => sync!(remote_push_visibility(a!(args, "visible", bool))),
        "pc_status" => sync!(Ok::<_, String>(pc_status(app))),
        "remote_action" => sync!(remote_action(app, args)),
        _ => Err(format!("comando no permitido: {command}")),
    }
}

fn serve_rpc(app: &AppHandle, command: &str, mut req: Request) {
    let mut body = Vec::new();
    let max_body = rpc_body_limit(command);
    if req
        .as_reader()
        .take((max_body + 1) as u64)
        .read_to_end(&mut body)
        .is_err()
        || body.len() > max_body
    {
        let _ = req.respond(json(
            400,
            serde_json::json!({"error":"cuerpo inválido o demasiado grande"}),
        ));
        return;
    }
    let args: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            let _ = req.respond(json(400, serde_json::json!({"error":e.to_string()})));
            return;
        }
    };
    let (status, result) = rpc_result(dispatch_rpc(app, command, &args));
    let _ = req.respond(json(status, result));
}

fn rpc_body_limit(command: &str) -> usize {
    if matches!(command, "project_save_image" | "project_save_attachment") {
        MAX_UPLOAD_BODY
    } else {
        MAX_BODY
    }
}

fn rpc_result(result: Result<serde_json::Value, String>) -> (u16, serde_json::Value) {
    match result {
        Ok(v) => (200, v),
        Err(e) if e.starts_with("comando no permitido") => (404, serde_json::json!({"error":e})),
        Err(e) => (400, serde_json::json!({"error":e})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_https_push_service_endpoints() {
        assert!(push_endpoint_allowed("https://web.push.apple.com/QwErTy"));
        assert!(push_endpoint_allowed(
            "https://fcm.googleapis.com/fcm/send/abc"
        ));
        assert!(push_endpoint_allowed(
            "https://updates.push.services.mozilla.com/wpush/v2/abc"
        ));
        assert!(!push_endpoint_allowed("http://web.push.apple.com/abc"));
        assert!(!push_endpoint_allowed(
            "https://web.push.apple.com.attacker.invalid/abc"
        ));
        assert!(!push_endpoint_allowed("https://127.0.0.1/abc"));
        assert!(!push_endpoint_allowed(
            "https://user@web.push.apple.com/abc"
        ));
    }

    #[test]
    fn push_copy_uses_fixed_path_free_messages() {
        let (title, body) = push_copy("ask", r"C:\private\token.txt").unwrap();
        assert_eq!(title, "Un agente necesita tu respuesta");
        assert!(body.contains("Abre Prometeo"));
        assert!(!title.contains("C:"));
        assert!(!body.contains("private"));
        assert!(
            push_copy("delivery", "claude")
                .unwrap()
                .1
                .contains("revisar")
        );
        assert!(push_copy("file", "codex").unwrap().0.contains("Codex"));
        assert!(push_copy("reply", "claude").is_none());
    }

    #[test]
    fn service_worker_always_shows_and_groups_push_notifications() {
        assert!(!PUSH_SERVICE_WORKER.contains("visibilityState === 'visible'"));
        assert!(PUSH_SERVICE_WORKER.contains("showNotification"));
        assert!(!PUSH_SERVICE_WORKER.contains("catch { return; }"));
        assert!(PUSH_SERVICE_WORKER.contains("prometeo-${kind}"));
        assert!(PUSH_SERVICE_WORKER.contains("notificationclick"));
    }

    #[test]
    fn visible_remote_window_suppresses_push_for_thirty_seconds() {
        let now = Instant::now();
        assert!(remote_push_visibility_recent(Some(now), now));
        assert!(remote_push_visibility_recent(
            Some(now - Duration::from_secs(29)),
            now
        ));
        assert!(!remote_push_visibility_recent(
            Some(now - Duration::from_secs(31)),
            now
        ));
        assert!(!remote_push_visibility_recent(None, now));
    }

    #[test]
    fn bearer_and_query_auth_compare_tokens() {
        assert!(!valid_token("abc", "abc"));
        assert!(!valid_token("abc", "abd"));
        let token = "ab".repeat(TOKEN_LEN / 2);
        assert!(valid_token(&token, &token));
        assert!(!valid_token(&format!("{token}0"), &token));
        assert!(query_token("/events?t=abc").as_deref() == Some("abc"));
    }
    #[test]
    fn encoded_query_token_decodes() {
        assert_eq!(query_token("/events?t=a%20b").as_deref(), Some("a b"));
    }
    #[test]
    fn web_manifest_is_served_as_manifest_json() {
        assert_eq!(
            static_mime("manifest.webmanifest", "text/html"),
            "application/manifest+json"
        );
        assert_eq!(static_mime("icons/icon-192.png", "image/png"), "image/png");
    }
    #[test]
    fn static_assets_use_the_requested_cache_policy() {
        assert_eq!(cache_policy("/", "index.html"), "no-store");
        assert_eq!(
            cache_policy("/assets/app-a1.js", "assets/app-a1.js"),
            "public, max-age=31536000, immutable"
        );
    }
    #[test]
    fn auth_returns_401_or_200_for_bearer_and_eventsource_query() {
        let token = "a".repeat(TOKEN_LEN);
        assert_eq!(
            auth_status(&Method::Post, "/rpc/team_state", None, None, &token),
            401
        );
        assert_eq!(
            auth_status(&Method::Post, "/rpc/team_state", Some(&token), None, &token),
            200
        );
        assert_eq!(
            auth_status(&Method::Get, "/events", None, Some(&token), &token),
            200
        );
        assert_eq!(auth_status(&Method::Get, "/files", None, None, &token), 401);
        assert_eq!(
            auth_status(&Method::Get, "/files", None, Some(&token), &token),
            200
        );
    }
    #[test]
    fn camel_case_arguments_follow_tauri_command_conversion() {
        let args = serde_json::json!({"fixLimit":3,"fromMs":42});
        assert_eq!(arg::<Option<u32>>(&args, "fixLimit").unwrap(), Some(3));
        assert_eq!(arg::<u64>(&args, "fromMs").unwrap(), 42);
    }
    #[test]
    fn remote_only_commands_are_not_exposed_to_rpc() {
        assert!(dispatch_rpc_command_allowed("team_state"));
        assert!(dispatch_rpc_command_allowed("remote_action"));
        assert!(dispatch_rpc_command_allowed("remote_push_vapid_key"));
        assert!(dispatch_rpc_command_allowed("remote_push_subscribe"));
        assert!(dispatch_rpc_command_allowed("remote_push_unsubscribe"));
        assert!(dispatch_rpc_command_allowed("remote_push_visibility"));
        assert!(!dispatch_rpc_command_allowed("remote_push_send"));
        assert!(!dispatch_rpc_command_allowed("update_apply"));
        assert!(!dispatch_rpc_command_allowed("remote_set"));
        assert!(!dispatch_rpc_command_allowed("no_such_command"));
        assert_eq!(
            rpc_result(Err("comando no permitido: update_apply".into())).0,
            404
        );
    }

    #[test]
    fn remote_actions_accept_only_the_known_shapes_and_safe_arguments() {
        for kind in [
            "launch-squad",
            "open-agent",
            "close-agent",
            "restart-agent",
            "switch-project",
        ] {
            let value = match kind {
                "launch-squad" => serde_json::json!({"kind":kind}),
                "open-agent" | "close-agent" | "restart-agent" => {
                    serde_json::json!({"kind":kind,"agent":"claude"})
                }
                _ => serde_json::json!({"kind":kind,"path":"C:\\\\work\\\\demo"}),
            };
            assert!(valid_remote_action(serde_json::from_value(value).unwrap()).is_ok());
        }
        let empty_agent: RemoteAction =
            serde_json::from_value(serde_json::json!({"kind":"open-agent","agent":" "})).unwrap();
        assert!(valid_remote_action(empty_agent).is_err());
        let control_path: RemoteAction = serde_json::from_value(
            serde_json::json!({"kind":"switch-project","path":format!("bad{}path", '\n')}),
        )
        .unwrap();
        assert!(valid_remote_action(control_path).is_err());
        assert!(
            serde_json::from_value::<RemoteAction>(serde_json::json!({"kind":"run-shell"}))
                .is_err()
        );
        assert!(valid_remote_request_id("abc-123_X"));
        assert!(!valid_remote_request_id(""));
        assert!(!valid_remote_request_id("invalid id"));
    }

    #[test]
    fn only_upload_rpcs_get_the_larger_remote_body_limit() {
        assert_eq!(rpc_body_limit("project_save_image"), 40 * 1024 * 1024);
        assert_eq!(rpc_body_limit("project_save_attachment"), 40 * 1024 * 1024);
        assert_eq!(rpc_body_limit("team_state"), 1024 * 1024);
    }

    #[test]
    fn sse_flushes_small_frames_without_filling_an_eight_kilobyte_buffer() {
        use std::{
            io::{BufRead, BufReader},
            net::{TcpListener, TcpStream},
        };

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (tx, rx) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            write_sse_stream(stream, rx).unwrap();
        });
        let stream = TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut reader = BufReader::new(stream);
        let mut headers = String::new();
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            headers.push_str(&line);
            if line == "\r\n" {
                break;
            }
        }
        assert!(headers.contains("Content-Type: text/event-stream"));
        tx.send(b"event: team://update\ndata: {}\n\n".to_vec())
            .unwrap();
        let mut frame = String::new();
        while !frame.ends_with("\n\n") {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            frame.push_str(&line);
        }
        assert_eq!(frame, "event: team://update\ndata: {}\n\n");
        drop(tx);
        server.join().unwrap();
    }

    #[test]
    fn only_loopback_and_tailscale_peers_are_allowed() {
        let p = |s: &str| s.parse::<SocketAddr>().unwrap();
        assert!(allowed_peer(Some(&p("127.0.0.1:5000"))));
        assert!(allowed_peer(Some(&p("[::1]:5000"))));
        assert!(allowed_peer(Some(&p("100.64.0.1:5000"))));
        assert!(allowed_peer(Some(&p("100.127.255.254:5000"))));
        assert!(allowed_peer(Some(&p("[::ffff:100.100.1.2]:5000"))));
        assert!(!allowed_peer(Some(&p("100.63.255.255:5000"))));
        assert!(!allowed_peer(Some(&p("100.128.0.1:5000"))));
        assert!(!allowed_peer(Some(&p("192.168.1.20:5000"))));
        assert!(!allowed_peer(Some(&p("10.0.0.5:5000"))));
        assert!(!allowed_peer(Some(&p("[::ffff:192.168.1.20]:5000"))));
        assert!(!allowed_peer(Some(&p("[fe80::1]:5000"))));
        assert!(!allowed_peer(None));
    }

    #[test]
    fn serve_url_comes_from_the_handler_that_proxies_our_port() {
        let ours = r#"{"TCP":{"443":{"HTTPS":true}},"Web":{"pc.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:47820"}}}}}"#;
        assert_eq!(
            serve_url_from_json(ours).as_deref(),
            Some("https://pc.tail1234.ts.net")
        );
        let other_port = r#"{"Web":{"pc.tail1234.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:47820/"}}}}}"#;
        assert_eq!(
            serve_url_from_json(other_port).as_deref(),
            Some("https://pc.tail1234.ts.net:8443")
        );
        let theirs = r#"{"Web":{"pc.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}}}"#;
        assert_eq!(serve_url_from_json(theirs), None);
        assert_eq!(serve_url_from_json("{}"), None);
        assert_eq!(serve_url_from_json("no json"), None);
    }
}
