import { invoke } from "./bridge";

/** Si un agente pide permiso antes de actuar («ask») o no pregunta nunca («never»). */
export type PermMode = "ask" | "never";
export type AgentPerms = Record<string, PermMode>;

export const AGENTS_WITH_PERMS = ["claude", "codex", "opencode", "antigravity"] as const;
/** OpenCode no tiene una opción para arrancar sin preguntar: siempre pide permiso. */
export const canSkipPerms = (agent: string) => agent !== "opencode";

export const agentPermsGet = () => invoke<AgentPerms | null>("agent_perms_get");
export const agentPermsSet = (perms: AgentPerms) => invoke<void>("agent_perms_set", { perms });

/**
 * Lo que había antes de este ajuste: Codex y Antigravity sin preguntar. Una instalación nueva
 * empieza pidiendo permiso a todos.
 */
export function initialPerms(existingInstall: boolean): AgentPerms {
  const out: AgentPerms = {};
  for (const a of AGENTS_WITH_PERMS) out[a] = existingInstall && (a === "codex" || a === "antigravity") ? "never" : "ask";
  return out;
}

/** ¿Ya se usaba Prometeo en este equipo? (ajustes de agentes o novedades vistas guardados). */
function hadPrometeo(): boolean {
  try {
    return ["lienzo.agentprefs.v1", "lienzo.agentapplied.v1", "lienzo.version.seen", "lienzo.autostart.v1"].some(
      (k) => localStorage.getItem(k) !== null,
    );
  } catch {
    return false;
  }
}

/** Primer arranque con este ajuste: lo guarda una vez (la ventana del PC, antes de abrir agentes). */
export async function initAgentPerms(): Promise<void> {
  try {
    if ((await agentPermsGet()) != null) return;
    await agentPermsSet(initialPerms(hadPrometeo()));
  } catch {
    /* sin ajuste guardado, Rust usa lo de siempre */
  }
}
