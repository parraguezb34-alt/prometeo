import { agentKeyFromCmd } from "./agentKey";

/**
 * Conversación de cada agente por chat. Cada chat recuerda con qué
 * conversación trabajó cada agente (su id, o «*» si el CLI no lo dice y basta
 * con «la última de la carpeta»); al reabrir el agente dentro de ese chat se
 * retoma, y un chat nuevo empieza conversaciones nuevas.
 */

/** Marca de «retomar la última conversación de la carpeta» (sin id concreto). */
export const LATEST = "*";

/** Flags de reanudar que pudo dejar un lanzamiento anterior en la línea de comandos. */
const RESUME_FLAGS = /\s+(?:--continue|--conversation\s+\S+|--resume\s+\S+|--session\s+\S+|resume\s+(?:--last|\S+))(?=\s|$)/g;

/** Id seguro para una línea de comandos (uuid, ses_…). */
function safeId(id: string): boolean {
  return /^[\w.-]{4,100}$/.test(id);
}

/**
 * La orden de lanzar un agente, retomando `ref` (id o LATEST) o, sin ref, en una
 * conversación nueva. Quita antes cualquier flag de reanudar que ya llevara.
 */
export function withResume(cmd: string, ref: string | null | undefined): string {
  const base = cmd.replace(RESUME_FLAGS, "").trimEnd();
  if (!ref) return base;
  const agent = agentKeyFromCmd(cmd);
  const id = ref !== LATEST && safeId(ref) ? ref : null;
  // «La última de la carpeta» solo vale para OpenCode: en Claude Code, Codex o Antigravity puede
  // ser la de otra sesión abierta en la misma carpeta (otra ventana, la app de escritorio).
  if (!id && agent !== "opencode") return base;
  switch (agent) {
    case "claude":
      return id ? `${base} --resume ${id}` : `${base} --continue`;
    case "antigravity":
      return id ? `${base} --conversation ${id}` : `${base} --continue`;
    case "opencode":
      return id ? `${base} --session ${id}` : `${base} --continue`;
    case "codex":
      return id ? `${base} resume ${id}` : `${base} resume --last`;
    default:
      return base;
  }
}

/** Lo que se escribe en la terminal de un agente para empezar una conversación nueva. */
export function resetCommand(agent: string): string | null {
  switch (agent) {
    case "claude":
    case "antigravity":
      return "/clear";
    case "opencode":
    case "codex":
      return "/new";
    default:
      return null;
  }
}
