import { useSyncExternalStore } from "react";
import { agentKeyFromCmd } from "./lib/agentKey";
import { invoke, isPrimary, listen } from "./lib/bridge";

/**
 * Terminales vivas de los agentes. Cada una es una sesión PTY que el backend
 * mantiene aunque la interfaz se recargue: guardamos su id para re-adjuntarla.
 */
export type Panel = {
  id: string;
  kind: "terminal";
  title: string;
  /** PTY session id attached to this panel (survives frontend reloads). */
  sessionId: string | null;
  /** Command the terminal runs on spawn (e.g. an agent CLI). */
  cmd?: string | null;
};

export type Layout = {
  panels: Panel[];
  seq: number;
};

/** Acciones remotas ejecutadas por el frontend principal, nunca por el hilo HTTP. */
export type RemoteAction =
  | { kind: "launch-squad" }
  | { kind: "open-agent"; agent: string }
  | { kind: "close-agent"; agent: string }
  | { kind: "restart-agent"; agent: string }
  | { kind: "switch-project"; path: string };

const pendingRemoteActionIds = new Set<string>();

export function requestPrimaryAction(action: RemoteAction): Promise<string> {
  if (isPrimary()) return Promise.reject(new Error("La acción remota solo se pide desde el iPad."));
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  pendingRemoteActionIds.add(id);
  return invoke<{ accepted: boolean }>("remote_action", { action, request_id: id })
    .then(() => id)
    .catch((error) => {
      pendingRemoteActionIds.delete(id);
      throw error;
    });
}

export function consumeRemoteActionResult(id: string): boolean {
  return pendingRemoteActionIds.delete(id);
}

// Misma clave que cuando existía el lienzo espacial: así las sesiones abiertas
// se siguen re-adjuntando. Los paneles antiguos de equipo/progreso se descartan.
const STORAGE_KEY = "lienzo.layout.v1";

function load(): Layout {
  // En el iPad la disposición es la del PC (ver syncRemoteLayout): aquí no hay nada propio.
  if (!isPrimary()) return { panels: [], seq: 1 };
  try {
    return parseLayout(localStorage.getItem(STORAGE_KEY)) ?? { panels: [], seq: 1 };
  } catch {
    return { panels: [], seq: 1 };
  }
}

function parseLayout(raw: string | null): Layout | null {
  try {
    if (raw) {
      const parsed = JSON.parse(raw) as { panels?: Partial<Panel>[]; seq?: number };
      if (Array.isArray(parsed.panels)) {
        const panels = parsed.panels
          .filter((p) => p.kind === "terminal" && !!p.cmd && typeof p.id === "string")
          .map((p) => ({
            id: p.id as string,
            kind: "terminal" as const,
            title: p.title ?? "Terminal",
            sessionId: p.sessionId ?? null,
            cmd: p.cmd,
          }));
        // Una terminal por agente: se queda la más reciente (las demás eran duplicados).
        const latest = new Map<string, number>();
        panels.forEach((p, idx) => latest.set(agentKeyFromCmd(p.cmd ?? ""), idx));
        const unique = panels.filter((p, idx) => latest.get(agentKeyFromCmd(p.cmd ?? "")) === idx);
        return { panels: unique, seq: parsed.seq ?? panels.length + 1 };
      }
    }
  } catch {
    /* corrupted storage: fall back to defaults */
  }
  return null;
}

let state: Layout = load();
let remoteRecentProjects: string[] = [];
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getLayout() {
  return state;
}

export function useLayout() {
  return useSyncExternalStore(subscribe, getLayout);
}

let saveTimer: number | undefined;
function scheduleSave() {
  if (saveTimer !== undefined) window.clearTimeout(saveTimer);
  if (!isPrimary()) return; // el iPad no guarda: la próxima sincronización trae la del PC
  saveTimer = window.setTimeout(() => {
    const json = JSON.stringify({ ...state, recentProjects: remoteRecentProjects });
    try {
      localStorage.setItem(STORAGE_KEY, json);
    } catch {
      /* storage full or unavailable: layout won't persist */
    }
    shareLayout(json);
  }, 250);
}

/** La ventana del PC deja su disposición en el núcleo para que el iPad vea las mismas terminales. */
function shareLayout(json: string) {
  void invoke<void>("remote_layout_set", { json }).catch(() => {});
}
function sharePrimaryState() {
  shareLayout(JSON.stringify({ ...state, recentProjects: remoteRecentProjects }));
}
if (isPrimary()) sharePrimaryState();

export function publishRecentProjects(projects: string[]) {
  const next = [...new Set(projects.map((p) => p.trim()).filter(Boolean))].slice(0, 20);
  if (JSON.stringify(next) === JSON.stringify(remoteRecentProjects)) return;
  remoteRecentProjects = next;
  if (isPrimary()) sharePrimaryState();
  emit();
}

export function useRemoteRecentProjects() {
  return useSyncExternalStore(subscribe, () => remoteRecentProjects);
}

/**
 * Solo en el iPad: trae la disposición de paneles del PC (qué terminal es de qué agente).
 * Se llama antes de pintar y luego cada poco y con cada novedad del equipo.
 */
export async function syncRemoteLayout(): Promise<void> {
  if (isPrimary()) return;
  const raw = await invoke<string | null>("remote_layout_get").catch(() => null);
  let recent: string[] = [];
  try {
    const parsed = raw ? JSON.parse(raw) as { recentProjects?: unknown } : null;
    if (Array.isArray(parsed?.recentProjects)) {
      recent = parsed.recentProjects.filter((p): p is string => typeof p === "string" && !!p.trim()).slice(0, 20);
    }
  } catch {
    /* older layout payloads have no recent projects */
  }
  const next = parseLayout(raw);
  const changed = !!next && JSON.stringify(next) !== JSON.stringify(state);
  const recentChanged = JSON.stringify(recent) !== JSON.stringify(remoteRecentProjects);
  if (changed) state = next!;
  if (recentChanged) remoteRecentProjects = recent;
  if (changed || recentChanged) emit();
}

let remoteSync = false;
export function startRemoteLayoutSync() {
  if (isPrimary() || remoteSync) return;
  remoteSync = true;
  window.setInterval(() => void syncRemoteLayout(), 3000);
  void listen("team://update", () => void syncRemoteLayout()).catch(() => {});
}

function set(patch: Partial<Layout>) {
  state = { ...state, ...patch };
  emit();
  scheduleSave();
}

/** A terminal that starts already running a command (e.g. an agent CLI). */
export function addAgentTerminal(title: string, cmd: string): Panel {
  const n = state.seq;
  const panel: Panel = {
    id: `p${n}`,
    kind: "terminal",
    title,
    sessionId: null,
    cmd,
  };
  set({ panels: [...state.panels, panel], seq: n + 1 });
  return panel;
}

/** Quita una terminal (p. ej. al reiniciar un agente con otro modelo). */
export function removePanel(id: string) {
  set({ panels: state.panels.filter((p) => p.id !== id) });
}

/**
 * Orden con la que se reabre la terminal de un agente cuya sesión ya no existe (Prometeo se
 * reinició): el centro de mando la registra para retomar la conversación del chat actual.
 */
let respawnResolver: ((panel: Panel) => string | null) | null = null;

export function setRespawnResolver(fn: ((panel: Panel) => string | null) | null) {
  respawnResolver = fn;
}

export function respawnCmd(panel: Panel): string | null {
  return respawnResolver?.(panel) ?? panel.cmd ?? null;
}

export function setPanelSession(id: string, sessionId: string) {
  set({
    panels: state.panels.map((p) => (p.id === id ? { ...p, sessionId } : p)),
  });
}
