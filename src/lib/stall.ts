/**
 * Agentes colgados: un agente con una tarea tomada que deja de dar señales (ni
 * acciones en el hub ni trabajo visible en su terminal) o que lleva demasiado
 * con la misma herramienta. Se le avisa y se le pregunta antes de interrumpirlo.
 *
 * Es lógica pura (sin Tauri ni React) para poder probarla. La idea de los dos
 * umbrales viene del latido de Hermes Agent: «sin progreso» y «atascado en la
 * misma herramienta».
 */

export type StallConfig = {
  /** Sin ninguna señal durante este tiempo: colgado. */
  quietMs: number;
  /** La misma herramienta (sin hacer otra cosa) durante este tiempo: atascado. */
  sameToolMs: number;
};

export const STALL_CONFIG: StallConfig = {
  quietMs: 8 * 60_000,
  sameToolMs: 20 * 60_000,
};

/** Cada cuánto se revisa (el «latido»). */
export const STALL_CHECK_MS = 30_000;

/** Lo que se necesita de un evento del hub. */
export type SEvent = { agent: string; kind: string; text: string; ts_ms: number; seq: number };

export type Stall = {
  agent: string;
  taskId: number;
  /** quiet = sin señales · tool = la misma herramienta demasiado tiempo. */
  reason: "quiet" | "tool";
  /** Desde cuándo (ms epoch). */
  sinceMs: number;
  minutes: number;
  /** La herramienta en la que sigue, si reason = tool. */
  tool?: string;
};

/** Eventos que no cuentan como señal del agente: los pone el hub al entrar y salir. */
const NOT_SIGNAL = new Set(["join", "leave"]);

/** Último evento del agente en el hub que cuenta como señal (ms epoch; 0 si no hay). */
export function lastHubSignal(events: SEvent[], agent: string): number {
  let last = 0;
  for (const e of events) if (e.agent === agent && !NOT_SIGNAL.has(e.kind) && e.ts_ms > last) last = e.ts_ms;
  return last;
}

/**
 * La herramienta en la que sigue el agente y desde cuándo: su último evento es
 * una herramienta y, hacia atrás, solo repite esa misma (cualquier otra cosa,
 * como un team_update o una herramienta distinta, corta la racha).
 */
export function sameToolSince(events: SEvent[], agent: string): { tool: string; since: number } | null {
  const mine = events.filter((e) => e.agent === agent && !NOT_SIGNAL.has(e.kind)).sort((a, b) => b.seq - a.seq);
  const top = mine[0];
  if (!top || top.kind !== "tool") return null;
  let since = top.ts_ms;
  for (const e of mine.slice(1)) {
    if (e.kind !== "tool" || e.text !== top.text) break;
    since = e.ts_ms;
  }
  return { tool: top.text, since };
}

/**
 * ¿Está colgado el agente en su tarea? `termBusyMs` es la última vez que su
 * terminal se vio trabajando (0 si no se sabe). Un agente que espera tu permiso
 * o tu respuesta no está colgado: te espera a ti.
 */
export function detectStall(
  input: {
    now: number;
    agent: string;
    taskId: number;
    events: SEvent[];
    termBusyMs: number;
    waiting: boolean;
    /** Cuándo tomó la tarea (cuenta como señal), 0 si no se sabe. */
    claimedMs?: number;
    /** Desde cuándo se le vigila (al abrir Prometeo): lo de antes no cuenta como silencio. */
    fromMs?: number;
  },
  cfg: StallConfig = STALL_CONFIG,
): Stall | null {
  const { now, agent, taskId, events } = input;
  if (input.waiting) return null;
  const min = (since: number) => Math.max(0, Math.floor((now - since) / 60_000));
  const from = Math.max(input.claimedMs ?? 0, input.fromMs ?? 0);
  const last = Math.max(lastHubSignal(events, agent), input.termBusyMs, from);
  // Sin ninguna señal conocida (recién abierto) no se puede decir desde cuándo calla.
  if (last > 0 && cfg.quietMs > 0 && now - last >= cfg.quietMs) {
    return { agent, taskId, reason: "quiet", sinceMs: last, minutes: min(last) };
  }
  const same = sameToolSince(events, agent);
  // La racha no puede empezar antes de tomar la tarea ni de empezar a vigilarlo.
  const since = same ? Math.max(same.since, from) : 0;
  if (same && cfg.sameToolMs > 0 && now - since >= cfg.sameToolMs) {
    return { agent, taskId, reason: "tool", sinceMs: since, minutes: min(since), tool: same.tool };
  }
  return null;
}

/** El aviso de su tarjeta y del aviso de Windows. */
export function stallText(s: Stall): string {
  return s.reason === "tool"
    ? `Lleva ${s.minutes} min con la misma herramienta${s.tool ? ` (${s.tool.slice(0, 60)})` : ""}`
    : `Sin señales desde hace ${s.minutes} min`;
}

/** Lo que se le escribe en la terminal con «Preguntarle» (una sola línea). */
export function stallPrompt(s: Stall): string {
  const why = s.reason === "tool" ? `llevas ${s.minutes} min con la misma herramienta` : `llevas ${s.minutes} min sin dar señales`;
  return (
    `❓ Prometeo: ${why} en la tarea #${s.taskId}. ` +
    `Cuéntame en una línea con team_update cómo vas (o si estás atascado) y sigue.`
  );
}
