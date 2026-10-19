import { invoke } from "@tauri-apps/api/core";

/** Una skill de la biblioteca de lienzo (ver src-tauri/src/skills.rs). */
export type Skill = {
  name: string;
  description: string;
  category: string;
  /** "auto" = a demanda; "always" = obligatoria (va en el protocolo del equipo). */
  mode: "auto" | "always";
  enabled: boolean;
  builtin: boolean;
  locked: boolean;
  source: string;
  installed_ms: number;
};

export type SkillCategory = { id: string; label: string };
export type SkillLibrary = { categories: SkillCategory[]; skills: Skill[] };

export const skillsList = () => invoke<SkillLibrary>("skills_list");

export const skillsSet = (name: string, patch: { enabled?: boolean; mode?: Skill["mode"]; category?: string }) =>
  invoke<SkillLibrary>("skills_set", { name, ...patch });

export const skillsRemove = (name: string) => invoke<SkillLibrary>("skills_remove", { name });

export const skillsRead = (name: string) => invoke<string>("skills_read", { name });

/** Instala desde un enlace de GitHub, un enlace a un SKILL.md, una carpeta, un .zip o un SKILL.md. */
export const skillsInstall = (source: string) =>
  invoke<{ installed: string[]; library: SkillLibrary }>("skills_install", { source });

/** Colecciones conocidas que se instalan con un botón (quedan apagadas para que elijas). */
export const RECOMMENDED: { label: string; desc: string; source: string }[] = [
  {
    label: "Skills oficiales de Anthropic",
    desc: "Diseño de interfaces, pruebas de webs, documentos (PDF, Word, Excel), creador de skills…",
    source: "https://github.com/anthropics/skills",
  },
];

/** ¿Una skill de la biblioteca corresponde a lo que propuso un agente (nombre o enlace)? */
export function findSkill(lib: Skill[], source: string): Skill | undefined {
  const s = source.trim().replace(/\/+$/, "").toLowerCase();
  return lib.find((k) => k.name.toLowerCase() === s || k.source.trim().replace(/\/+$/, "").toLowerCase() === s);
}
