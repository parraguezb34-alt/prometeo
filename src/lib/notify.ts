import { invoke } from "./bridge";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { getSettings } from "./settings";

/**
 * Avisos del equipo. Si estás mirando Prometeo, salen dentro de la app (arriba a la derecha).
 * Si estás en otra ventana, salen en la esquina de la pantalla: con el diseño de Prometeo (una
 * ventanita propia, ver aviso.rs) o como aviso de Windows, según Ajustes → Avisos.
 */

export type AvisoKind = "ask" | "done" | "delivery" | "file" | "reply" | "late" | "info";
export type Aviso = { id: string; title: string; body: string; agent?: string; kind: AvisoKind; ts_ms: number };

let seq = 0;
const make = (title: string, body: string, meta: { agent?: string; kind?: AvisoKind }): Aviso => ({
  id: `${Date.now()}-${++seq}`,
  title,
  body: body.slice(0, 280),
  agent: meta.agent,
  kind: meta.kind ?? "info",
  ts_ms: Date.now(),
});

// ---- dentro de la app ----

const listeners = new Set<(a: Aviso) => void>();

/** El montón de avisos de dentro de la app se suscribe aquí. */
export function onInAppAviso(fn: (a: Aviso) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// ---- fuera: aviso de Windows (sin diseño propio; se juntan si llegan varios) ----

let granted: boolean | null = null;
let queue: { title: string; body: string }[] = [];
let timer: number | undefined;

async function allowed(): Promise<boolean> {
  if (!("__TAURI_INTERNALS__" in window)) return false;
  if (granted === null) {
    try {
      granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
    } catch {
      granted = false;
    }
  }
  return granted;
}

function flush() {
  timer = undefined;
  const items = queue;
  queue = [];
  if (items.length === 0) return;
  const one =
    items.length === 1
      ? items[0]
      : { title: `${items.length} novedades del equipo`, body: items.map((i) => `• ${i.title}`).join("\n") };
  void allowed().then((ok) => {
    if (ok) sendNotification({ title: one.title, body: one.body.slice(0, 240) });
  });
}

function outside(a: Aviso): Promise<boolean> {
  if (!("__TAURI_INTERNALS__" in window)) return Promise.resolve(false);
  if (getSettings().notify.style === "windows") {
    queue.push({ title: a.title, body: a.body });
    if (timer === undefined) timer = window.setTimeout(flush, 1500);
    return allowed();
  }
  return invoke("aviso_push", { item: a }).then(
    () => true,
    () => false,
  );
}

const recent = new Map<string, number>();

/** Avisa de algo del equipo: dentro de la app si la estás mirando; fuera si no. */
export function notify(title: string, body: string, meta: { agent?: string; kind?: AvisoKind } = {}) {
  // El mismo aviso no se repite en 10 min (si algo lo dispara en bucle, sale una vez).
  const sig = `${meta.agent ?? ""}|${title}|${body}`;
  const now = Date.now();
  if (now - (recent.get(sig) ?? 0) < 10 * 60_000) return;
  recent.set(sig, now);
  if (recent.size > 200) for (const [k, t] of recent) if (now - t > 10 * 60_000) recent.delete(k);
  const a = make(title, body, meta);
  if (
    "__TAURI_INTERNALS__" in window &&
    (a.kind === "ask" || a.kind === "delivery" || a.kind === "file")
  ) {
    // Rust creates a fixed, path-free copy and sends it off-thread; the iPad SW suppresses it
    // while a remote Prometeo window is visible, independently of the PC window focus.
    void invoke("remote_push_send", { kind: a.kind, agent: a.agent }).catch(() => {});
  }
  const focused = document.hasFocus();
  if (focused) listeners.forEach((fn) => fn(a));
  if (focused && !getSettings().notify.whenFocused) return;
  void outside(a);
}

/** Aviso de prueba desde Ajustes: sale fuera al momento aunque Prometeo esté delante. */
export async function testNotify(): Promise<boolean> {
  return outside(
    make("Aviso de prueba de Prometeo", "Así te avisaré cuando un agente te necesite o termine algo.", {
      agent: "claude",
      kind: "done",
    }),
  );
}
