import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import type { Event, EventCallback, UnlistenFn } from "@tauri-apps/api/event";

export type { Event, EventCallback, UnlistenFn };

/**
 * Puente entre la interfaz y el núcleo de Prometeo.
 *
 * En la ventana del PC (Tauri) todo va por el IPC de siempre. Abierta desde un navegador (el iPad,
 * con «Acceso remoto» encendido en Ajustes), la misma interfaz habla con el PC por HTTP:
 * `POST /rpc/<comando>` para cada invoke y `GET /events` (SSE) para los eventos, con el token del
 * enlace (`?t=…`, que se guarda y se quita de la barra de direcciones). Ver src-tauri/src/remote.rs.
 *
 * El cliente remoto es PASIVO: el cerebro (despachador, avisos, programadas, abrir o cerrar
 * terminales) sigue en la ventana del PC. Lo que sea automático se protege con `isPrimary()`.
 */

const TOKEN_KEY = "prometeo.remote.token";

/** La ventana de escritorio de Prometeo (la que manda). */
export const isPrimary = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
/** Abierta desde un navegador por el acceso remoto. */
export const isRemote = (): boolean => !isPrimary();

function readToken(): string {
  if (typeof window === "undefined") return "";
  try {
    const url = new URL(window.location.href);
    const t = url.searchParams.get("t");
    if (t) {
      try {
        localStorage.setItem(TOKEN_KEY, t);
      } catch {
        /* sin almacenamiento: vale para esta pestaña */
      }
      return t;
    }
  } catch {
    /* URL rara: se intenta con lo guardado */
  }
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

let token = isRemote() ? readToken() : "";

/**
 * El token se queda en la barra de direcciones y en el manifiesto: «Añadir a pantalla de inicio»
 * del iPad crea una app con almacenamiento aparte que, sin él, pediría el enlace otra vez. Así
 * además el enlace que se copie de la barra de Safari sirve para entrar.
 */
function keepTokenInPage(t: string) {
  if (!t || typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get("t") !== t) {
      url.searchParams.set("t", t);
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (link) link.href = `/manifest.webmanifest?t=${encodeURIComponent(t)}`;
  } catch {
    /* sin URL o sin DOM: no pasa nada */
  }
}
if (isRemote()) keepTokenInPage(token);

export const remoteToken = () => token;

/** Cambia el token (pantalla de «pega tu enlace»). */
export function setRemoteToken(t: string) {
  token = t.trim();
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* sin almacenamiento */
  }
  keepTokenInPage(token);
  reopenEvents();
}

