// Lo que comparten el Centro de Mando y sus piezas: tipos, claves guardadas y ayudas sueltas.
import type { Panel } from "../../store";
import { agentKeyFromCmd } from "../../lib/team";
import type { TeamEvent, TeamTask } from "../../lib/team";
import { inChat } from "../../lib/chats";
import type { Chat } from "../../lib/chats";
import { parseTask } from "../../lib/timeline";

/** Conversation shown in the central chat: the whole team or one agent. */
export type Sel = { kind: "team" } | { kind: "agent"; name: string };

/** What the stage shows for the team destination. */
export type CenterView = "feed" | "research" | "schedule" | "history" | "app" | "term";

/** Mission trigger mode: plan-first or straight to execution. */
export type Shoot = "plan" | "exec";

/** Capas flotantes sobre la pantalla: equipo, tareas, menú de nuevo chat y ajustes. */
export type Overlay = "team" | "tasks" | "newchat" | "settings" | null;

export const SHOOT_KEY = "lienzo.shoot.v1";
export const CHATS_MIN_KEY = "lienzo.chatsmin.v1";
export const DISPATCH_KEY = "lienzo.dispatch.v1";
/** Ya se avisó de que cerrar la ventana deja Prometeo en la bandeja. */
export const TRAY_KEY = "lienzo.bandeja.v1";
export const NOTIFY_KEY = "lienzo.notify.v1";
/**
 * Cuándo se abrió Prometeo: lo de antes no se vio (ni el silencio ni el trabajo de los agentes).
 * Vive en la ventana para que la recarga en caliente del desarrollo no lo reinicie.
 */
export const BOOT_MS: number = ((window as unknown as { __lienzoBootMs?: number }).__lienzoBootMs ??= Date.now());
/** Lo que cuenta como trabajo de un agente en el feed (entrar o abrir sesión no). */
export const WORK_KINDS = new Set(["tool", "task", "update"]);

/** Cuándo tomó cada tarea su dueño, según el feed (el último «#N tomada por …»). */
export function claimTimes(events: TeamEvent[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const e of events) {
    const t = parseTask(e);
    if (t?.op === "tomada" && e.ts_ms > (m.get(t.id) ?? 0)) m.set(t.id, e.ts_ms);
  }
  return m;
}

/** Ruido de conexión que no aporta a una conversación: nunca se muestra en el chat. */
export const HIDDEN_KINDS = new Set(["join", "leave", "session", "stop", "prompt"]);

/** Imágenes que pueden ser capturas de los agentes. */
export const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp"];
/** Adjuntos por mensaje como mucho. */
export const MAX_ATTS = 10;

/** Agente que estaba trabajando cuando apareció una imagen nueva (o nadie). */
export function imageOwner(events: TeamEvent[], ts: number): string {
  let best = "";
  let gap = Infinity;
  for (const e of events) {
    if (e.agent === "tú" || !e.agent) continue;
    const d = ts - e.ts_ms;
    if (d < -30_000 || d > 120_000) continue;
    if (Math.abs(d) < gap) {
      gap = Math.abs(d);
      best = e.agent;
    }
  }
  return best;
}

export function loadFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

export function saveFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* sin almacenamiento: no se recordará */
  }
}

export function loadShoot(): Shoot {
  try {
    return localStorage.getItem(SHOOT_KEY) === "plan" ? "plan" : "exec";
  } catch {
    return "exec";
  }
}

/** Terminal panel (if any) that belongs to a hub agent name. */
export function panelForAgent(panels: Panel[], agentName: string): Panel | undefined {
  return panels.find(
    (p) => p.kind === "terminal" && !!p.cmd && agentKeyFromCmd(p.cmd) === agentName,
  );
}

/** Tareas de un chat: las que nacieron en él (o en el que retoma) o que alguien tomó o cerró en él. */
export function taskIdsOfChat(lineage: Chat[], tasks: TeamTask[], events: TeamEvent[]): Set<number> {
  const ids = new Set<number>();
  for (const t of tasks) if (inChat(lineage, t.created_ms)) ids.add(t.id);
  for (const e of events) {
    if (e.kind !== "task" || !inChat(lineage, e.ts_ms)) continue;
    const t = parseTask(e);
    if (t) ids.add(t.id);
  }
  return ids;
}
