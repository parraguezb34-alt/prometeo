import { useSyncExternalStore } from "react";
import { DISPATCH_CONFIG } from "./dispatcher";
import type { DispatchConfig } from "./dispatcher";

/**
 * Ajustes de la interfaz que no son del hub: cómo reparte tareas el despacho, qué
 * avisos de Windows quieres y qué agentes quedan fuera del equipo. Viven en el
 * navegador, como el resto de preferencias de Prometeo.
 */
export type LeaderMode = "last" | "never" | "any";
/** on = siempre · system = como diga Windows («Efectos de animación») · off = reducidas. */
export type MotionMode = "on" | "system" | "off";

export type Settings = {
  dispatch: {
    /** Segundos para que el agente reclame la tarea tras el aviso. */
    claimWaitS: number;
    /** Avisos sin respuesta tras los que una tarea se queda parada. */
    failureLimit: number;
    /** Avisos seguidos sin respuesta tras los que se pausa al agente. */
    agentFailLimit: number;
    pauseMin: number;
    /** Segundos sin actividad para considerar libre a un agente. */
    idleS: number;
    /** last = el líder solo si no hay nadie más · never = nunca · any = como uno más. */
    leader: LeaderMode;
  };
  notify: {
    ask: boolean;
    done: boolean;
    reply: boolean;
    /** Minutos sin respuesta a tu mensaje antes de avisar (0 = nunca). */
    lateMin: number;
    /** Avisar también fuera cuando Prometeo está delante (dentro de la app se avisa siempre). */
    whenFocused: boolean;
    /** Cómo se ven los avisos fuera de Prometeo: con su diseño o como avisos de Windows. */
    style: "lienzo" | "windows";
  };
  team: {
    /** Escribir en la terminal de un agente libre cuando le llega un mensaje de otro. */
    relayInbox: boolean;
    /** Modo director: limpiar el contexto del líder (Claude) al acabar cada misión. */
    leaderClean: boolean;
  };
  ui: {
    motion: MotionMode;
  };
  /** Agentes que no se abren al iniciar ni reciben tareas del despacho. */
  skipAgents: string[];
  /** Carpetas de proyecto usadas hace poco, la más reciente primero. */
  recentProjects: string[];
};

export const DEFAULT_SETTINGS: Settings = {
  dispatch: {
    claimWaitS: DISPATCH_CONFIG.claimWaitMs / 1000,
    failureLimit: DISPATCH_CONFIG.failureLimit,
    agentFailLimit: DISPATCH_CONFIG.agentFailLimit,
    pauseMin: DISPATCH_CONFIG.pauseMs / 60_000,
    idleS: DISPATCH_CONFIG.idleMs / 1000,
    leader: "last",
  },
  notify: { ask: true, done: true, reply: true, lateMin: 3, whenFocused: false, style: "lienzo" },
  team: { relayInbox: true, leaderClean: true },
  ui: { motion: "on" },
  skipAgents: [],
  recentProjects: [],
};

const KEY = "lienzo.settings.v1";
const listeners = new Set<() => void>();

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Settings>;
      return {
        dispatch: { ...DEFAULT_SETTINGS.dispatch, ...(p.dispatch ?? {}) },
        notify: { ...DEFAULT_SETTINGS.notify, ...(p.notify ?? {}) },
        team: { ...DEFAULT_SETTINGS.team, ...(p.team ?? {}) },
        ui: { ...DEFAULT_SETTINGS.ui, ...(p.ui ?? {}) },
        skipAgents: Array.isArray(p.skipAgents) ? p.skipAgents : [],
        recentProjects: Array.isArray(p.recentProjects) ? p.recentProjects : [],
      };
    }
  } catch {
    /* sin almacenamiento o ajustes rotos: los de siempre */
  }
  return DEFAULT_SETTINGS;
}

let current = load();

export function getSettings(): Settings {
  return current;
}

/** Cambia una parte de los ajustes (los grupos se mezclan, no se sustituyen). */
export function updateSettings(patch: {
  dispatch?: Partial<Settings["dispatch"]>;
  notify?: Partial<Settings["notify"]>;
  team?: Partial<Settings["team"]>;
  ui?: Partial<Settings["ui"]>;
  skipAgents?: string[];
  recentProjects?: string[];
}) {
  current = {
    dispatch: { ...current.dispatch, ...(patch.dispatch ?? {}) },
    notify: { ...current.notify, ...(patch.notify ?? {}) },
    team: { ...current.team, ...(patch.team ?? {}) },
    ui: { ...current.ui, ...(patch.ui ?? {}) },
    skipAgents: patch.skipAgents ?? current.skipAgents,
    recentProjects: patch.recentProjects ?? current.recentProjects,
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* sin almacenamiento: duran hasta cerrar Prometeo */
  }
  for (const l of listeners) l();
}

export function resetSettings(part: "dispatch" | "notify") {
  updateSettings({ [part]: DEFAULT_SETTINGS[part] });
}

/** Apunta una carpeta como reciente (máximo 6). */
export function rememberProject(path: string) {
  const p = path.trim();
  if (!p) return;
  const rest = current.recentProjects.filter((x) => x.toLowerCase() !== p.toLowerCase());
  updateSettings({ recentProjects: [p, ...rest].slice(0, 6) });
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getSettings,
  );
}

/** Lo que el despachador necesita de los ajustes. */
export function dispatchConfig(s: Settings): DispatchConfig {
  return {
    ...DISPATCH_CONFIG,
    claimWaitMs: s.dispatch.claimWaitS * 1000,
    failureLimit: s.dispatch.failureLimit,
    agentFailLimit: s.dispatch.agentFailLimit,
    pauseMs: s.dispatch.pauseMin * 60_000,
    idleMs: s.dispatch.idleS * 1000,
    leaderMode: s.dispatch.leader,
  };
}

/**
 * Marca en <html> si las animaciones van reducidas (`data-motion="off"`). En «Como Windows»
 * sigue a «Efectos de animación» del sistema, que la ventana ve como prefers-reduced-motion.
 */
export function applyMotion(mode: MotionMode = current.ui.motion) {
  const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const off = mode === "off" || (mode === "system" && reduce);
  document.documentElement.dataset.motion = off ? "off" : "on";
}

if (typeof document !== "undefined") {
  applyMotion();
  listeners.add(() => applyMotion());
  try {
    matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", () => applyMotion());
  } catch {
    /* sin matchMedia: se queda como esté */
  }
}

/** Una carpeta reciente cambió de nombre: la ruta vieja ya no existe. */
export function renameRecentProject(from: string, to: string) {
  const f = from.trim().toLowerCase();
  const list = current.recentProjects.map((x) => (x.trim().toLowerCase() === f ? to : x));
  updateSettings({ recentProjects: list.filter((x, i) => list.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i) });
}
