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
  /** quiet = sin señales · tool = la misma herramienta demasiado tiempo · spin = su terminal se
   * mueve (spinner) pero no avanza en nada: una respuesta que nunca llega. */
  reason: "quiet" | "tool" | "spin";
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
  // El spinner sigue girando, así que no cuenta como silencio, pero en el hub no hay ni una señal
  // (ni herramienta, ni avance) desde hace tanto como el plazo de la herramienta: está colgado.
  const hub = Math.max(lastHubSignal(events, agent), from);
  if (hub > 0 && cfg.sameToolMs > 0 && input.termBusyMs > hub && now - hub >= cfg.sameToolMs) {
    return { agent, taskId, reason: "spin", sinceMs: hub, minutes: min(hub) };
  }
  return null;
}

/** El aviso de su tarjeta y del aviso de Windows. */
export function stallText(s: Stall): string {
  if (s.reason === "spin") return `Parece trabajar, pero lleva ${s.minutes} min sin avanzar en nada`;
  return s.reason === "tool"
    ? `Lleva ${s.minutes} min con la misma herramienta${s.tool ? ` (${s.tool.slice(0, 60)})` : ""}`
    : `Sin señales desde hace ${s.minutes} min`;
}

/** Avisos automáticos a un agente parado en la misma tarea antes de avisar al líder. */
export const AUTO_NUDGES = 2;

export type StallAction = { kind: "nudge"; n: number } | { kind: "escalate" } | null;

/**
 * Qué hacer solo con un agente parado. Si acabó su turno sin entregar (su terminal está quieta),
 * se le despierta escribiéndole; entre aviso y aviso se deja otro plazo de silencio entero. Tras
 * `AUTO_NUDGES` avisos sin que avance, se avisa una vez al líder para que la pase a otro. Con la
 * terminal trabajando o atascado en una herramienta no se le escribe encima: eso lo decides tú.
 */
export function stallAction(
  s: Stall,
  h: { now: number; busy: boolean; nudged: number; lastNudgeMs: number; escalated: boolean },
  cfg: StallConfig = STALL_CONFIG,
): StallAction {
  if (s.reason !== "quiet" || h.busy) return null;
  if (h.now - h.lastNudgeMs < cfg.quietMs) return null;
  if (h.nudged < AUTO_NUDGES) return { kind: "nudge", n: h.nudged + 1 };
  return h.escalated ? null : { kind: "escalate" };
}

/** El aviso automático para que retome su tarea (una sola línea). */
export function nudgePrompt(s: Stall): string {
  return (
    `⏰ Prometeo: llevas ${s.minutes} min sin avances en la tarea #${s.taskId} y sigue a tu nombre. ` +
    `Retómala ya (team_task_claim id ${s.taskId} te devuelve el encargo). Si es larga, escribe el archivo por partes ` +
    `y guarda a menudo para no perder trabajo. Si no puedes terminarla, dilo con team_update y ciérrala con ` +
    `team_task_done (summary «No hecha: motivo») para que la tome otro.`
  );
}

/** Al líder, cuando los avisos no bastaron (una sola línea). */
export function escalatePrompt(s: Stall, title: string): string {
  return (
    `⚠ Prometeo: ${s.agent} se ha parado en la tarea #${s.taskId} «${title.trim().replace(/\s+/g, " ")}» ` +
    `y no avanzó tras ${AUTO_NUDGES} avisos (lleva ${s.minutes} min). Decide: pásala a otro con ` +
    `team_task_handoff o asúmela tú.`
  );
}

/** Lo que se le escribe en la terminal con «Preguntarle» (una sola línea). */
export function stallPrompt(s: Stall): string {
  const why =
    s.reason === "tool"
      ? `llevas ${s.minutes} min con la misma herramienta`
      : s.reason === "spin"
        ? `llevas ${s.minutes} min trabajando sin avanzar (ni herramientas ni avances)`
        : `llevas ${s.minutes} min sin dar señales`;
  return (
    `❓ Prometeo: ${why} en la tarea #${s.taskId}. ` +
    `Cuéntame en una línea con team_update cómo vas (o si estás atascado) y sigue.`
  );
}
