import { agentCommands, HANDOVER_SAVE_PROMPT } from "../lib/team";
import type { TeamAgent } from "../lib/team";
import { Icon } from "./Icon";

/** Model selector + mode/compact/relevo buttons for one agent. Everything here
 * is typed into the agent's terminal (per-CLI commands we know are safe). */
export function AgentQuickCmds({
  agent,
  onCmd,
  withEsc = false,
}: {
  agent: string;
  onCmd: (cmd: string, note: string) => void;
  withEsc?: boolean;
}) {
  const cmds = agentCommands(agent);
  return (
    <div className="cc-cmds" onClick={(e) => e.stopPropagation()}>
      {withEsc && (
        <button
          className="cc-mini-btn"
          onClick={() => onCmd("\x1b", "Esc (pausar)")}
          title="Envía Esc: pausa o cancela lo que esté haciendo"
        >
          ⎋ Esc
        </button>
      )}
      {cmds.model.length > 0 && (
        <select
          className="cc-mini-select"
          value=""
          title="Cambiar modelo: se escribe el comando en su terminal"
          onChange={(e) => {
            const cmd = e.target.value;
            e.target.value = "";
            if (cmd) onCmd(`${cmd}\r`, cmd);
          }}
        >
          <option value="">Modelo…</option>
          {cmds.model.map((m) => (
            <option key={m.cmd} value={m.cmd}>
              {m.label}
            </option>
          ))}
        </select>
      )}
      {cmds.modeSeq && (
        <button
          className="cc-mini-btn"
          onClick={() => onCmd(cmds.modeSeq ?? "\x1b[Z", "Shift+Tab (modo)")}
          title="Alterna Plan/Permisos dentro de su TUI (Shift+Tab)"
        >
          Plan/Directo
        </button>
      )}
      <button
        className="cc-mini-btn"
        onClick={() => onCmd(`${HANDOVER_SAVE_PROMPT}\r`, "relevo con memoria")}
        title="Relevo con memoria: guarda su resumen pegado a la tarea y lienzo compacta su contexto (sin amnesia)."
      >
        <Icon name="refresh" size={13} />
      </button>
      {cmds.compact && (
        <button
          className="cc-mini-btn"
          onClick={() => {
            const cmd = cmds.compact;
            if (cmd) onCmd(`${cmd}\r`, cmd);
          }}
          title={`Escribe ${cmds.compact ?? "/compact"} en su terminal`}
        >
          <Icon name="shrink" size={13} />
        </button>
      )}
    </div>
  );
}

/** "62k", "9.4k", "820" */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

/** "claude-opus-4-5-20260101" → "opus-4-5" */
export function shortModel(m: string): string {
  return m.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

/** Contexto real del agente (telemetría del puente), o null si no se puede medir. */
export function ctxOf(agent: TeamAgent): { tokens: number; window: number; pct: number } | null {
  if (agent.ctx_tokens == null || !agent.ctx_window) return null;
  return {
    tokens: agent.ctx_tokens,
    window: agent.ctx_window,
    pct: Math.min(100, Math.round((agent.ctx_tokens / agent.ctx_window) * 100)),
  };
}

/** Nivel del termómetro: ok / warn / err (o none si no hay medida). */
export function ctxLevel(pct: number | null): "ok" | "warn" | "err" | "none" {
  if (pct == null) return "none";
  return pct >= 80 ? "err" : pct >= 60 ? "warn" : "ok";
}
