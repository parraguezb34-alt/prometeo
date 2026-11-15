import type { PromptOption, TermPrompt } from "./prompts";

/**
 * Permisos que ya diste «para siempre». Cuando eliges una opción «siempre» en una pregunta de
 * permiso, Prometeo guarda la regla (agente + proyecto + la pregunta exacta); si el agente vuelve a
 * preguntar lo mismo (otra sesión, tras reiniciarlo…), Prometeo contesta solo. Nunca rechaza por
 * ti: si la pregunta no trae una opción para aceptar, se queda para ti.
 */
export type PermRule = {
  agent: string;
  project: string;
  /** La pregunta normalizada: título y detalle (el comando, la carpeta…). */
  key: string;
  title: string;
  detail: string[];
  createdMs: number;
};

const KEY = "lienzo.permrules.v1";
const listeners = new Set<() => void>();

const norm = (s: string) => s.toLowerCase().replace(/\\/g, "/").replace(/\s+/g, " ").trim();
const normProject = (p: string) => norm(p).replace(/\/+$/, "");

/** La clave de una pregunta: qué se pide y sobre qué (no las opciones ni su orden). */
export function ruleKey(p: Pick<TermPrompt, "title" | "detail">): string {
  return [p.title, ...p.detail].map(norm).filter(Boolean).join(" | ");
}

/** La opción que acepta: la de «siempre» si la hay; si no, la de «sí». Nunca la de rechazar. */
export function acceptOption(p: TermPrompt): PromptOption | null {
  return p.options.find((o) => o.tone === "always") ?? p.options.find((o) => o.tone === "yes") ?? null;
}

type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const defaultStore = (): Store | null => {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
};

export function loadRules(store: Store | null = defaultStore()): PermRule[] {
  try {
    const raw = store?.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as PermRule[]) : [];
    return Array.isArray(parsed) ? parsed.filter((r) => r && r.agent && r.project && r.key) : [];
  } catch {
    return [];
  }
}

function saveRules(rules: PermRule[], store: Store | null) {
  try {
    store?.setItem(KEY, JSON.stringify(rules));
  } catch {
    /* sin almacenamiento: no se recordará */
  }
  for (const l of Array.from(listeners)) l();
}

/** Guarda la regla de una pregunta que contestaste con «siempre» (sin duplicados). */
export function rememberRule(
  agent: string,
  project: string,
  p: Pick<TermPrompt, "title" | "detail">,
  store: Store | null = defaultStore(),
  now = Date.now(),
): PermRule {
  const rule: PermRule = {
    agent: agent.toLowerCase(),
    project: normProject(project),
    key: ruleKey(p),
    title: p.title,
    detail: p.detail.slice(0, 4),
    createdMs: now,
  };
  const rest = loadRules(store).filter((r) => !sameRule(r, rule));
  saveRules([rule, ...rest], store);
  return rule;
}

const sameRule = (a: Pick<PermRule, "agent" | "project" | "key">, b: Pick<PermRule, "agent" | "project" | "key">) =>
  a.agent === b.agent && a.project === b.project && a.key === b.key;

/** La regla que permite esta pregunta, si agente, proyecto y pregunta coinciden exactamente. */
export function findRule(
  agent: string,
  project: string | null,
  p: Pick<TermPrompt, "title" | "detail">,
  store: Store | null = defaultStore(),
): PermRule | null {
  if (!project) return null;
  const want = { agent: agent.toLowerCase(), project: normProject(project), key: ruleKey(p) };
  return loadRules(store).find((r) => sameRule(r, want)) ?? null;
}

export function forgetRule(rule: Pick<PermRule, "agent" | "project" | "key">, store: Store | null = defaultStore()) {
  saveRules(loadRules(store).filter((r) => !sameRule(r, rule)), store);
}

export function onRulesChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
