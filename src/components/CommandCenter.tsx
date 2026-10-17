import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addAgentTerminal, autoSpot, useLayout } from "../store";
import type { Panel } from "../store";
import {
  agentColor,
  agentKeyFromCmd,
  ago,
  errMsg,
  onTeamUpdate,
  pushBroadcast,
  shortPath,
  teamAddTask,
  teamConnect,
  teamDm,
  teamDetect,
  teamOpen,
  teamState,
  teamTaskOp,
} from "../lib/team";
import type { DetectResult, TeamEvent, TeamState } from "../lib/team";
import { termWrite } from "../lib/pty";
import { GLYPHS } from "./FeedList";
import { TeamPanel } from "./TeamPanel";
import { TerminalPanel } from "./TerminalPanel";

type Mode = "command" | "canvas";

/** Conversation shown in the central chat: the whole team or one agent. */
type Sel = { kind: "team" } | { kind: "agent"; name: string };

type Drawer = { kind: "team"; agents?: boolean } | null;

/** Terminal panel (if any) that belongs to a hub agent name. */
function panelForAgent(panels: Panel[], agentName: string): Panel | undefined {
  return panels.find(
    (p) => p.kind === "terminal" && !!p.cmd && agentKeyFromCmd(p.cmd) === agentName,
  );
}

/**
 * Centro de Mando: la vista principal, con forma de chat (como Claude Code o
 * OpenCode). A la izquierda el equipo, sus agentes y las tareas; en el centro la
 * conversacion con el equipo o con un agente (con pestana de terminal integrada);
 * abajo la caja de texto. El lienzo espacial queda como vista de topologia.
 */