/** Si el PC rechazó el token (para pedir otro enlace). */
const authFns = new Set<(ok: boolean) => void>();
let authOk: boolean | null = null;
function setAuth(ok: boolean) {
  if (authOk === ok) return;
  authOk = ok;
  for (const f of Array.from(authFns)) f(ok);
}
export function onRemoteAuth(fn: (ok: boolean) => void): () => void {
  authFns.add(fn);
  if (authOk !== null) fn(authOk);
  return () => authFns.delete(fn);
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isPrimary()) return tauriInvoke<T>(cmd, args);
  let res: Response;
  try {
    res = await fetch(`/rpc/${encodeURIComponent(cmd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(args ?? {}),
    });
  } catch {
    // Como Tauri: el error llega como texto.
    failing();
    scheduleRetry();
    throw "Sin conexión con el PC";
  }
  if (res.status === 401) {
    setAuth(false);
    throw "Enlace no válido: copia el de Ajustes → Acceso remoto en el PC";
  }
  setAuth(true);
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const err = body && typeof body === "object" && "error" in body ? (body as { error: unknown }).error : body;
    throw typeof err === "string" ? err : `Error ${res.status} en ${cmd}`;
  }
  return body as T;
}

// --- Eventos (SSE) --------------------------------------------------------------------------

const handlers = new Map<string, Set<EventCallback<unknown>>>();
let source: EventSource | null = null;
let opened = false;
let seq = 0;

/**
 * Estado de la conexión del iPad con el PC. Safari corta los eventos al pasar a segundo plano
 * sin avisar (ni `error` ni reconexión), así que se vigila: latido del PC cada 15 s, reabrir al
 * volver a la app y reintentos con espera creciente.
 */
export type RemoteLink = "ok" | "reconnecting" | "offline";
let link: RemoteLink = "ok";
const linkFns = new Set<(l: RemoteLink) => void>();
let lastBeat = Date.now();
let openedAt = Date.now();
let failingSince = 0;
let retryTimer: number | undefined;
let retryDelay = 1000;
let watching = false;
let hiddenAt = 0;

function setLink(l: RemoteLink) {
  if (link === l) return;
  link = l;
  for (const f of Array.from(linkFns)) f(l);
}
export function onRemoteLink(fn: (l: RemoteLink) => void): () => void {
  linkFns.add(fn);
  fn(link);
  return () => linkFns.delete(fn);
}

function failing() {
  if (!failingSince) failingSince = Date.now();
  setLink(Date.now() - failingSince > 20_000 ? "offline" : "reconnecting");
}

function scheduleRetry() {
  if (retryTimer !== undefined) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = undefined;
    reopenEvents(true);
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 15_000);
}

function watch() {
  if (watching || typeof window === "undefined") return;
  watching = true;
  // Al volver a la app o a la red: reabrir siempre si estuvo fuera un rato (Safari pudo matar
  // la conexión sin decir nada); si fue un vistazo de unos segundos, solo si no está viva.
  const back = () => {
    const away = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = 0;
    if (away > 5_000 || !source || source.readyState !== EventSource.OPEN) reopenEvents(true);
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") hiddenAt = Date.now();
    else back();
  });
  window.addEventListener("pageshow", (e) => {
    if ((e as PageTransitionEvent).persisted) reopenEvents(true);
  });
  window.addEventListener("online", () => reopenEvents(true));
  window.addEventListener("offline", () => failing());
  window.setInterval(() => {
    if (document.visibilityState === "hidden" || !source) return;
    const now = Date.now();
    const stuck = source.readyState === EventSource.CONNECTING && now - openedAt > 8_000;
    const silent = source.readyState === EventSource.OPEN && now - lastBeat > 45_000;
    if (stuck || silent || source.readyState === EventSource.CLOSED) {
      failing();
      reopenEvents(true);
    }
  }, 5_000);
}

function deliver(name: string, payload: unknown) {
  const set = handlers.get(name);
  if (!set) return;
  const ev = { event: name, id: ++seq, payload } as Event<unknown>;
  for (const h of Array.from(set)) {
    try {
      h(ev);
    } catch (e) {
      console.error(e);
    }
  }
}

function attach(es: EventSource, name: string) {
  es.addEventListener(name, (m) => {
    lastBeat = Date.now();
    let payload: unknown = null;
    try {
      payload = JSON.parse((m as MessageEvent<string>).data);
    } catch {
      payload = (m as MessageEvent<string>).data;
    }
    deliver(name, payload);
  });
}

function ensureEvents() {
  if (source || typeof EventSource === "undefined") return;
  const es = new EventSource(`/events?t=${encodeURIComponent(token)}`);
  source = es;
  openedAt = Date.now();
  watch();
  for (const name of handlers.keys()) attach(es, name);
  es.addEventListener("ping", () => {
    lastBeat = Date.now();
  });
  es.onopen = () => {
    if (source !== es) return;
    setAuth(true);
    lastBeat = Date.now();
    failingSince = 0;
    retryDelay = 1000;
    setLink("ok");
    // Tras un corte se perdieron eventos: que el equipo se vuelva a pedir entero.
    if (opened) deliver("team://update", null);
    opened = true;
  };
  es.onerror = () => {
    if (source !== es) return;
    failing();
    probeAuth();
    // CLOSED: el navegador ya no reintentará solo (p. ej. el PC respondió con error).
    if (es.readyState === EventSource.CLOSED) scheduleRetry();
  };
}

/**
 * EventSource no deja ver el código de error: si el PC rechaza el token (401) el iPad solo veía
 * «Sin conexión» para siempre. Se pregunta aparte para mostrar la pantalla de «escanea el QR».
 */
let probing = false;
function probeAuth() {
  if (probing) return;
  probing = true;
  fetch(`/events?t=${encodeURIComponent(token)}`, { method: "HEAD", cache: "no-store" })
    .then((res) => {
      if (res.status === 401) setAuth(false);
    })
    .catch(() => {
      /* sin red: sigue siendo «Sin conexión» */
    })
    .finally(() => {
      probing = false;
    });
}

function reopenEvents(force = false) {
  if (!source && !force) return;
  if (retryTimer !== undefined) {
    window.clearTimeout(retryTimer);
    retryTimer = undefined;
  }
  source?.close();
  source = null;
  ensureEvents();
}

/** Reintenta ya (botón de la franja «Sin conexión»). */
export function reconnectNow() {
  retryDelay = 1000;
  reopenEvents(true);
}

export async function listen<T>(name: string, fn: EventCallback<T>): Promise<UnlistenFn> {
  if (isPrimary()) return tauriListen<T>(name, fn);
  let set = handlers.get(name);
  if (!set) {
    set = new Set();
    handlers.set(name, set);
    if (source) attach(source, name);
  }
  const h = fn as EventCallback<unknown>;
  set.add(h);
  ensureEvents();
  return () => {
    set.delete(h);
  };
}

// --- Lo que solo existe en el PC ----------------------------------------------------------

const ONLY_PC = "Eso solo se puede hacer en el PC";

/** Abre un enlace: en el PC con el navegador del sistema; en el iPad, en una pestaña nueva. */
export async function openUrl(url: string): Promise<void> {
  if (isPrimary()) {
    const m = await import("@tauri-apps/plugin-opener");
    return m.openUrl(url);
  }
  window.open(url, "_blank", "noopener");
}

/**
 * Dirección para bajar (o ver, con `inline`) un archivo del proyecto desde el navegador remoto.
 * El token va en la consulta: un enlace de descarga no puede llevar cabeceras.
 */
export function remoteFileUrl(path: string, inline = false): string {
  const q = new URLSearchParams({ path, t: token });
  if (inline) q.set("inline", "1");
  return `/files?${q.toString()}`;
}

/** Descarga en el iPad (o en cualquier navegador remoto) un archivo del proyecto del PC. */
export function downloadRemoteFile(path: string): void {
  const a = document.createElement("a");
  a.href = remoteFileUrl(path);
  a.download = path.split(/[\\/]/).pop() || "archivo";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export async function revealItemInDir(path: string): Promise<void> {
  if (!isPrimary()) throw ONLY_PC;
  const m = await import("@tauri-apps/plugin-opener");
  return m.revealItemInDir(path);
}

type OpenOpts = import("@tauri-apps/plugin-dialog").OpenDialogOptions;
type SaveOpts = import("@tauri-apps/plugin-dialog").SaveDialogOptions;

/** Diálogo de abrir: en el iPad no hay explorador del PC, así que devuelve null (cancelado). */
export async function openDialog(opts: OpenOpts): Promise<string | string[] | null> {
  if (!isPrimary()) return null;
  const m = await import("@tauri-apps/plugin-dialog");
  return m.open(opts);
}

export async function saveDialog(opts: SaveOpts): Promise<string | null> {
  if (!isPrimary()) return null;
  const m = await import("@tauri-apps/plugin-dialog");
  return m.save(opts);
}
