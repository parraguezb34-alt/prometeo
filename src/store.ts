import { useSyncExternalStore } from "react";
import { agentKeyFromCmd } from "./lib/agentKey";

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

// Misma clave que cuando existía el lienzo espacial: así las sesiones abiertas
// se siguen re-adjuntando. Los paneles antiguos de equipo/progreso se descartan.
const STORAGE_KEY = "lienzo.layout.v1";

function load(): Layout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
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
  return { panels: [], seq: 1 };
}

let state: Layout = load();
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
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* storage full or unavailable: layout won't persist */
    }
  }, 250);
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
 * Orden con la que se reabre la terminal de un agente cuya sesión ya no existe (lienzo se
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
