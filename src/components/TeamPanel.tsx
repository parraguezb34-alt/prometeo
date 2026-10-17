import { useCallback, useEffect, useRef, useState } from "react";
import type { Panel } from "../store";
import { addAgentTerminal } from "../store";
import {
  agentColor,
  ago,
  errMsg,
  onTeamUpdate,
  shortPath,
  teamAddTask,
  teamConnect,
  teamDetect,
  teamDetails,
  teamOpen,
  teamProjectSet,
  teamState,
  teamTaskOp,
} from "../lib/team";
import type { DetectResult, TeamDetails, TeamState } from "../lib/team";

type Tab = "feed" | "tasks" | "agents";

const GLYPHS: Record<string, string> = {
  join: "⊕",
  leave: "⊖",
  message: "✉",
  prompt: "❯",
  update: "●",
  tool: "↳",
  task: "☰",
  claim: "⊙",
  stop: "■",
  session: "▶",
};

const STATUS_LABEL: Record<string, string> = {
  open: "abierta",
  claimed: "en curso",
  done: "hecha",
};

export function TeamPanel({ panel }: { panel: Panel }) {
  const [tab, setTab] = useState<Tab>("feed");
  const [state, setState] = useState<TeamState | null>(null);
  const [detect, setDetect] = useState<DetectResult | null>(null);
  const [details, setDetails] = useState<TeamDetails | null>(null);
  const [projectDraft, setProjectDraft] = useState("");
  const [taskDraft, setTaskDraft] = useState("");
  const [flash, setFlash] = useState<{ text: string; err?: boolean } | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
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
    teamDetect()
      .then((d) => {
        setDetect(d);
        setProjectDraft((prev) => (prev.trim() ? prev : (d.project ?? "")));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    refreshDetect();
    teamDetails().then(setDetails).catch(() => {});
    const unlisten = onTeamUpdate(refresh);
    const interval = window.setInterval(refresh, 5000);
    return () => {
      unlisten.then((f) => f());
      window.clearInterval(interval);
      if (flashTimer.current !== undefined) window.clearTimeout(flashTimer.current);
    };
  }, [refresh, refreshDetect]);

  const saveProject = async () => {
    try {
      const p = projectDraft.trim();
      await teamProjectSet(p ? p : null);
      refreshDetect();
      say(p ? `Carpeta del equipo: ${p}` : "Carpeta del equipo borrada.");
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

  const connect = async (id: string) => {
    setConnecting(id);
    try {
      const res = await teamConnect(id, projectDraft.trim() || null);
      const lines = [`✓ ${id} conectado.`];
      if (res.files.length) lines.push("Archivos escritos:", ...res.files);
      if (res.notes.length) lines.push(...res.notes);
      say(lines.join("\n"));
      refreshDetect();
      refresh();
    } catch (e) {
      say(errMsg(e), true);
    } finally {
      setConnecting(null);
    }
  };

  const openAgent = async (id: string, label: string) => {
    setOpening(id);
    try {
      const det = detect?.agents.find((x) => x.id === id);
      if (!det?.connected) {
        await teamConnect(id, projectDraft.trim() || null);
        refreshDetect();
      }
      const r = await teamOpen(id);
      if (r.kind === "app") {
        say(`✓ ${label} abriéndose en la carpeta del equipo.`);
      } else {
        addAgentTerminal(panel.x + panel.w + 28, panel.y, label, r.cmd);
        say(`✓ ${label} abriéndose en una terminal del lienzo…`);
      }
    } catch (e) {
      say(errMsg(e), true);
    } finally {
      setOpening(null);
    }
  };

  const events = state?.events ?? [];
  const tasks = state?.tasks ?? [];
  const agents = state?.agents ?? [];
  const claims = state?.claims ?? [];
  const online = agents.filter((a) => a.online).length;
  const openTasks = tasks.filter((t) => t.status !== "done").length;

  return (
    <div className="team">
      <div className="team-tabs">
        <button data-active={tab === "feed" ? "1" : "0"} onClick={() => setTab("feed")}>
          Actividad
        </button>
        <button data-active={tab === "tasks" ? "1" : "0"} onClick={() => setTab("tasks")}>
          Tareas{openTasks ? ` (${openTasks})` : ""}
        </button>
        <button data-active={tab === "agents" ? "1" : "0"} onClick={() => setTab("agents")}>
          Agentes{online ? ` (${online})` : ""}
        </button>
      </div>

      {flash && (
        <div className="team-flash" data-kind={flash.err ? "err" : "ok"}>
          {flash.text}
        </div>
      )}

      <div className="team-body">
        {tab === "feed" &&
          (events.length === 0 ? (
            <div className="team-empty">
              Aún no hay actividad. Conecta agentes (pestaña Agentes) y verás aquí todo lo
              que hacen, al momento.
            </div>
          ) : (
            events.map((e) => (
              <div className="feed-item" key={e.seq}>
                <span className="feed-glyph">{GLYPHS[e.kind] ?? "•"}</span>
                <span className="feed-main">
                  <span className="feed-agent" style={{ color: agentColor(e.agent) }}>
                    {e.agent}
                    {e.to ? ` → ${e.to}` : ""}
                  </span>
                  <span className="feed-text" data-weak={e.kind === "tool" ? "1" : "0"}>
                    {" "}
                    {e.text}
                  </span>
                  {e.files.length > 0 && (
                    <span className="feed-files"> · {e.files.map(shortPath).join(", ")}</span>
                  )}
                </span>
                <span className="feed-time">{ago(e.ts_ms)}</span>
              </div>
            ))
          ))}

        {tab === "tasks" && (
          <>
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
            {tasks.length === 0 ? (
              <div className="team-empty">
                Sin tareas. Crea una aquí o pídele a un agente que use team_task_create.
              </div>
            ) : (
              tasks.map((t) => (
                <div
                  className="task-row"
                  key={t.id}
                  data-done={t.status === "done" ? "1" : "0"}
                >
                  <span className="task-chip" data-s={t.status}>
                    #{t.id} {STATUS_LABEL[t.status] ?? t.status}
                  </span>
                  <span className="task-title">
                    {t.title}
                    {t.owner ? <span className="agent-meta"> — {t.owner}</span> : null}
                  </span>
                  {t.status !== "done" ? (
                    <>
                      {t.status !== "claimed" && (
                        <button className="task-btn" onClick={() => taskOp(t.id, "claim")}>
                          Reclamar
                        </button>
                      )}
                      <button className="task-btn" onClick={() => taskOp(t.id, "done")}>
                        Hecho
                      </button>
                    </>
                  ) : (
                    <button className="task-btn" onClick={() => taskOp(t.id, "reopen")}>
                      Reabrir
                    </button>
                  )}
                </div>
              ))
            )}
          </>
        )}

        {tab === "agents" && (
          <>
            <div className="team-section-title">Proyecto del equipo</div>
            <div className="team-project">
              <input
                type="text"
                value={projectDraft}
                placeholder={"C:\\ruta\\del\\proyecto (donde vivirán las configs)"}
                onChange={(e) => setProjectDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveProject();
                }}
              />
              <button className="agent-btn" onClick={saveProject}>
                Guardar
              </button>
            </div>

            <div className="team-section-title">Conectar agentes</div>
            {(detect?.agents ?? []).map((a) => (
              <div className="agent-card" key={a.id}>
                <div className="agent-head">
                  <span className="agent-dot" data-on={a.connected ? "1" : "0"} />
                  <span className="agent-name">{a.label}</span>
                  <button
                    className="agent-btn"
                    data-ghost="1"
                    disabled={opening === a.id}
                    onClick={() => openAgent(a.id, a.label)}
                  >
                    {opening === a.id ? "Abriendo…" : "Abrir"}
                  </button>
                  <button
                    className="agent-btn"
                    disabled={a.connected || connecting === a.id || !projectDraft.trim()}
                    onClick={() => connect(a.id)}
                  >
                    {a.connected ? "Conectado" : connecting === a.id ? "Conectando…" : "Conectar"}
                  </button>
                </div>
                <div className="agent-meta">
                  {a.cli_found
                    ? "CLI detectada"
                    : a.config_dir_found
                      ? "Config detectada (CLI fuera del PATH)"
                      : "No detectado — se configurará igual"}
                  {!a.mcp_exe_ok ? " · falta compilar lienzo-mcp.exe" : ""}
                </div>
              </div>
            ))}
            {!projectDraft.trim() && (
              <div className="agent-meta">
                Escribe la carpeta del proyecto para poder conectar agentes.
              </div>
            )}

            <div className="team-section-title">Sesiones en línea</div>
            {agents.length === 0 ? (
              <div className="team-empty">
                Ninguna sesión conectada todavía. Pulsa «Abrir» en un agente para lanzarlo
                en una terminal del lienzo, ya dentro del proyecto.
              </div>
            ) : (
              agents.map((a) => (
                <div className="task-row" key={a.session_id}>
                  <span className="agent-dot" data-on={a.online ? "1" : "0"} />
                  <span className="task-title" style={{ color: agentColor(a.name) }}>
                    {a.name}
                    <span className="agent-meta"> · pid {a.pid} · visto hace {ago(a.last_seen_ms)}</span>
                  </span>
                </div>
              ))
            )}

            {claims.length > 0 && (
              <>
                <div className="team-section-title">Archivos reservados</div>
                {claims.map((c) => (
                  <div className="claims-row" key={c.path}>
                    {c.path} — {c.agent}
                  </div>
                ))}
              </>
            )}

            {details && (
              <div className="team-hub">
                Hub local: {details.url}
                {"\n"}Puente MCP: {details.mcp_exe ?? "sin compilar"}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
