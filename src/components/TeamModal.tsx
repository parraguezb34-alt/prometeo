import type { CSSProperties } from "react";
import { agentColor, agentCommands, agentInitial, agentLabel, ago, HANDOVER_SAVE_PROMPT } from "../lib/team";
import type { TeamAgent, TeamEvent } from "../lib/team";
import { ctxLevel, ctxOf, fmtTokens, shortModel } from "./AgentCard";
import { Icon } from "./Icon";

export type AgentState = "work" | "idle" | "blocked" | "off";

export function agentState(
  agent: TeamAgent,
  blocked: boolean,
  working: boolean,
): AgentState {
  if (!agent.online) return "off";
  if (blocked) return "blocked";
  return working ? "work" : "idle";
}

const STATE_LABEL: Record<AgentState, string> = {
  work: "Trabajando",
  idle: "Libre",
  blocked: "Espera tu respuesta",
  off: "Sin sesión viva",
};

/** Avatar con anillo de contexto: el anillo es el termómetro real del agente. */
export function AgentRing({
  agent,
  state,
  big = false,
}: {
  agent: TeamAgent;
  state: AgentState;
  big?: boolean;
}) {
  const ctx = ctxOf(agent);
  return (
    <span
      className="cc-ring"
      data-lvl={ctxLevel(ctx?.pct ?? null)}
      data-state={state}
      data-big={big ? "1" : "0"}
      style={{ "--ac": agentColor(agent.name), "--pp": ctx?.pct ?? 0 } as CSSProperties}
      title={`${agentLabel(agent.name)} · ${STATE_LABEL[state]}${ctx ? ` · contexto ${ctx.pct}%` : ""}`}
    >
      <span>{agentInitial(agent.name)}</span>
    </span>
  );
}

/** Los anillos de la barra superior: estado y contexto de todos de un vistazo. */
export function TeamStrip({
  agents,
  states,
  onOpen,
}: {
  agents: TeamAgent[];
  states: Map<string, AgentState>;
  onOpen: () => void;
}) {
  return (
    <button className="cc-team-btn" onClick={onOpen} aria-haspopup="dialog" title="Abrir el equipo">
      {agents.length === 0 ? (
        <span className="cc-team-empty">
          <Icon name="plus" size={14} />
          Conectar agentes
        </span>
      ) : (
        <span className="cc-rings">
          {agents.map((a) => (
            <AgentRing key={a.session_id} agent={a} state={states.get(a.name) ?? "idle"} />
          ))}
        </span>
      )}
      <span className="cc-team-lbl">Equipo</span>
      <Icon name="chev" size={14} />
    </button>
  );
}

