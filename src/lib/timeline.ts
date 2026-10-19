import { dayGroup } from "./chats";
import type { TeamEvent } from "./team";

/**
 * El chat como conversación por turnos, al estilo de Claude o Codex: lo que tú
 * escribes es una burbuja; lo que hace un agente seguido (trabajar, avisar,
 * contestar) se junta en un único turno con su cabecera, en vez de una tarjeta
 * suelta por evento.
 */

/** Qué le pasó a una tarea en un aviso del hub («#15 tomada por …», «#15 hecha por …: resumen»). */
/** «entregada» = hecha y a la espera de la revisión del líder (modo director). */
export type TaskOp = "creada" | "tomada" | "liberada" | "hecha" | "entregada" | "aprobada" | "borrada";
export type TaskInfo = { id: number; op: TaskOp; detail: string };

export type Part =
  | { k: "text"; key: string; e: TeamEvent }
  | { k: "work"; key: string; events: TeamEvent[] }
  | { k: "task"; key: string; e: TeamEvent; task: TaskInfo }
  | { k: "note"; key: string; e: TeamEvent }
  /** Pidió permiso o una respuesta en su terminal. */
  | { k: "ask"; key: string; e: TeamEvent }
  | { k: "images"; key: string; paths: string[]; ts: number };

export type Turn = { k: "turn"; key: string; agent: string; ts: number; lastTs: number; parts: Part[] };

export type Row =
  | { k: "day"; key: string; label: string }
  | { k: "user"; key: string; e: TeamEvent }
  | Turn
  | { k: "sys"; key: string; e: TeamEvent };

