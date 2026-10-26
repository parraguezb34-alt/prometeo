/**
 * Juntar los avisos del líder. Cada vez que se le despierta relee su conversación entera (unos
 * 100.000 tokens), así que, si lo que espera en su buzón son entregas que revisar y nadie está
 * parado por ellas, se le dejan acumular un rato y le llegan todas en un solo aviso.
 *
 * Lógica pura (sin Tauri) para poder probarla.
 */

/** Cuánto puede esperar como mucho un aviso del líder que no corre prisa. */
export const LEADER_BATCH_MS = 4 * 60_000;
/** Con tantas entregas esperando, se le avisa ya. */
export const LEADER_BATCH_MAX = 3;

type BTask = { id: number; status: string; owner?: string; parents?: number[]; reviewer?: string };

export type LeaderBatchInput = {
  now: number;
  /** Desde cuándo tiene algo sin leer que aún no se le avisó (ms). */
  waitingSince: number;
  /** Quién le escribe: "lienzo" son los avisos de entregas; cualquier otro, un agente. */
  from: string[];
  unread: number;
  leader: string;
  tasks: BTask[];
  /** ¿Hay algún otro agente trabajando ahora mismo? */
  othersBusy: boolean;
};

/** Entregas que esperan la revisión del líder. */
function leaderReviews(tasks: BTask[], leader: string): BTask[] {
  return tasks.filter((t) => t.status === "review" && (!t.reviewer || t.reviewer === leader));
}

/**
 * ¿Hay que avisar ya al líder? Sí si le escribe un agente (puede estar parado esperando), si una
 * entrega bloquea otras tareas, si el resto del equipo no tiene nada en marcha (esperar no ahorra
 * nada), si ya se juntaron bastantes o si la más vieja lleva el tiempo máximo. Si no, se espera.
 */
export function leaderRelayDue(i: LeaderBatchInput): boolean {
  if (i.from.some((f) => f !== "lienzo")) return true;
  if (i.now - i.waitingSince >= LEADER_BATCH_MS) return true;
  if (i.unread >= LEADER_BATCH_MAX) return true;
  const reviews = leaderReviews(i.tasks, i.leader);
  const blocks = reviews.some((r) => i.tasks.some((t) => t.status !== "done" && (t.parents ?? []).includes(r.id)));
  if (blocks) return true;
  const working = i.tasks.some((t) => t.status === "claimed" && !!t.owner && t.owner !== i.leader);
  return !working && !i.othersBusy;
}
