import type { CSSProperties } from "react";
import { agentColor, agentCommands, agentInitial, agentLabel, ago, HANDOVER_SAVE_PROMPT } from "../lib/team";
import type { ModelCatalog, TeamAgent, TeamEvent } from "../lib/team";
import type { AgentPref } from "../lib/agentPrefs";
import { confirmChoice } from "../lib/pty";
import { ctxLevel, ctxOf, fmtTokens, shortModel } from "./AgentCard";
import { Icon } from "./Icon";

/** work = con tarea · idle = libre · blocked = espera tu respuesta · starting = terminal abierta, aún sin conectar · off = sin sesión */
export type AgentState = "work" | "idle" | "blocked" | "starting" | "off";

export function agentState(
  agent: TeamAgent,
  blocked: boolean,
  working: boolean,
  hasTerminal = false,
): AgentState {
  if (!agent.online) return hasTerminal ? "starting" : "off";
  if (blocked) return "blocked";
  return working ? "work" : "idle";
}

const STATE_LABEL: Record<AgentState, string> = {
  work: "Trabajando",
  idle: "Libre",
  blocked: "Espera tu respuesta",
  starting: "Conectando…",
  off: "Sin sesión",
};

const EFFORT_LABEL: Record<string, string> = {
  minimal: "Mínimo",
  low: "Bajo",
  medium: "Medio",
  high: "Alto",
  xhigh: "Muy alto",
  max: "Máximo",
  ultra: "Ultra",
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
          Buscar agentes
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
  catalogs,
  prefs,
  applied,
  busy,
  startedAt,
  tails,
  autoStart,
  onClose,
  onTalk,
  onTerminal,
  onCrown,
  onCmd,
  onPref,
  onApply,
  onStart,
  onRestart,
  onAutoStart,
  onSettings,
}: {
  agents: TeamAgent[];
  states: Map<string, AgentState>;
  leader: string;
  claimedBy: Map<string, { id: number; title: string }>;
  lastByAgent: Map<string, TeamEvent>;
  /** Modelos por agente: undefined = sin pedir, null = cargando. */
  catalogs: Record<string, ModelCatalog | null | undefined>;
  prefs: Record<string, AgentPref>;
  /** Lo último que se aplicó a la sesión de cada agente. */
  applied: Record<string, AgentPref | undefined>;
  busy: string | null;
  /** Cuándo se vio por primera vez la terminal de cada agente aún sin conectar. */
  startedAt: Record<string, number>;
  /** Final de la terminal de los agentes que aún no se conectan. */
  tails: Record<string, string>;
  autoStart: boolean;
  onClose: () => void;
  onTalk: (name: string) => void;
  onTerminal: (name: string) => void;
  onCrown: (name: string) => void;
  onCmd: (name: string, cmd: string, note: string) => void;
  onPref: (name: string, patch: AgentPref) => void;
  onApply: (name: string) => void;
  onStart: (name: string) => void;
  onRestart: (name: string) => void;
  onAutoStart: (on: boolean) => void;
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
                ? "No encontré agentes instalados en este equipo"
                : `${online} de ${agents.length} en línea`}
            </div>
          </div>
          <button className="cc-icon-btn" onClick={onClose} aria-label="Cerrar" title="Cerrar (Esc)">
            <Icon name="x" />
          </button>
        </div>

        {agents.length === 0 ? (
          <div className="cc-modal-empty">
            Instala Claude Code, OpenCode, Codex o Antigravity y aparecerán aquí, conectados al
            equipo automáticamente.
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
              const cat = catalogs[name];
              const pref = prefs[name] ?? {};
              const chosen = cat?.models.find((m) => m.id === pref.model);
              const efforts = chosen && chosen.efforts.length > 0 ? chosen.efforts : (cat?.efforts ?? []);
              const inUse = a.model ? shortModel(a.model) : (cat?.current.model ?? null);
              const was = applied[name];
              const dirty =
                (pref.model ?? null) !== (was?.model ?? null) || (pref.effort ?? null) !== (was?.effort ?? null);
              const hasPref = !!pref.model || !!pref.effort;
              const showApply = a.online && dirty && (was !== undefined || hasPref);
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
                        {a.online &&
                          (isLeader ? (
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
                          ))}
                      </div>
                      <div className="cc-acard-state" data-state={state}>
                        {state === "work" && task ? `Trabajando en #${task.id}` : STATE_LABEL[state]}
                      </div>
                    </div>
                    {state === "off" && (
                      <button
                        className="cc-btn cc-acard-start"
                        disabled={busy === name}
                        onClick={() => onStart(name)}
                        title="Abrir el agente en una terminal, ya conectado al equipo"
                      >
                        {busy === name ? "Abriendo…" : "Iniciar"}
                      </button>
                    )}
                  </div>

                  {state === "starting" && (
                    <div className="cc-field-note" data-warn={Date.now() - (startedAt[name] ?? Date.now()) > 60_000 ? "1" : "0"}>
                      {Date.now() - (startedAt[name] ?? Date.now()) > 60_000
                        ? "Todavía no se ha conectado al equipo. Mira su terminal: puede estar pidiéndote confirmar algo (confiar en la carpeta, aprobar el servidor MCP, iniciar sesión)."
                        : "Abriendo su terminal. En cuanto se conecte aparecerá en línea, con su contexto."}
                    </div>
                  )}
                  {state === "starting" && tails[name] && (
                    <pre className="cc-tail" title="Lo último que muestra su terminal">
                      {tails[name]}
                    </pre>
                  )}
                  {state === "starting" && tails[name] && /\b(enter to confirm|\(y\/n\)|press enter)/i.test(tails[name]) && !confirmChoice(tails[name]) && (
                    <div className="cc-field-note" data-warn="1">
                      La opción marcada no es un «sí»: abre su terminal y elige tú.
                    </div>
                  )}

                  <div className="cc-acard-opts">
                    <label className="cc-field">
                      <span className="cc-field-l">Modelo</span>
                      <span className="cc-select">
                        <select
                          value={pref.model ?? ""}
                          disabled={cat === null}
                          onChange={(e) => {
                            const model = e.target.value || null;
                            const m = cat?.models.find((x) => x.id === model);
                            // Si el esfuerzo elegido no existe en el modelo nuevo, se limpia.
                            const keep =
                              pref.effort && (!m || m.efforts.length === 0 || m.efforts.includes(pref.effort))
                                ? pref.effort
                                : null;
                            onPref(name, { model, effort: keep });
                          }}
                        >
                          <option value="">
                            {cat === null ? "Cargando…" : inUse ? `Actual · ${inUse}` : "Predeterminado"}
                          </option>
                          {cat?.models.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.label}
                            </option>
                          ))}
                        </select>
                        <Icon name="chev" size={13} />
                      </span>
                    </label>
                    {efforts.length > 0 && (
                      <label className="cc-field">
                        <span className="cc-field-l">Esfuerzo</span>
                        <span className="cc-select">
                          <select
                            value={pref.effort ?? ""}
                            onChange={(e) => onPref(name, { effort: e.target.value || null })}
                          >
                            <option value="">
                              {cat?.current.effort ? `Actual · ${EFFORT_LABEL[cat.current.effort] ?? cat.current.effort}` : "Predeterminado"}
                            </option>
                            {efforts.map((ef) => (
                              <option key={ef} value={ef}>
                                {EFFORT_LABEL[ef] ?? ef}
                              </option>
                            ))}
                          </select>
                          <Icon name="chev" size={13} />
                        </span>
                      </label>
                    )}
                    {cmds.modeSeq && a.online && (
                      <button
                        className="cc-btn sec"
                        onClick={() => onCmd(name, cmds.modeSeq ?? "\x1b[Z", "Shift+Tab (modo)")}
                        title="Alterna Plan/Permisos dentro de su TUI (Shift+Tab)"
                      >
                        Plan / Directo
                      </button>
                    )}
                  </div>
                  {name === "opencode" && (
                    <div className="cc-field-note">
                      El esfuerzo de OpenCode va en el modelo (la parte tras «#»), si el proveedor lo ofrece.
                    </div>
                  )}
                  {showApply && (
                    <div className="cc-apply">
                      <button className="cc-btn" disabled={busy === name} onClick={() => onApply(name)}>
                        <Icon name={cat?.live ? "check" : "refresh"} size={14} />
                        {busy === name ? "Aplicando…" : cat?.live ? "Aplicar ahora" : "Reiniciar con esto"}
                      </button>
                      <span className="cc-apply-note">
                        {cat?.live
                          ? "Se escribe en su terminal; mejor cuando esté libre."
                          : "Reabre su terminal y retoma la conversación."}
                      </span>
                    </div>
                  )}

                  {a.online && (
                  <div className="cc-ctxbig" data-lvl={ctxLevel(ctx?.pct ?? null)}>
                    <div className="cc-ctxbig-row">
                      <span>Contexto</span>
                      <b>
                        {ctx
                          ? `${fmtTokens(ctx.tokens)} de ${fmtTokens(ctx.window)} · ${ctx.pct}%`
                          : name === "antigravity"
                            ? "no disponible"
                            : "se mide tras su primer mensaje"}
                      </b>
                    </div>
                    <div className="cc-ctxbar">
                      <i style={{ width: `${ctx?.pct ?? 0}%` }} />
                    </div>
                  </div>
                  )}

                  <div className="cc-now">
                    {a.online ? (
                      <time>hace {ago(a.last_seen_ms)}</time>
                    ) : (
                      <time>{last ? `hace ${ago(last.ts_ms)}` : "—"}</time>
                    )}
                    <span title={task ? `#${task.id} ${task.title}` : last?.text}>
                      {task
                        ? `#${task.id} ${task.title}`
                        : last
                          ? a.online
                            ? last.text
                            : `Última actividad: ${last.text}`
                          : "sin actividad aún"}
                    </span>
                  </div>

                  {state === "starting" && (
                    <div className="cc-acard-act">
                      {tails[name] && confirmChoice(tails[name]) && (
                        <button
                          className="cc-btn"
                          onClick={() => onCmd(name, "\r", "Enter (aceptar)")}
                          title="Envía Enter a su terminal para aceptar la opción marcada"
                        >
                          <Icon name="check" size={14} />
                          Aceptar «{confirmChoice(tails[name])}»
                        </button>
                      )}
                      <button className="cc-btn sec" onClick={() => onTerminal(name)}>
                        <Icon name="term" size={14} />
                        Ver terminal
                      </button>
                      <button className="cc-btn sec" disabled={busy === name} onClick={() => onRestart(name)}>
                        <Icon name="refresh" size={14} />
                        {busy === name ? "Reiniciando…" : "Reiniciar"}
                      </button>
                    </div>
                  )}

                  {a.online && (
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
                  )}
                </article>
              );
            })}
          </div>
        )}

        <div className="cc-modal-foot">
          <label className="cc-autostart" title="Al abrir lienzo, conecta los agentes instalados y abre los que no estén en marcha">
            <input
              type="checkbox"
              className="cc-check"
              checked={autoStart}
              onChange={(e) => onAutoStart(e.target.checked)}
            />
            Abrir el equipo al iniciar
          </label>
          <button className="cc-btn sec" onClick={onSettings}>
            <Icon name="shield" size={14} />
            Normas y proyecto
          </button>
          <span className="cc-kbd">Esc</span>
        </div>
      </section>
    </>
  );
}
