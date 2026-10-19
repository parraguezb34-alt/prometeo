import { invoke } from "@tauri-apps/api/core";
import type { TeamClaim, TeamEvent, TeamTask } from "./team";

// Historial del proyecto: una entrada por entrega de tarea (sus archivos tal como quedaron),
// para ver qué cambió y deshacerlo o rehacerlo. Vive en `.lienzo/historial` (ver history.rs).

export type HFile = { path: string; status: "A" | "M" | "D" | string };

export type HEntry = {
  id: string;
  ts_ms: number;
  title: string;
  kind: "inicio" | "entrega" | "deshacer" | "rehacer" | "manual" | string;
  task: number | null;
  by: string;
  target: string;
  files: HFile[];
  files_total: number;
  undone: boolean;
};

export type HList = { entries: HEntry[]; pending: HFile[] };
export type HDiff = { diff: string; truncated: boolean };
export type HOutcome = { done: boolean; message: string; warnings: string[] };

export const historyList = (path: string) => invoke<HList>("history_list", { path });

/** Cambios de una entrada; `id` = «pending» para los que aún no están guardados. */
export const historyDiff = (path: string, id: string) => invoke<HDiff>("history_diff", { path, id });

/** Deshace (o rehace) una entrada. Sin `force`, si hay motivos para pensárselo los devuelve sin tocar nada. */
export const historyRevert = (path: string, id: string, redo: boolean, force: boolean) =>
  invoke<HOutcome>("history_revert", { path, id, redo, force });

export const historySave = (path: string, title: string) => invoke<string>("history_save", { path, title });

/** Archivos asociados a una tarea: reclamos y avisos de su dueño desde que nació. */
export function taskPaths(task: TeamTask, events: TeamEvent[], claims: TeamClaim[]): string[] {
  const set = new Set<string>();
  if (task.owner) {
    for (const c of claims) {
      if (c.agent === task.owner && c.ts_ms >= task.created_ms) set.add(c.path);
    }
    for (const e of events) {
      if (e.agent !== task.owner || e.ts_ms < task.created_ms) continue;
      for (const f of e.files) set.add(f);
    }
  }
  return [...set].sort();
}

/** +añadidas / −quitadas por archivo, contadas del propio diff. */
export function diffStats(diff: string): Map<string, { a: number; d: number }> {
  const stats = new Map<string, { a: number; d: number }>();
  let cur: string | null = null;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const m = / b\/(.+)$/.exec(line);
      cur = m ? m[1] : null;
      if (cur && !stats.has(cur)) stats.set(cur, { a: 0, d: 0 });
      continue;
    }
    if (!cur || line.startsWith("+++") || line.startsWith("---")) continue;
    const s = stats.get(cur)!;
    if (line.startsWith("+")) s.a++;
    else if (line.startsWith("-")) s.d++;
  }
  return stats;
}

/** El diff de un archivo concreto dentro de un diff de varios. */
export function diffOf(diff: string, path: string): string {
  const parts = diff.split(/^(?=diff --git )/m);
  return parts.find((p) => p.split("\n", 1)[0].endsWith(` b/${path}`)) ?? "";
}
