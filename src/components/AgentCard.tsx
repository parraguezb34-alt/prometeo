import { agentColor, agentCommands, ago, HANDOVER_SAVE_PROMPT } from "../lib/team";
import type { TeamAgent, TeamEvent } from "../lib/team";

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
          📋/⚡
        </button>
      )}
      <button
        className="cc-mini-btn"
        onClick={() => onCmd(`${HANDOVER_SAVE_PROMPT}\r`, "relevo con memoria")}
        title="Relevo con memoria: guarda su resumen pegado a la tarea y lienzo compacta su contexto (sin amnesia)."
      >
        🔄
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
          🧹
        </button>
      )}
    </div>
  );
}

/** "62k", "9.4k", "820" */
function fmtTokens(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}/** "claude-opus-4-5-20260101" → "opus-4-5" */
function shortModel(m: string): string {
  return m.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

/** Mini-card of one connected agent in the sidebar. */
export function AgentCard({
  agent,
  leader,
  active,
  task,
  last,
  onSelect,
  onTerminal,
  onCrown,
  onCmd,
}: {
  agent: TeamAgent;
  leader: string;
  active: boolean;
  task?: { id: number; title: string };
  last?: TeamEvent;
  onSelect: () => void;
  onTerminal: () => void;
  onCrown: () => void;
  onCmd: (cmd: string, note: string) => void;
}) {
  const name = agent.name;
  const isLeader = leader === name;
  const ctx =
    agent.ctx_tokens != null && agent.ctx_window
      ? {
          tokens: agent.ctx_tokens,
          window: agent.ctx_window,
          pct: Math.min(100, Math.round((agent.ctx_tokens / agent.ctx_window) * 100)),
        }
      : null;
  return (
    <div
      className="cc-agent-card"
      data-active={active ? "1" : "0"}
      onClick={onSelect}
      title={`Hablar con ${name}`}
    >
      <div className="cc-agent-l1">
        <span className="agent-dot" data-on={agent.online ? "1" : "0"} />
        <span className="cc-agent-name" style={{ color: agentColor(name) }}>
          {name}
        </span>
        <button
          className="cc-crown"
          data-on={isLeader ? "1" : "0"}
          onClick={(e) => {
            e.stopPropagation();
            onCrown();
          }}
          title={isLeader ? "Es el líder (pulsa para quitarlo)" : "Hacer líder del equipo"}
        >
          {isLeader ? "👑" : "♔"}
        </button>
        <span className="cc-agent-ago">{agent.online ? ago(agent.last_seen_ms) : "offline"}</span>
        <button
          className="cc-side-term"
          onClick={(e) => {
            e.stopPropagation();
            onTerminal();
          }}
          title="Ver o lanzar su terminal aquí"
        >
          ▸_
        </button>
      </div>
      <div className="cc-agent-l2">
        <span className="cc-agent-act" title={task ? `#${task.id} ${task.title}` : last?.text}>
          {task ? `#${task.id} ${task.title}` : last ? last.text : "sin actividad aún"}
        </span>
      </div>
      {ctx && (
        <div
          className="cc-ctx"
          data-hot={ctx.pct >= 75 ? "1" : "0"}
          title={`Contexto usado: ${fmtTokens(ctx.tokens)} de ${fmtTokens(ctx.window)} tokens (${ctx.pct}%)${
            agent.model ? ` · ${agent.model}` : ""
          }`}
        >
          <div className="cc-ctx-bar">
            <i
              data-w={ctx.pct >= 80 ? "hi" : ctx.pct >= 60 ? "mid" : "ok"}
              style={{ width: `${ctx.pct}%` }}
            />
          </div>
          <span className="cc-ctx-label">
            {ctx.pct}% · {fmtTokens(ctx.tokens)}
            {ctx.pct >= 80 ? " ⚠️" : ""}
          </span>
          {agent.model ? <span className="cc-ctx-model">{shortModel(agent.model)}</span> : null}
          <button
            className="cc-ctx-refresh"
            onClick={(e) => {
              e.stopPropagation();
              onCmd(`${HANDOVER_SAVE_PROMPT}\r`, "relevo con memoria");
            }}
            title={
              ctx.pct >= 75
                ? `Contexto al ${ctx.pct}%: guarda su memoria y compacta para que baje sin amnesia.`
                : "Relevo con memoria: guarda su resumen pegado a la tarea y compacta su contexto."
            }
          >
            🔄
          </button>
        </div>
      )}
      <AgentQuickCmds agent={name} onCmd={onCmd} />
    </div>
  );
}