export function TeamModal({
  agents,
  states,
  leader,
  claimedBy,
  lastByAgent,
  onClose,
  onTalk,
  onTerminal,
  onCrown,
  onCmd,
  onSettings,
}: {
  agents: TeamAgent[];
  states: Map<string, AgentState>;
  leader: string;
  claimedBy: Map<string, { id: number; title: string }>;
  lastByAgent: Map<string, TeamEvent>;
  onClose: () => void;
  onTalk: (name: string) => void;
  onTerminal: (name: string) => void;
  onCrown: (name: string) => void;
  onCmd: (name: string, cmd: string, note: string) => void;
  onSettings: () => void;
}) {
  const online = agents.filter((a) => a.online).length;
  return (
    <>
      <div className="cc-scrim" onClick={onClose} />
      <section className="cc-modal" role="dialog" aria-label="Equipo activo">
        <div className="cc-modal-top">
          <div>
            <h3>Equipo activo</h3>
            <div className="cc-modal-sub">
              {agents.length === 0
                ? "Ningún agente conectado a este proyecto"
                : `${online} de ${agents.length} en línea`}
            </div>
          </div>
          <button className="cc-icon-btn" onClick={onClose} aria-label="Cerrar" title="Cerrar (Esc)">
            <Icon name="x" />
          </button>
        </div>

        {agents.length === 0 ? (
          <div className="cc-modal-empty">
            Conecta Claude Code, OpenCode, Codex o Antigravity para empezar a trabajar en equipo.
          </div>
        ) : (
          <div className="cc-team-grid">
            {agents.map((a) => {
              const name = a.name;
              const state = states.get(name) ?? "idle";
              const ctx = ctxOf(a);
              const cmds = agentCommands(name);
              const task = claimedBy.get(name);
              const last = lastByAgent.get(name);
              const isLeader = leader === name;
              return (
                <article
                  key={a.session_id}
                  className="cc-acard"
                  data-state={state}
                  style={{ "--ac": agentColor(name) } as CSSProperties}
                >
                  <div className="cc-acard-top">
                    <AgentRing agent={a} state={state} big />
                    <div className="cc-acard-id">
                      <div className="cc-acard-name">
                        <span>{agentLabel(name)}</span>
                        {isLeader ? (
                          <button
                            className="cc-lead"
                            onClick={() => onCrown(name)}
                            title="Es el líder (pulsa para quitarlo)"
                          >
                            <Icon name="crown" size={13} />
                            Líder
                          </button>
                        ) : (
                          <button
                            className="cc-makelead"
                            onClick={() => onCrown(name)}
                            title="Hacer líder del equipo"
                          >
                            Hacer líder
                          </button>
                        )}
                      </div>
                      <div className="cc-acard-state" data-state={state}>
                        {state === "work" && task ? `Trabajando en #${task.id}` : STATE_LABEL[state]}
                      </div>
                    </div>
                  </div>

                  <div className="cc-acard-opts">
                    {cmds.model.length > 0 && (
                      <label className="cc-select" title="Cambiar modelo: se escribe en su terminal">
                        <select
                          value=""
                          onChange={(e) => {
                            const cmd = e.target.value;
                            e.target.value = "";
                            if (cmd) onCmd(name, `${cmd}\r`, cmd);
                          }}
                        >
                          <option value="">{a.model ? shortModel(a.model) : "Modelo…"}</option>
                          {cmds.model.map((m) => (
                            <option key={m.cmd} value={m.cmd}>
                              {m.label}
                            </option>
                          ))}
                        </select>
                        <Icon name="chev" size={13} />
                      </label>
                    )}
                    {cmds.modeSeq && (
                      <button
                        className="cc-btn sec"
                        onClick={() => onCmd(name, cmds.modeSeq ?? "\x1b[Z", "Shift+Tab (modo)")}
                        title="Alterna Plan/Permisos dentro de su TUI (Shift+Tab)"
                      >
                        Plan / Directo
                      </button>
                    )}
                  </div>

                  <div className="cc-ctxbig" data-lvl={ctxLevel(ctx?.pct ?? null)}>
                    <div className="cc-ctxbig-row">
                      <span>Contexto</span>
                      <b>
                        {ctx
                          ? `${fmtTokens(ctx.tokens)} de ${fmtTokens(ctx.window)} · ${ctx.pct}%`
                          : "sin medir"}
                      </b>
                    </div>
                    <div className="cc-ctxbar">
                      <i style={{ width: `${ctx?.pct ?? 0}%` }} />
                    </div>
                  </div>

                  <div className="cc-now">
                    {a.online ? <time>hace {ago(a.last_seen_ms)}</time> : <time>offline</time>}
                    <span title={task ? `#${task.id} ${task.title}` : last?.text}>
                      {task ? `#${task.id} ${task.title}` : last ? last.text : "sin actividad aún"}
                    </span>
                  </div>

                  <div className="cc-acard-act">
                    {state === "blocked" && (
                      <button className="cc-btn warn" onClick={() => onTalk(name)}>
                        Responder
                      </button>
                    )}
                    <button className="cc-btn sec" onClick={() => onTalk(name)}>
                      <Icon name="msg" size={14} />
                      Hablar
                    </button>
                    <button className="cc-btn sec" onClick={() => onTerminal(name)}>
                      <Icon name="term" size={14} />
                      Terminal
                    </button>
                    <button
                      className={ctx && ctx.pct >= 75 ? "cc-btn hot" : "cc-btn sec"}
                      onClick={() => onCmd(name, `${HANDOVER_SAVE_PROMPT}\r`, "relevo con memoria")}
                      title="Guarda su resumen pegado a la tarea y lienzo compacta su contexto (sin amnesia)"
                    >
                      <Icon name="refresh" size={14} />
                      {ctx && ctx.pct >= 75 ? "Relevo recomendado" : "Relevo"}
                    </button>
                    {cmds.compact && (
                      <button
                        className="cc-btn sec"
                        onClick={() => onCmd(name, `${cmds.compact}\r`, cmds.compact ?? "/compact")}
                        title={`Escribe ${cmds.compact} en su terminal`}
                      >
                        <Icon name="shrink" size={14} />
                        Compactar
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}

        <div className="cc-modal-foot">
          <button className="cc-btn sec" onClick={onSettings}>
            <Icon name="plus" size={14} />
            Añadir agente
          </button>
          <button className="cc-btn sec" onClick={onSettings}>
            <Icon name="shield" size={14} />
            Normas del equipo
          </button>
          <span className="cc-kbd">Esc</span>
        </div>
      </section>
    </>
  );
}
