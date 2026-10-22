/**
 * Cuándo le toca a una tarea programada. El hub guarda la frecuencia tal como se escribió («cada día
 * 9:00», «lun-vie 8:30», «cada 2 h»); aquí se calcula la próxima vez con la hora local.
 *
 * Lógica pura (sin Tauri) para poder probarla. Debe entender lo mismo que `validate_every` del hub.
 */

export type Spec = { kind: "interval"; mins: number } | { kind: "days"; days: boolean[]; h: number; m: number };

/** Índices lunes = 0 … domingo = 6. */
const DAYS = ["lun", "mar", "mie", "jue", "vie", "sab", "dom"];

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function dayIndex(tok: string): number {
  return tok.length >= 3 ? DAYS.findIndex((d) => tok.startsWith(d)) : -1;
}

function time(t: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(t);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  return h < 24 && mm < 60 ? { h, m: mm } : null;
}

/** Entiende la frecuencia, o null si no. */
export function parseEvery(raw: string): Spec | null {
  const s = norm(raw);
  if (s.startsWith("cada ")) {
    const rest = s.slice(5);
    if (rest.startsWith("dia ")) {
      const t = time(rest.slice(4));
      return t ? { kind: "days", days: Array(7).fill(true), ...t } : null;
    }
    const m = /^(\d+) (min|h)/.exec(rest);
    if (!m) return null;
    const mins = Number(m[1]) * (m[2] === "h" ? 60 : 1);
    return mins >= 15 ? { kind: "interval", mins } : null;
  }
  const cut = s.lastIndexOf(" ");
  if (cut < 0) return null;
  const t = time(s.slice(cut + 1));
  const days = s.slice(0, cut);
  if (!t) return null;
  if (["diario", "todos los dias", "cada dia"].includes(days)) return { kind: "days", days: Array(7).fill(true), ...t };
  if (days === "laborables") return { kind: "days", days: [true, true, true, true, true, false, false], ...t };
  const on = Array(7).fill(false);
  for (const part of days.split(/[ ,]+/).filter((p) => p && p !== "y")) {
    const [a, b] = part.split("-");
    const i = dayIndex(a);
    const j = b === undefined ? i : dayIndex(b);
    if (i < 0 || j < 0) return null;
    for (let k = i; ; k = (k + 1) % 7) {
      on[k] = true;
      if (k === j) break;
    }
  }
  return on.some(Boolean) ? { kind: "days", days: on, ...t } : null;
}

/** La primera vez que le toca después de `base` (ms epoch, hora local). */
export function nextRun(spec: Spec, base: number): number {
  if (spec.kind === "interval") return base + spec.mins * 60_000;
  const d = new Date(base);
  d.setSeconds(0, 0);
  for (let i = 0; i < 8; i++) {
    const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, spec.h, spec.m, 0, 0);
    const idx = (c.getDay() + 6) % 7; // getDay: domingo = 0
    if (spec.days[idx] && c.getTime() > base) return c.getTime();
  }
  return base + 7 * 86_400_000;
}

/** «2026-10-22» en hora local: el día del tope diario. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export type SchedLite = { id: number; status: string; every: string; approved_ms: number; last_ms: number; project: string };

/** ¿Le toca ahora? (activa, del proyecto abierto y con su hora ya pasada). */
export function isDue(s: SchedLite, now: number, projectKey: string): boolean {
  if (s.status !== "active") return false;
  // Misma clave que `projectKey` (lib/project): minúsculas, «/» y sin barra final.
  if (s.project && s.project.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() !== projectKey) return false;
  const spec = parseEvery(s.every);
  if (!spec) return false;
  const base = s.last_ms || s.approved_ms;
  return base > 0 && nextRun(spec, base) <= now;
}

/** Lo que hace falta de un chat (lib/chats): su ventana de tiempo. */
export type ChatWindow = { id: string; kind: string; title: string; startMs: number; endMs?: number };

/** El chat del equipo en cuya ventana cae `ms` (donde se pidió o se creó algo), o null. */
export function chatAt<T extends ChatWindow>(chats: T[], ms: number): T | null {
  return chats.find((c) => c.kind === "team" && c.startMs <= ms && (c.endMs == null || ms < c.endMs)) ?? null;
}

/** Orden de la sección: primero lo que espera tu OK, luego las activas por su próxima hora, las
 * pausadas y, al final, las de otros proyectos. */
export function scheduleOrder<T extends SchedLite & { title: string }>(list: T[], now: number, projectKey: string): T[] {
  const rank = (s: T) => {
    const mine = !s.project || s.project.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === projectKey;
    if (!mine) return 3;
    return s.status === "pending" ? 0 : s.status === "active" ? 1 : 2;
  };
  const next = (s: T) => {
    const spec = parseEvery(s.every);
    const base = s.last_ms || s.approved_ms || now;
    return spec ? nextRun(spec, base) : Number.MAX_SAFE_INTEGER;
  };
  return list.slice().sort((a, b) => rank(a) - rank(b) || next(a) - next(b) || a.id - b.id);
}
