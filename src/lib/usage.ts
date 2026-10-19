import type { AgentUsage } from "./team";

export const EMPTY_USAGE: AgentUsage = {
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  turns: 0,
  saved_ctx: 0,
  freed: 0,
  compactions: 0,
};

/** Todo lo que pasó por el modelo: entrada, salida y caché. */
export function totalTokens(u: AgentUsage): number {
  return u.input + u.output + u.cache_read + u.cache_write;
}

/** Parte de la entrada que salió de la caché (más alta = más barata), o null sin datos. */
export function cachePct(u: AgentUsage): number | null {
  const inTotal = u.input + u.cache_read + u.cache_write;
  return inTotal > 0 ? Math.round((u.cache_read / inTotal) * 100) : null;
}

/** Suma el gasto de varios agentes. */
export function sumUsage(list: AgentUsage[]): AgentUsage {
  const out = { ...EMPTY_USAGE };
  for (const u of list) {
    for (const k of Object.keys(out) as (keyof AgentUsage)[]) out[k] += u[k] ?? 0;
  }
  return out;
}

/** El gasto de un agente sin campos que falten (estados guardados por versiones viejas). */
export function usageOf(map: Record<string, AgentUsage> | undefined, agent: string): AgentUsage | null {
  const u = map?.[agent];
  return u ? { ...EMPTY_USAGE, ...u } : null;
}
