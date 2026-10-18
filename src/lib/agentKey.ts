/** Map a terminal launch command to the agent id used by the hub. */
export function agentKeyFromCmd(cmd: string): string {
  const c = cmd.toLowerCase();
  if (c.includes("opencode")) return "opencode";
  if (c.includes("agy") || c.includes("antigravity")) return "antigravity";
  if (c.includes("claude")) return "claude";
  if (c.includes("codex")) return "codex";
  return c.split(/[\\/]/).pop()?.replace(/\.(exe|cmd|bat|ps1)$/i, "") || "agente";
}