/** Acciones de bajo nivel: van plegadas en «Trabajó · N acciones». */
export const WORK_KINDS = new Set(["tool", "claim", "release"]);
/** Lo que el agente le dice a alguien: texto completo del turno. */
const TEXT_KINDS = new Set(["message", "broadcast", "reply"]);
/** Un turno sigue abierto si el mismo agente vuelve a dar señales antes de esto. */
const TURN_GAP_MS = 15 * 60_000;

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
// Con unidad (C:\…) las carpetas pueden llevar espacios («Nueva carpeta»); sin ella, no,
// para no tragarse la frase que va delante de la ruta.
const IMAGE_IN_TEXT =
  /[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n]+[\\/])*[^\\/:*?"<>|\s]+\.(?:png|jpe?g|gif|webp|bmp)\b|(?:\.{0,2}[\\/])?(?:[\w@.-]+[\\/])*[\w@.-]+\.(?:png|jpe?g|gif|webp|bmp)\b/gi;

const TASK_RE =
  /^#(\d+)\s+(creada|tomada|claimed|liberada|open|hecha|entregada|aprobada|borrada)\b(?:\s+por\s+[^\s:]+)?:?\s*([\s\S]*)$/i;

/** Aviso automático del despachador de lienzo («📌 Despacho: #15 «…»»). */
export function isDispatch(e: TeamEvent): boolean {
  return e.agent === "tú" && e.text.startsWith("📌 Despacho");
}

/** «Claude is waiting for your input»: Claude Code lo manda tras un minuto quieto con el turno ya
 * terminado. No pide nada; en el chat sobra. */
export function isIdle(e: TeamEvent): boolean {
  return e.kind === "waiting" && /waiting for your input/i.test(e.text);
}

/** Aviso de un agente que no pide nada aunque llegue como «waiting» («login successful», inactividad). */
export function isNotice(e: TeamEvent): boolean {
  return e.kind === "waiting" && (/successful/i.test(e.text) || isIdle(e));
}

/** Qué pide un agente, en castellano («Claude needs your permission to use Bash» → «permiso para usar Bash»). */
export function askPhrase(text: string): string {
  const perm = /permission to use ([\w.:-]+)/i.exec(text);
  if (perm) return `permiso para usar ${perm[1]}`;
  if (/waiting for your input|needs your (input|attention)/i.test(text)) return "tu respuesta";
  return text;
}

/** Lee un aviso de tarea del hub. */
export function parseTask(e: TeamEvent): TaskInfo | null {
  if (e.kind !== "task") return null;
  const m = TASK_RE.exec(e.text.trim());
  if (!m) return null;
  const raw = m[2].toLowerCase();
  const op: TaskOp = raw === "claimed" ? "tomada" : raw === "open" ? "liberada" : (raw as TaskOp);
  return { id: Number(m[1]), op, detail: m[3].trim() };
}

export function isImagePath(p: string): boolean {
  return IMAGE_RE.test(p.trim());
}

/** Imágenes que menciona un evento: sus archivos y las rutas escritas en el texto. */
export function eventImages(e: TeamEvent): string[] {
  const out = e.files.filter(isImagePath);
  for (const m of e.text.matchAll(IMAGE_IN_TEXT)) {
    const p = m[0].trim();
    if (!out.some((x) => samePath(x, p))) out.push(p);
  }
  return out;
}

/** Misma imagen aunque una ruta sea absoluta y la otra relativa al proyecto. */
export function samePath(a: string, b: string): boolean {
  const n = (s: string) => s.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  const x = n(a);
  const y = n(b);
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

/**
 * Un agente suele contar lo mismo dos veces: cierra la tarea («#14 hecha por …: resumen») y
 * publica un progreso («Tarea #14 completada: …»). En un mismo turno sobra el progreso.
 */
function dropEchoes(t: Turn) {
  // Su respuesta en terminal que solo repite (cita) el mensaje que acaba de mandar: sobra.
  const said = t.parts
    .filter((p): p is Extract<Part, { k: "text" }> => p.k === "text" && p.e.kind !== "reply")
    .map((p) => p.e.text.replace(/\s+/g, " ").slice(0, 60))
    .filter((s) => s.length >= 20);
  if (said.length > 0) {
    t.parts = t.parts.filter(
      (p) => !(p.k === "text" && p.e.kind === "reply" && said.some((s) => p.e.text.replace(/\s+/g, " ").includes(s))),
    );
  }
  const done = new Set<number>();
  for (const p of t.parts) if (p.k === "task" && p.task.op === "hecha") done.add(p.task.id);
  if (done.size === 0) return;
  t.parts = t.parts.filter((p) => {
    if (p.k !== "note" || p.e.kind !== "update") return true;
    const ids = [...p.e.text.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
    return !ids.some((id) => done.has(id));
  });
}

export function buildTimeline(events: TeamEvent[]): Row[] {
  const rows: Row[] = [];
  let turn: Turn | null = null;
  let day = "";

  for (const e of events) {
    if (isIdle(e)) continue;
    const label = dayGroup(e.ts_ms);
    if (label !== day) {
      day = label;
      rows.push({ k: "day", key: `d${e.ts_ms}`, label });
      turn = null;
    }
    const key = `${e.seq}`;

    if (e.agent === "tú") {
      turn = null;
      // Los despachos los escribe lienzo en tu nombre: son un aviso, no un mensaje tuyo.
      const mine = TEXT_KINDS.has(e.kind) && !isDispatch(e);
      rows.push(mine ? { k: "user", key, e } : { k: "sys", key, e });
      continue;
    }
    // Imagen nueva en el proyecto que ningún agente reclamó.
    if (!e.agent) {
      turn = null;
      rows.push({ k: "sys", key, e });
      continue;
    }

    const cur = turn as Turn | null;
    let t: Turn;
    if (cur && cur.agent === e.agent && e.ts_ms - cur.lastTs < TURN_GAP_MS) {
      t = cur;
    } else {
      t = { k: "turn", key: `t${key}`, agent: e.agent, ts: e.ts_ms, lastTs: e.ts_ms, parts: [] };
      rows.push(t);
      turn = t;
    }
    t.lastTs = e.ts_ms;
    const last = t.parts[t.parts.length - 1];
    const task = parseTask(e);

    if (e.kind === "image") {
      if (last?.k === "images") last.paths.push(...e.files);
      else t.parts.push({ k: "images", key: `i${key}`, paths: [...e.files], ts: e.ts_ms });
    } else if (WORK_KINDS.has(e.kind)) {
      if (last?.k === "work") last.events.push(e);
      else t.parts.push({ k: "work", key: `w${key}`, events: [e] });
    } else if (TEXT_KINDS.has(e.kind)) {
      t.parts.push({ k: "text", key, e });
    } else if (task) {
      t.parts.push({ k: "task", key, e, task });
    } else if (e.kind === "waiting" && !isNotice(e)) {
      t.parts.push({ k: "ask", key, e });
    } else {
      t.parts.push({ k: "note", key, e });
    }
  }
  for (const r of rows) if (r.k === "turn") dropEchoes(r);
  return rows;
}

/** «12 s», «3 min», «1 h 5 min». */
export function span(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** Cronómetro «0:42», «12:05». */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}