export function CommandCenter({ onMode }: { onMode: (mode: Mode) => void }) {
  const layout = useLayout();
  const [state, setState] = useState<TeamState | null>(null);
  const [detect, setDetect] = useState<DetectResult | null>(null);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [sel, setSel] = useState<Sel>({ kind: "team" });
  const [tab, setTab] = useState<"chat" | "term">("chat");
  const [draft, setDraft] = useState("");
  const [taskDraft, setTaskDraft] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ text: string; err?: boolean } | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);
  const chatRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const stickRef = useRef(true);

  const say = useCallback((text: string, err = false) => {
    setFlash({ text, err });
    if (flashTimer.current !== undefined) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 8000);
  }, []);

  const refresh = useCallback(() => {
    teamState()
      .then(setState)
      .catch(() => {});
  }, []);

  const refreshDetect = useCallback(() => {
    teamDetect().then(setDetect).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    refreshDetect();
    const unlisten = onTeamUpdate(refresh);
    const interval = window.setInterval(refresh, 4000);
    return () => {
      unlisten.then((f) => f());
      window.clearInterval(interval);
      if (flashTimer.current !== undefined) window.clearTimeout(flashTimer.current);
    };
  }, [refresh, refreshDetect]);

  // Esc closes the team drawer.
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawer(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  const tasks = state?.tasks ?? [];
  const agents = state?.agents ?? [];
  const online = agents.filter((a) => a.online);
  const leader = state?.leader ?? "";
  const done = tasks.filter((t) => t.status === "done").length;
  const total = tasks.length;

  // Task each agent is currently holding (claimed) → subtitle of its chat.
  const claimedBy = useMemo(() => {
    const m = new Map<string, { id: number; title: string }>();
    for (const t of tasks) {
      if (t.status === "claimed" && t.owner) m.set(t.owner, { id: t.id, title: t.title });
    }
    return m;
  }, [tasks]);

  const selKey = sel.kind === "team" ? "team" : sel.name;

  // Messages of the open conversation, oldest → newest (the hub sends the feed
  // newest first). Agent chats show that agent's events; the team chat is the
  // whole feed (messages as bubbles, the rest as system lines).
  const msgs = useMemo(() => {
    const all = (state?.events ?? []).slice(0, 400).reverse();
    if (sel.kind === "team") return all;
    return all.filter(
      (e) =>
        (e.agent === sel.name && e.kind !== "tool") ||
        e.to === sel.name ||
        e.kind === "broadcast",
    );
  }, [state, sel]);

  // Stick to the bottom while the user is reading the latest (like a chat).
  const onChatScroll = () => {
    const el = chatRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  };

  useEffect(() => {
    stickRef.current = true;
  }, [selKey]);

  useEffect(() => {
    const el = chatRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [selKey, tab, msgs.length]);

  const selectAgent = (name: string, to: "chat" | "term" = "chat") => {
    setSel({ kind: "agent", name });
    setTab(to);
  };

  /** Connect (if needed) and launch an agent, then open its terminal here. */
  const launchAgent = async (id: string, label: string) => {
    setOpening(id);
    try {
      const det = detect?.agents.find((x) => x.id === id);
      if (!det?.connected) {
        await teamConnect(id, state?.project ?? null);
        refreshDetect();
      }
      const r = await teamOpen(id);
      if (r.kind === "app") {
        say(`✓ ${label} se está abriendo en su app de escritorio…`);
      } else {
        const spot = autoSpot();
        addAgentTerminal(spot.x, spot.y, label, r.cmd);
        selectAgent(agentKeyFromCmd(r.cmd), "term");
        setDrawer(null);
        say(`✓ ${label} lanzado. Su terminal está abierta aquí.`);
      }
      refresh();
    } catch (e) {
      say(errMsg(e), true);
    } finally {
      setOpening(null);
    }
  };

  /** Open the selected agent's terminal tab, or launch it if it has none. */
  const openTerm = (name: string) => {
    const p = panelForAgent(layout.panels, name);
    if (p) selectAgent(name, "term");
    else launchAgent(name, name).catch(() => {});
  };

  /** Send the composer: team → broadcast with protocol; agent → direct message
   * typed into its terminal (and logged in the feed). */
  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    const one = text.replace(/\s*\n+\s*/g, " ");
    if (sel.kind === "team") {
      try {
        const typed = await pushBroadcast(one, leader);
        setDraft("");
        if (areaRef.current) areaRef.current.style.height = "auto";
        refresh();
        say(
          typed > 0
            ? `📣 Misión escrita en ${typed} terminal(es) de agentes, con instrucciones de coordinación.`
            : "📣 Publicada en el feed (no hay terminales de agentes abiertas ahora mismo).",
        );
      } catch (e) {
        say(errMsg(e), true);
      }
      return;
    }
    const name = sel.name;
    try {
      const p = panelForAgent(layout.panels, name);
      if (p?.sessionId) await termWrite(p.sessionId, `${one}\r`);
      await teamDm(name, text);
      setDraft("");
      if (areaRef.current) areaRef.current.style.height = "auto";
      refresh();
      say(
        p?.sessionId
          ? `✉ Enviado a ${name}.`
          : `✉ Guardado en el feed; ábrele terminal para que ${name} lo reciba.`,
      );
    } catch (e) {
      say(errMsg(e), true);
    }
  };

  const addTask = async () => {
    const t = taskDraft.trim();
    if (!t) return;
    try {
      await teamAddTask(t);
      setTaskDraft("");
      refresh();
    } catch (e) {
      say(errMsg(e), true);
    }
  };

  const taskOp = async (id: number, op: string) => {
    try {
      await teamTaskOp(id, op);
      refresh();
    } catch (e) {
      say(errMsg(e), true);
    }
  };

  const renderEvent = (e: TeamEvent) => {
    const mine = e.agent === "tú";
    if (e.kind === "message" || (mine && e.kind === "broadcast")) {
      return (
        <div className="cc-msg" data-who={mine ? "me" : "agent"} key={e.seq}>
          <div className="cc-msg-head">
            <span style={{ color: mine ? undefined : agentColor(e.agent) }}>
              {mine ? "tú" : e.agent}
            </span>
            {e.to ? <span>→ {e.to}</span> : null}
            <span>{ago(e.ts_ms)}</span>
          </div>
          <div className="cc-msg-body">
            {e.kind === "broadcast" ? `📣 ${e.text}` : e.text}
          </div>
        </div>
      );
    }
    return (
      <div className="cc-sys" key={e.seq}>
        <span className="cc-sys-glyph">{GLYPHS[e.kind] ?? "•"}</span>
        <span className="cc-sys-main">
          <span style={{ color: agentColor(e.agent) }}>{e.agent}</span>
          {e.to ? <span> → {e.to}</span> : null}
          <span data-weak={e.kind === "tool" ? "1" : "0"}> {e.text}</span>
          {e.files.length > 0 && (
            <span className="feed-files"> · {e.files.map(shortPath).join(", ")}</span>
          )}
        </span>
        <span className="feed-time">{ago(e.ts_ms)}</span>
      </div>
    );
  };

  const agentView = sel.kind === "agent" ? sel.name : null;
  const agentRow = agentView ? agents.find((a) => a.name === agentView) : undefined;
  const agentTask = agentView ? claimedBy.get(agentView) : undefined;
  const termPanel = agentView ? panelForAgent(layout.panels, agentView) : undefined;

  return (
    <div className="cc">
      <header className="cc-top">
        <div className="cc-brand">
          <span className="cc-logo">⬒</span> lienzo
        </div>
        <div className="cc-modes">
          <button data-active="1" title="Centro de mando: chat con tu equipo">
            ◫ Comando
          </button>
          <button
            data-active="0"
            onClick={() => onMode("canvas")}
            title="Lienzo: terminales y paneles en el espacio (depuración / topología)"
          >
            ⬚ Lienzo
          </button>
        </div>
        <div className="cc-summary">
          <span>{total > 0 ? `${done}/${total} tareas` : "sin tareas"}</span>
          <span>·</span>
          <span>
            {online.length} agente{online.length === 1 ? "" : "s"}
          </span>
          <button
            className="agent-btn"
            data-ghost="1"
            onClick={() => setDrawer({ kind: "team", agents: true })}
            title="Gestionar equipo: agentes, normas y proyecto"
          >
            ⚙ Equipo
          </button>
        </div>
      </header>

      <div className="cc-main">
        <aside className="cc-side">
          <div className="cc-side-scroll">
            <button
              className="cc-dest"
              data-active={sel.kind === "team" ? "1" : "0"}
              onClick={() => setSel({ kind: "team" })}
              title="Chat del equipo: todo lo que hacen los agentes, en vivo"
            >
              <span>💬 Equipo</span>
              <span className="cc-dest-sub">{online.length} en línea</span>
            </button>

            <div className="cc-side-title">Agentes</div>
            {agents.length === 0 && (
              <div className="cc-side-empty">
                Sin sesiones conectadas todavía. Usa «＋ Conectar» para traer a tu equipo.
              </div>
            )}
            {agents.map((a) => (
              <div
                className="cc-side-agent"
                key={a.session_id}
                data-active={
                  sel.kind === "agent" && sel.name === a.name ? "1" : "0"
                }
                onClick={() => selectAgent(a.name)}
                title={`Hablar con ${a.name}`}
              >
                <span className="agent-dot" data-on={a.online ? "1" : "0"} />
                <span style={{ color: agentColor(a.name) }}>{a.name}</span>
                {leader === a.name && <span className="prog-lead">líder</span>}
                <span className="cc-side-seen">
                  {a.online ? `hace ${ago(a.last_seen_ms)}` : "offline"}
                </span>
                <button
                  className="cc-side-term"
                  onClick={(e) => {
                    e.stopPropagation();
                    openTerm(a.name);
                  }}
                  title={
                    panelForAgent(layout.panels, a.name)
                      ? "Ver su terminal aquí"
                      : "Lanzar su terminal"
                  }
                >
                  ▸_
                </button>
              </div>
            ))}
            <button
              className="cc-side-connect"
              onClick={() => setDrawer({ kind: "team", agents: true })}
            >
              ＋ Conectar / abrir agentes
            </button>

            <div className="cc-side-title">
              Tareas ({tasks.filter((t) => t.status !== "done").length})
            </div>
            {tasks.length === 0 && (
              <div className="cc-side-empty">
                Sin tareas. El equipo las crea al trabajar, o añade una aquí abajo.
              </div>
            )}
            {[...tasks].reverse().map((t) => (
              <div
                className="cc-task"
                key={t.id}
                data-done={t.status === "done" ? "1" : "0"}
              >
                <span className="task-chip" data-s={t.status}>
                  #{t.id}
                </span>
                <span className="cc-task-title" title={t.title}>
                  {t.title}
                </span>
                {t.owner && (
                  <span
                    className="cc-task-owner"
                    style={{ color: agentColor(t.owner) }}
                    title={`en manos de ${t.owner}`}
                  >
                    {t.owner}
                  </span>
                )}
                {t.status === "done" ? (
                  <button
                    className="cc-task-btn"
                    onClick={() => taskOp(t.id, "reopen")}
                    title="Reabrir"
                  >
                    ↺
                  </button>
                ) : (
                  <button
                    className="cc-task-btn"
                    onClick={() => taskOp(t.id, "done")}
                    title="Marcar hecha"
                  >
                    ✓
                  </button>
                )}
              </div>
            ))}
            <div className="team-task-add cc-task-add">
              <input
                type="text"
                value={taskDraft}
                placeholder="Nueva tarea…"
                onChange={(e) => setTaskDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addTask();
                }}
              />
              <button className="agent-btn" onClick={addTask} disabled={!taskDraft.trim()}>
                ＋
              </button>
            </div>
          </div>
        </aside>

        <section className="cc-conv">
          {sel.kind === "team" ? (
            <div className="cc-chat-head">
              <span className="cc-chat-title">💬 Equipo</span>
              <span className="cc-chat-sub">
                {online.length} en línea
                {leader ? ` · líder: ${leader}` : ""}
                {state?.project ? ` · ${shortPath(state.project)}` : ""}
              </span>
            </div>
          ) : (
            <div className="cc-chat-head">
              <span className="agent-dot" data-on={agentRow?.online ? "1" : "0"} />
              <span className="cc-chat-title" style={{ color: agentColor(sel.name) }}>
                {sel.name}
              </span>
              {leader === sel.name && <span className="prog-lead">líder</span>}
              <span className="cc-chat-sub">
                {agentTask
                  ? `#${agentTask.id} ${agentTask.title}`
                  : agentRow
                    ? agentRow.online
                      ? `en línea · visto hace ${ago(agentRow.last_seen_ms)}`
                      : "sin sesión viva"
                    : "sin sesión conectada"}
              </span>
              <div className="cc-chat-tabs">
                <button
                  data-active={tab === "chat" ? "1" : "0"}
                  onClick={() => setTab("chat")}
                >
                  💬 Conversación
                </button>
                <button
                  data-active={tab === "term" ? "1" : "0"}
                  onClick={() => setTab("term")}
                >
                  ▸_ Terminal
                </button>
              </div>
            </div>
          )}

          {sel.kind === "agent" && tab === "term" ? (
            termPanel ? (
              <div className="cc-termbox">
                <TerminalPanel panel={termPanel} lod={false} />
              </div>
            ) : (
              <div className="cc-empty">
                <div>
                  {sel.name} todavía no tiene terminal abierta.
                  <br />
                  Ábrela aquí y podrás verlo trabajar y escribirle directo.
                </div>
                <button
                  className="agent-btn"
                  disabled={opening === sel.name}
                  onClick={() => launchAgent(sel.name, sel.name)}
                >
                  {opening === sel.name ? "Abriendo…" : "▸_ Lanzar terminal"}
                </button>
              </div>
            )
          ) : (
            <>
              <div className="cc-chat" ref={chatRef} onScroll={onChatScroll}>
                {msgs.length === 0 ? (
                  <div className="cc-empty">
                    {sel.kind === "team" ? (
                      <>
                        Aquí verás todo lo que hace el equipo: mensajes, tareas, avances y
                        avisos, en vivo.
                        <br />
                        Escribe abajo una misión y se repartirá con instrucciones de
                        coordinación.
                      </>
                    ) : (
                      <>
                        Conversación con {sel.name}. Lo que escribas va directo a su
                        terminal; sus avances y mensajes aparecerán aquí.
                      </>
                    )}
                  </div>
                ) : (
                  msgs.map(renderEvent)
                )}
              </div>
              <div className="cc-input">
                <textarea
                  ref={areaRef}
                  rows={1}
                  value={draft}
                  placeholder={
                    sel.kind === "team"
                      ? "Misión para todo el equipo… (Enter envía, Shift+Enter salto de línea)"
                      : `Mensaje para ${sel.name}… (se escribe en su terminal)`
                  }
                  onChange={(e) => {
                    setDraft(e.target.value);
                    const el = e.currentTarget;
                    el.style.height = "auto";
                    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                />
                <button className="agent-btn cc-send" disabled={!draft.trim()} onClick={send}>
                  Enviar
                </button>
              </div>
            </>
          )}
        </section>
      </div>

      {flash && (
        <div className="cc-toast" data-err={flash.err ? "1" : undefined}>
          {flash.text}
        </div>
      )}

      {drawer && (
        <>
          <div className="cc-backdrop" onClick={() => setDrawer(null)} />
          <aside className="cc-drawer">
            <div className="cc-drawer-head">
              <span className="cc-drawer-title">Equipo — agentes, normas y proyecto</span>
              <button
                className="panel-close"
                onClick={() => setDrawer(null)}
                title="Cerrar (Esc)"
              >
                ✕
              </button>
            </div>
            <div className="cc-drawer-body">
              <TeamPanel
                initialTab={drawer.agents ? "agents" : "feed"}
                onTerminalOpen={(p) => {
                  selectAgent(agentKeyFromCmd(p.cmd ?? ""), "term");
                  setDrawer(null);
                }}
              />
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
