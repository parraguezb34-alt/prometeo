import type { IconName } from "../components/Icon";
import { shortPath } from "./team";
import type { TeamEvent } from "./team";

/**
 * Una acción de trabajo de un agente («Editó src/app.ts», «Ejecutó npm test»), leída de los
 * avisos de sus hooks. La usan el chat (plegada en «Trabajó») y el panel de actividad.
 */
export type Step = { icon: IconName; verb: string; detail: string; path?: string };

const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;

export function stepOf(e: TeamEvent): Step {
  if (e.kind === "claim")
    return { icon: "lock", verb: "Reservó", detail: e.files.map(shortPath).join(", ") || e.text };
  if (e.kind === "release")
    return { icon: "lock", verb: "Liberó", detail: e.files.map(shortPath).join(", ") || e.text };
  const m = /^(\S+)\s*([\s\S]*)$/.exec(e.text);
  const tool = m?.[1] ?? "";
  const rest = m?.[2] ?? "";
  const path = e.files[0];
  if (tool === "Bash") return { icon: "term", verb: "Ejecutó", detail: rest };
  if (tool === "Write") return { icon: "plus", verb: "Creó", detail: rest, path };
  if (/^(Edit|MultiEdit|NotebookEdit)$/.test(tool))
    return { icon: "pencil", verb: "Editó", detail: rest, path };
  if (/screenshot/i.test(tool) || (tool === "Read" && IMAGE.test(path ?? rest)))
    return { icon: "eye", verb: "Miró", detail: rest, path };
  if (tool === "Read") return { icon: "file", verb: "Leyó", detail: rest, path };
  if (tool === "Search") return { icon: "search", verb: "Buscó", detail: rest };
  if (tool === "Web") return { icon: "search", verb: "Consultó", detail: rest };
  return { icon: "pulse", verb: tool || "Acción", detail: rest, path };
}

const DOING: Record<string, string> = {
  Ejecutó: "Ejecutando",
  Creó: "Creando",
  Editó: "Editando",
  Miró: "Mirando",
  Leyó: "Leyendo",
  Buscó: "Buscando",
  Consultó: "Consultando",
  Reservó: "Reservando",
  Liberó: "Liberando",
};

/** Lo que está haciendo ahora, a partir de su última acción («Bash npm test» → «Ejecutando npm test»). */
export function doingOf(action: string, files: string[] = []): Step {
  const s = stepOf({ seq: 0, ts_ms: 0, agent: "", session_id: "", kind: "tool", text: action, files });
  const target = s.path ? shortPath(s.path) : /^[^\s]+[\\/][^\s]+$/.test(s.detail) ? shortPath(s.detail) : s.detail;
  return { ...s, verb: DOING[s.verb] ?? s.verb, detail: target };
}

/**
 * La frase de estado de su CLI, en castellano. Claude improvisa gerundios («Pondering…»,
 * «Flibbertigibbeting…»): los conocidos se traducen y el resto queda en «Pensando…».
 */
export function statusEs(status: string): string {
  const s = status.trim().replace(/[.…]+$/, "");
  if (!s) return "";
  const known: Record<string, string> = {
    thinking: "Pensando",
    pondering: "Pensando",
    generating: "Escribiendo",
    writing: "Escribiendo",
    reading: "Leyendo",
    "reading file": "Leyendo",
    searching: "Buscando",
    running: "Ejecutando",
    working: "Trabajando",
    planning: "Planificando",
    compacting: "Resumiendo su memoria",
    "compacting conversation": "Resumiendo su memoria",
  };
  const k = s.toLowerCase();
  if (known[k]) return `${known[k]}…`;
  if (/^[a-z]+ing$/i.test(s)) return "Pensando…";
  return `${s}…`;
}

/** «editó 3 archivos · 4 comandos · miró 1 imagen» */
export function workSummary(events: TeamEvent[]): string {
  const edited = new Set<string>();
  let cmds = 0;
  let looks = 0;
  const read = new Set<string>();
  let claims = 0;
  let releases = 0;
  let searches = 0;
  for (const e of events) {
    const s = stepOf(e);
    if (s.icon === "pencil" || s.icon === "plus") edited.add(s.path ?? s.detail);
    else if (s.icon === "term") cmds++;
    else if (s.icon === "eye") looks++;
    else if (s.verb === "Leyó") read.add(s.path ?? s.detail);
    else if (s.icon === "search") searches++;
    else if (e.kind === "claim") claims++;
    else if (e.kind === "release") releases++;
  }
  const bits: string[] = [];
  if (edited.size) bits.push(`editó ${edited.size} ${edited.size === 1 ? "archivo" : "archivos"}`);
  if (read.size) bits.push(`leyó ${read.size} ${read.size === 1 ? "archivo" : "archivos"}`);
  if (cmds) bits.push(`${cmds} ${cmds === 1 ? "comando" : "comandos"}`);
  if (searches) bits.push(`${searches} ${searches === 1 ? "búsqueda" : "búsquedas"}`);
  if (looks) bits.push(`miró ${looks} ${looks === 1 ? "imagen" : "imágenes"}`);
  if (claims) bits.push(`reservó ${claims === 1 ? "archivos" : `archivos ${claims} veces`}`);
  if (releases) bits.push("liberó sus archivos");
  return bits.join(" · ");
}
