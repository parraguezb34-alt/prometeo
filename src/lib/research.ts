import { invoke } from "@tauri-apps/api/core";

// Investigación con el equipo: Prometeo crea las tareas encadenadas y cada agente busca con sus
// propias herramientas web. Aquí: llamadas al backend, la fase de cada investigación y la
// cobertura de fuentes (para no dar por bueno un informe con una sola fuente secundaria).

export type ResearchMode = "rapida" | "profunda";
export type ResearchFile = { name: string; size: number; mtime_ms: number };
export type Research = {
  id: string;
  question: string;
  mode: ResearchMode;
  created_ms: number;
  tasks: number[];
  roles: string[];
  agents: string[];
  files: ResearchFile[];
};

export const researchStart = (project: string, question: string, mode: ResearchMode, leader: string, workers: string[]) =>
  invoke<Research>("research_start", { project, question, mode, leader, workers });
export const researchList = (project: string) => invoke<Research[]>("research_list", { project });
export const researchRead = (project: string, id: string, file: string) =>
  invoke<string>("research_read", { project, id, file });
export const researchRemove = (project: string, id: string) => invoke<void>("research_remove", { project, id });

export const researchDir = (id: string) => `.lienzo/investigaciones/${id}`;

/** Lo mínimo de una tarea que hace falta para saber en qué va. */
export type RTask = { id: number; status: string; owner?: string };

export type Phase = { key: string; label: string; state: "done" | "now" | "wait"; who?: string };

/** Cómo se llama cada fase ya terminada. */
const DONE: Record<string, string> = {
  rapida: "Investigado",
  plan: "Plan listo",
  parte: "Partes investigadas",
  verificar: "Fuentes verificadas",
  informe: "Informe listo",
};

const LABEL: Record<string, string> = {
  rapida: "Investigando",
  plan: "Planeando",
  parte: "Investigando",
  verificar: "Verificando fuentes",
  informe: "Escribiendo el informe",
};

/**
 * Las fases de una investigación según sus tareas: las partes en paralelo cuentan como una sola
 * fase («Investigando 1/2»).
 */
export function phasesOf(r: Pick<Research, "tasks" | "roles" | "agents">, tasks: RTask[]): Phase[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const groups: { key: string; ids: number[]; agents: string[] }[] = [];
  r.roles.forEach((role, i) => {
    const last = groups[groups.length - 1];
    if (last && last.key === role) {
      last.ids.push(r.tasks[i]);
      last.agents.push(r.agents[i]);
    } else groups.push({ key: role, ids: [r.tasks[i]], agents: [r.agents[i]] });
  });
  return groups.map((g) => {
    const st = g.ids.map((id) => byId.get(id)?.status ?? "missing");
    const done = st.filter((s) => s === "done").length;
    const working = st.some((s) => s === "claimed" || s === "review");
    const all = done === g.ids.length;
    let label = (all ? DONE[g.key] : LABEL[g.key]) ?? g.key;
    if (g.ids.length > 1 && !all) label += ` ${done}/${g.ids.length}`;
    return {
      key: g.key,
      label,
      state: all ? "done" : working ? "now" : "wait",
      who: g.agents.filter((a, i, l) => a && l.indexOf(a) === i).join(", "),
    };
  });
}

/** Estado general: «lista» cuando el informe está y su tarea, hecha. */
export function overall(r: Research, tasks: RTask[]): "lista" | "en-curso" | "parada" {
  const ph = phasesOf(r, tasks);
  if (ph.length > 0 && ph.every((p) => p.state === "done")) return "lista";
  const known = new Set(tasks.map((t) => t.id));
  if (r.tasks.some((id) => !known.has(id))) return "parada";
  return "en-curso";
}

export type SourceKind = "oficial" | "primaria" | "secundaria" | "comunidad" | "comercial" | "otra";
export type Coverage = { total: number; byKind: Record<SourceKind, number>; strong: number; ok: boolean; why: string };

const KINDS: SourceKind[] = ["oficial", "primaria", "secundaria", "comunidad", "comercial"];

/** «2 oficiales», «1 primaria», «3 de comunidad». */
export function kindCount(kind: SourceKind, n: number): string {
  const many: Record<SourceKind, string> = {
    oficial: "oficiales",
    primaria: "primarias",
    secundaria: "secundarias",
    comunidad: "de comunidad",
    comercial: "comerciales",
    otra: "otras",
  };
  return `${n} ${n === 1 ? (kind === "comunidad" ? "de comunidad" : kind) : many[kind]}`;
}

/**
 * Cuenta las fuentes de un .md (líneas «[n] Título — URL — tipo — …»), sin repetir URLs.
 * La puerta: ≥ 2 fuentes y ≥ 1 oficial o primaria (o ≥ 4 fuentes si no hay ninguna).
 */
export function coverage(text: string): Coverage {
  const seen = new Map<string, SourceKind>();
  for (const line of text.split(/\r?\n/)) {
    const url = /https?:\/\/[^\s)>\]|`]+/.exec(line)?.[0]?.replace(/[.,;]+$/, "");
    if (!url || !/^\s*(?:[-*]\s*)?\[?\d{1,3}[\]).]/.test(line)) continue;
    const key = url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "").toLowerCase();
    const low = line.toLowerCase();
    const kind = KINDS.find((k) => new RegExp(`(^|[^a-záéíóú])${k}`).test(low.replace(url.toLowerCase(), ""))) ?? "otra";
    if (!seen.has(key) || seen.get(key) === "otra") seen.set(key, kind);
  }
  const byKind = { oficial: 0, primaria: 0, secundaria: 0, comunidad: 0, comercial: 0, otra: 0 } as Record<SourceKind, number>;
  for (const k of seen.values()) byKind[k]++;
  const total = seen.size;
  const strong = byKind.oficial + byKind.primaria;
  const ok = total >= 2 && (strong >= 1 || total >= 4);
  const why =
    total === 0
      ? "Sin fuentes citadas."
      : total < 2
        ? "Solo 1 fuente: falta contrastarla."
        : strong === 0 && total < 4
          ? "Ninguna fuente oficial o primaria."
          : "";
  return { total, byKind, strong, ok, why };
}

/** El archivo que mejor muestra lo hecho hasta ahora (el informe si ya está). */
export function bestFile(r: Research): string | null {
  const names = r.files.map((f) => f.name);
  for (const n of ["informe.md", "verificacion.md", "plan.md", "fuentes.md"]) if (names.includes(n)) return n;
  return names.find((n) => n.startsWith("hallazgos-")) ?? null;
}

const FILE_ES: Record<string, string> = {
  "informe.md": "Informe",
  "verificacion.md": "Verificación",
  "plan.md": "Plan",
  "fuentes.md": "Fuentes",
};
export function fileLabel(name: string): string {
  if (FILE_ES[name]) return FILE_ES[name];
  const m = /^hallazgos-(.+)\.md$/.exec(name);
  return m ? `Hallazgos · ${m[1]}` : name.replace(/\.md$/, "");
}
