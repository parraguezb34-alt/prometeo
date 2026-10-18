import { dayGroup } from "./chats";
import type { TeamEvent } from "./team";

/**
 * El chat como conversación por turnos, al estilo de Claude o Codex: lo que tú
 * escribes es una burbuja; lo que hace un agente seguido (trabajar, avisar,
 * contestar) se junta en un único turno con su cabecera, en vez de una tarjeta
 * suelta por evento.
 */
export type Part =
  | { k: "text"; key: string; e: TeamEvent }
  | { k: "work"; key: string; events: TeamEvent[] }
  | { k: "note"; key: string; e: TeamEvent }
  | { k: "images"; key: string; paths: string[]; ts: number };

export type Row =
  | { k: "day"; key: string; label: string }
  | { k: "user"; key: string; e: TeamEvent }
  | { k: "turn"; key: string; agent: string; ts: number; lastTs: number; parts: Part[] }
  | { k: "alert"; key: string; e: TeamEvent }
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

/** Aviso automático del despachador de lienzo («📌 Despacho: #15 «…»»). */
export function isDispatch(e: TeamEvent): boolean {
  return e.agent === "tú" && e.text.startsWith("📌 Despacho");
}

/** Aviso de un agente que no pide nada aunque llegue como «waiting» («login successful»). */
export function isNotice(e: TeamEvent): boolean {
  return e.kind === "waiting" && /successful/i.test(e.text);
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

export function buildTimeline(events: TeamEvent[]): Row[] {
  const rows: Row[] = [];
  let turn: Extract<Row, { k: "turn" }> | null = null;
  let day = "";

  const close = () => {
    turn = null;
  };

  for (const e of events) {
    const label = dayGroup(e.ts_ms);
    if (label !== day) {
      day = label;
      rows.push({ k: "day", key: `d${e.ts_ms}`, label });
      close();
    }
    const key = `${e.seq}`;

    if (e.agent === "tú") {
      close();
      // Los despachos los escribe lienzo en tu nombre: son un aviso, no un mensaje tuyo.
      const mine = TEXT_KINDS.has(e.kind) && !isDispatch(e);
      rows.push(mine ? { k: "user", key, e } : { k: "sys", key, e });
      continue;
    }
    if (e.kind === "waiting" && !isNotice(e)) {
      close();
      rows.push({ k: "alert", key, e });
      continue;
    }
    // Imagen nueva en el proyecto que ningún agente reclamó.
    if (!e.agent) {
      close();
      rows.push({ k: "sys", key, e });
      continue;
    }

    const cur = turn as Extract<Row, { k: "turn" }> | null;
    let t: Extract<Row, { k: "turn" }>;
    if (cur && cur.agent === e.agent && e.ts_ms - cur.lastTs < TURN_GAP_MS) {
      t = cur;
    } else {
      t = { k: "turn", key: `t${key}`, agent: e.agent, ts: e.ts_ms, lastTs: e.ts_ms, parts: [] };
      rows.push(t);
      turn = t;
    }
    t.lastTs = e.ts_ms;
    const last = t.parts[t.parts.length - 1];

    if (e.kind === "image") {
      if (last?.k === "images") last.paths.push(...e.files);
      else t.parts.push({ k: "images", key: `i${key}`, paths: [...e.files], ts: e.ts_ms });
    } else if (WORK_KINDS.has(e.kind)) {
      if (last?.k === "work") last.events.push(e);
      else t.parts.push({ k: "work", key: `w${key}`, events: [e] });
    } else if (TEXT_KINDS.has(e.kind)) {
      t.parts.push({ k: "text", key, e });
    } else {
      t.parts.push({ k: "note", key, e });
    }
  }
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
