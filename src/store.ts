import { useSyncExternalStore } from "react";

export type PanelKind = "terminal" | "team";

export type Panel = {
  id: string;
  kind: PanelKind;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  /** PTY session id attached to this panel (survives frontend reloads). */
  sessionId: string | null;
};

export type View = { x: number; y: number; zoom: number };

export type Layout = {
  panels: Panel[];
  view: View;
  seq: number;
};

const STORAGE_KEY = "lienzo.layout.v1";
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2.5;

function defaultLayout(): Layout {
  return {
    panels: [
      {
        id: "p1",
        kind: "terminal",
        x: 0,
        y: 0,
        w: 640,
        h: 400,
        title: "Terminal 1",
        sessionId: null,
      },
    ],
    view: { x: 90, y: 70, zoom: 1 },
    seq: 2,
  };
}

function load(): Layout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Layout;
      if (Array.isArray(parsed.panels) && parsed.view) return parsed;
    }
  } catch {
    /* corrupted storage: fall back to defaults */
  }
  return defaultLayout();
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

export function clampZoom(z: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

export function setView(view: View) {
  set({ view });
}

export function resetView() {
  set({ view: { x: 90, y: 70, zoom: 1 } });
}

export function addTerminal(x: number, y: number): Panel {
  const n = state.seq;
  const panel: Panel = {
    id: `p${n}`,
    kind: "terminal",
    x,
    y,
    w: 640,
    h: 400,
    title: `Terminal ${n}`,
    sessionId: null,
  };
  set({ panels: [...state.panels, panel], seq: n + 1 });
  return panel;
}

export function addTeam(x: number, y: number): Panel {
  const n = state.seq;
  const panel: Panel = {
    id: `p${n}`,
    kind: "team",
    x,
    y,
    w: 620,
    h: 470,
    title: "Equipo",
    sessionId: null,
  };
  set({ panels: [...state.panels, panel], seq: n + 1 });
  return panel;
}

export function removePanel(id: string) {
  set({ panels: state.panels.filter((p) => p.id !== id) });
}

export function movePanel(id: string, x: number, y: number) {
  set({ panels: state.panels.map((p) => (p.id === id ? { ...p, x, y } : p)) });
}

export function resizePanel(id: string, w: number, h: number) {
  set({ panels: state.panels.map((p) => (p.id === id ? { ...p, w, h } : p)) });
}

export function setPanelSession(id: string, sessionId: string) {
  set({
    panels: state.panels.map((p) => (p.id === id ? { ...p, sessionId } : p)),
  });
}

/** Move a panel to the end of the array so it renders above the rest. */
export function bringToFront(id: string) {
  const i = state.panels.findIndex((p) => p.id === id);
  if (i < 0 || i === state.panels.length - 1) return;
  const next = state.panels.slice();
  const [panel] = next.splice(i, 1);
  next.push(panel);
  set({ panels: next });
}
