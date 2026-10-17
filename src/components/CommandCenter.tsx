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
  teamDetect,
  teamOpen,
  teamState,
  teamTaskOp,
} from "../lib/team";
import type { DetectResult, TeamAgent, TeamEvent, TeamState } from "../lib/team";
import { FeedList } from "./FeedList";
import { TeamPanel } from "./TeamPanel";
import { TerminalPanel } from "./TerminalPanel";

type Mode = "command" | "canvas";

type Drawer =
  | { kind: "terminal"; panelId: string }
  | { kind: "team"; agents?: boolean }
  | null;

/** Terminal panel (if any) that belongs to a hub agent name. */
function panelForAgent(panels: Panel[], agentName: string): Panel | undefined {
  return panels.find(
    (p) => p.kind === "terminal" && !!p.cmd && agentKeyFromCmd(p.cmd) === agentName,
  );
}

/**
 * Centro de Mando: la vista principal. Agentes en un dock compacto, tareas y
 * actividad en el escenario, y las terminales detrás de un cajón lateral (se
 * abren solo cuando hacen falta). El lienzo queda como vista de topología.
 */
export function CommandCenter({ onMode }: { onMode: (mode: Mode) => void }) {
  const layout = useLayout();
  const [state, setState] = useState<TeamState | null>(null);
  const [detect, setDetect] = useState<DetectResult | null>(null);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [broadcastDraft, setBroadcastDraft] = useState("");
  const [taskDraft, setTaskDraft] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ text: string; err?: boolean } | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);

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

  // Close the terminal drawer if its panel disappears (closed from the canvas).
  useEffect(() => {
    if (
      drawer?.kind === "terminal" &&
      !layout.panels.some((p) => p.id === drawer.panelId)
    ) {
      setDrawer(null);
    }
  }, [drawer, layout.panels]);

  // Esc closes the drawer.
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
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  // Latest activity per agent → "ahora mismo" on the dock cards.
  const lastByAgent = useMemo(() => {
    const m = new Map<string, TeamEvent>();
    for (const e of state?.events ?? []) {
      if (e.kind === "join" || e.kind === "leave") continue;
      const prev = m.get(e.agent);
      if (!prev || e.ts_ms > prev.ts_ms) m.set(e.agent, e);
    }
    return m;
  }, [state]);

  // Task each agent is currently holding (claimed).
  const claimedBy = useMemo(() => {
    const m = new Map<string, { id: number; title: string }>();
    for (const t of tasks) {
      if (t.status === "claimed" && t.owner) m.set(t.owner, { id: t.id, title: t.title });
    }
    return m;
  }, [tasks]);

  const openAgentFlow = async (id: string, label: string) => {
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
        const created = addAgentTerminal(spot.x, spot.y, label, r.cmd);
        setDrawer({ kind: "terminal", panelId: created.id });
        say(`✓ ${label} lanzado. Su terminal está abierta aquí al lado.`);
      }
      refresh();
    } catch (e) {
      say(errMsg(e), true);
    } finally {
      setOpening(null);
    }
  };

  const focusAgent = (a: TeamAgent) => {
    const p = panelForAgent(layout.panels, a.name);
    if (p) {
      setDrawer({ kind: "terminal", panelId: p.id });
      return;
    }
    openAgentFlow(a.name, a.name).catch(() => {});
  };

  const sendBroadcast = async () => {
    const text = broadcastDraft.trim();
    if (!text) return;
    try {
      const typed = await pushBroadcast(text, leader.trim());
      setBroadcastDraft("");
      refresh();
      say(
        typed > 0
          ? `📣 Misión enviada al feed y escrita en ${typed} terminal(es) de agentes.`
          : "📣 Misión publicada (no hay terminales de agentes abiertas ahora mismo).",
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

  const events = state?.events ?? [];
  const inProgress = tasks.filter((t) => t.status === "claimed");
  const openTasks = tasks.filter((t) => t.status === "open");
  const doneTasks = tasks.filter((t) => t.status === "done");

  const termPanel =
    drawer?.kind === "terminal"
      ? (layout.panels.find((p) => p.id === drawer.panelId) ?? null)
      : null;

  return (
    <div className="cc">
      <header className="cc-top">
        <div className="cc-brand">
          <span className="cc-logo">⬒</span> lienzo
        </div>
        <div className="cc-modes">
          <button data-active="1" title="Centro de mando: misiones, tareas y actividad">
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
        <div className="cc-broadcast">
          <input
            type="text"
            value={broadcastDraft}
            placeholder="Misión para TODO el equipo (se escribe en sus terminales)…"
            onChange={(e) => setBroadcastDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") sendBroadcast();
            }}
          />
          <button
            className="agent-btn"
            disabled={!broadcastDraft.trim()}
            onClick={sendBroadcast}
            title="Publica la misión en el feed y la escribe en las terminales de los agentes"
          >
            📣 Enviar
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
            title="Gestionar agentes, normas del equipo y proyecto"
          >
            Equipo
          </button>
        </div>
      </header>

      <div className="cc-dock">
        {online.length === 0 && (
          <div className="cc-dock-empty">
            Sin agentes conectados todavía. Pulsa «Equipo» para conectar y abrir tus agentes.
          </div>
        )}
        {online.map((a) => {
          const last = lastByAgent.get(a.name);
          const task = claimedBy.get(a.name);
          const term = panelForAgent(layout.panels, a.name);
          return (
            <button
              key={a.session_id}
              className="cc-agent"
              data-lead={leader === a.name ? "1" : "0"}
              onClick={() => focusAgent(a)}
              title={term ? "Abrir su terminal" : "Lanzar su terminal"}
            >
              <span className="cc-agent-row">
                <span className="agent-dot" data-on="1" />
                <span style={{ color: agentColor(a.name) }}>{a.name}</span>
                {leader === a.name && <span className="prog-lead">líder</span>}
                <span className="cc-agent-seen">
                  {opening === a.name ? "abriendo…" : `hace ${ago(a.last_seen_ms)}`}
                </span>
              </span>
              <span className="cc-agent-now" title={last?.text}>
                {last ? last.text : "en línea, sin actividad aún"}
              </span>
              <span className="cc-agent-task">
                {task
                  ? `#${task.id} ${task.title}`
                  : term
                    ? "sin tarea asignada"
                    : "pulsa para abrir su terminal"}
              </span>
            </button>
          );
        })}
      </div>

      <div className="cc-stage">
        <section className="cc-col cc-col-tasks">
          <div className="prog-head">
            <span className="prog-title">Tareas</span>
            <span className="prog-pct">{total > 0 ? `${pct}%` : "—"}</span>
          </div>
          <div className="prog-bar">
            <div className="prog-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="team-task-add">
            <input
              type="text"
              value={taskDraft}
              placeholder="Nueva tarea para el equipo…"
              onChange={(e) => setTaskDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addTask();
              }}
            />
            <button className="agent-btn" onClick={addTask}>
              Añadir
            </button>
          </div>

          <div className="team-section-title">En curso ({inProgress.length})</div>
          {inProgress.length === 0 ? (
            <div className="prog-empty">Nada en curso ahora mismo.</div>
          ) : (
            inProgress.map((t) => (
              <div className="task-row" key={t.id}>
                <span className="task-chip" data-s="claimed">
                  #{t.id}
                </span>
                <span className="task-title">
                  {t.title}
                  {t.owner ? <span className="agent-meta"> — {t.owner}</span> : null}
                </span>
                <button className="task-btn" onClick={() => taskOp(t.id, "done")}>
                  Hecho
                </button>
              </div>
            ))
          )}

          <div className="team-section-title">Abiertas ({openTasks.length})</div>
          {openTasks.length === 0 ? (
            <div className="prog-empty">Sin tareas abiertas.</div>
          ) : (
            openTasks.map((t) => (
              <div className="task-row" key={t.id}>
                <span className="task-chip" data-s="open">
                  #{t.id}
                </span>
                <span className="task-title">{t.title}</span>
                <button className="task-btn" onClick={() => taskOp(t.id, "claim")}>
                  Reclamar
                </button>
                <button className="task-btn" onClick={() => taskOp(t.id, "done")}>
                  Hecho
                </button>
              </div>
            ))
          )}

          {doneTasks.length > 0 && (
            <>
              <div className="team-section-title">Hechas ({doneTasks.length})</div>
              {doneTasks
                .slice(-8)
                .reverse()
                .map((t) => (
                  <div className="task-row" data-done="1" key={t.id}>
                    <span className="task-chip" data-s="done">
                      #{t.id}
                    </span>
                    <span className="task-title">
                      {t.title}
                      {t.owner ? <span className="agent-meta"> — {t.owner}</span> : null}
                    </span>
                    <button className="task-btn" onClick={() => taskOp(t.id, "reopen")}>
                      Reabrir
                    </button>
                  </div>
                ))}
            </>
          )}
        </section>

        <section className="cc-col cc-col-feed">
          <div className="cc-col-head">
            <span>Actividad del equipo</span>
            <span className="cc-col-sub">
              {online.length} en línea
              {state?.project ? ` · ${shortPath(state.project)}` : ""}
            </span>
          </div>
          <FeedList
            events={events}
            empty="Aún no hay actividad. Conecta agentes y lanza una misión con 📣 para verlos trabajar aquí, en tiempo real."
          />
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
          <aside className="cc-drawer" data-wide={drawer.kind === "terminal" ? "1" : "0"}>
            <div className="cc-drawer-head">
              {drawer.kind === "terminal" && termPanel ? (
                <>
                  <span className="agent-dot" data-on="1" />
                  <span className="cc-drawer-title">{termPanel.title}</span>
                  <span className="cc-drawer-sub">terminal · Esc para cerrar</span>
                </>
              ) : drawer.kind === "team" ? (
                <span className="cc-drawer-title">Equipo — agentes, normas y proyecto</span>
              ) : null}
              <button
                className="panel-close"
                onClick={() => setDrawer(null)}
                title="Cerrar (Esc)"
              >
                ✕
              </button>
            </div>
            <div className="cc-drawer-body">
              {drawer.kind === "terminal" && termPanel ? (
                <TerminalPanel panel={termPanel} lod={false} />
              ) : drawer.kind === "team" ? (
                <TeamPanel
                  initialTab={drawer.agents ? "agents" : "feed"}
                  onTerminalOpen={(p) => setDrawer({ kind: "terminal", panelId: p.id })}
                />
              ) : null}
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
