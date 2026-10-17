import { useCallback, useEffect, useRef, useState } from "react";
import type { Panel } from "../store";
import { addAgentTerminal, getLayout } from "../store";
import { termWrite } from "../lib/pty";
import {
  agentColor,
  ago,
  errMsg,
  onTeamUpdate,
  shortPath,
  teamAddTask,
  teamBroadcast,
  teamBroadcastAck,
  teamCharter,
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
  broadcast: "📣",
};

/** Map a terminal launch command to the agent id used by the hub. */
function agentKeyFromCmd(cmd: string): string {
  const c = cmd.toLowerCase();
  if (c.includes("opencode")) return "opencode";
  if (c.includes("agy") || c.includes("antigravity")) return "antigravity";
  if (c.includes("claude")) return "claude";
  if (c.includes("codex")) return "codex";
  return c.split(/[\\/]/).pop()?.replace(/\.(exe|cmd|bat|ps1)$/i, "") || "agente";
}

/** Wrap the user's message with the team protocol before typing it into each
 * agent terminal. Single line on purpose: it is submitted as-is into their
 * prompt box, and without this agents tend to just work alone. */
function buildBroadcastPrompt(text: string, leader: string): string {
  return (
    "📣 MENSAJE DEL USUARIO PARA TODO EL EQUIPO — varios agentes trabajáis juntos en este " +
    "proyecto mediante el MCP «lienzo-team». Petición: «" +
    text +
    "». Antes de empezar, llama a team_context para ver compañeros, tareas y reservas. " +
    (leader ? `Líder del equipo: ${leader}; respeta su reparto. ` : "") +
    "Descompón el trabajo: crea tareas con team_task_create o reclama las abiertas con " +
    "team_task_claim; publica tu plan y cada avance con team_update; reserva los archivos " +
    "con team_claim_files antes de editarlos; y usa team_message para coordinarte con los " +
    "demás agentes. Al terminar tu parte, publica un resumen con team_update."
  );
}

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
  const [broadcastDraft, setBroadcastDraft] = useState("");
  const [charterDraft, setCharterDraft] = useState("");
  const [leaderDraft, setLeaderDraft] = useState("");
  const charterInit = useRef(false);
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

  // Load the team charter / leader into the drafts once (don't clobber edits).
  useEffect(() => {
    if (state && !charterInit.current) {
      charterInit.current = true;
      setCharterDraft(state.charter ?? "");
      setLeaderDraft(state.leader ?? "");
    }
  }, [state]);

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

  /** Broadcast a prompt to the whole team: feed + typing into agent terminals. */
  const sendBroadcast = async () => {
    const text = broadcastDraft.trim();
    if (!text) return;
    try {
      await teamBroadcast(text);
      // Type it into every agent terminal running on the canvas, wrapped with
      // the team protocol so agents actually coordinate with each other.
      const typedPrompt = buildBroadcastPrompt(text, (state?.leader ?? "").trim());
      const panels = getLayout().panels.filter(
        (p) => p.kind === "terminal" && !!p.sessionId && !!p.cmd,
      );
      const agentsTyped = new Set<string>();
      for (const p of panels) {
        try {
          await termWrite(p.sessionId!, `${typedPrompt}\r`);
          agentsTyped.add(agentKeyFromCmd(p.cmd ?? ""));
        } catch {
          /* session may have died; the feed still has the message */
        }
      }
      if (agentsTyped.size > 0) {
        // Typed = delivered for those agents; skip duplicate hook delivery.
        await teamBroadcastAck([...agentsTyped]).catch(() => {});
      }
      setBroadcastDraft("");
      refresh();
      say(
        agentsTyped.size > 0
          ? `📣 Enviado al feed y escrito en ${agentsTyped.size} terminal(es), con instrucciones de coordinación.`
          : "📣 Publicado para el equipo (no hay terminales de agentes abiertas ahora mismo).",
      );
    } catch (e) {
      say(errMsg(e), true);
    }
  };

  const saveCharter = async () => {
    try {
      await teamCharter(
        charterDraft.trim() ? charterDraft : null,
        leaderDraft.trim() ? leaderDraft.trim() : null,
      );
      refresh();
      say("✓ Normas del equipo y líder guardados.");
    } catch (e) {
      say(errMsg(e), true);
    }
  };

  const events = state?.events ?? [];
  const tasks = state?.tasks ?? [];
  const agents = state?.agents ?? [];
  const claims = state?.claims ?? [];
  const online = agents.filter((a) => a.online).length;
  const openTasks = tasks.filter((t) => t.status !== "done").length;

  const leaderOptions = (() => {
    const opts: { id: string; label: string }[] = [];
    const seen = new Set<string>();
    for (const a of detect?.agents ?? []) {
      if (!seen.has(a.id)) {
        seen.add(a.id);
        opts.push({ id: a.id, label: a.label });
      }
    }
    for (const a of agents) {
      if (!seen.has(a.name)) {
        seen.add(a.name);
        opts.push({ id: a.name, label: a.name });
      }
    }
    if (leaderDraft && !seen.has(leaderDraft)) {
      opts.push({ id: leaderDraft, label: leaderDraft });
    }
    return opts;
  })();

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

      <div className="team-broadcast">
        <input
          type="text"
          value={broadcastDraft}
          placeholder="Prompt para TODO el equipo (se escribe en sus terminales)…"
          onChange={(e) => setBroadcastDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") sendBroadcast();
          }}
        />
        <button
          className="agent-btn"
          disabled={!broadcastDraft.trim()}
          onClick={sendBroadcast}
          title="Publica el prompt en el feed y lo escribe en las terminales de agentes abiertas"
        >
          📣 Enviar
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

            <div className="team-section-title">Normas del equipo y líder</div>
            <textarea
              className="team-charter"
              value={charterDraft}
              rows={6}
              placeholder="Instrucciones globales para todos los agentes (cómo trabajar juntos)…"
              onChange={(e) => setCharterDraft(e.target.value)}
            />
            <div className="team-project">
              <select
                className="team-select"
                value={leaderDraft}
                onChange={(e) => setLeaderDraft(e.target.value)}
                title="Quién coordina al equipo"
              >
                <option value="">— sin líder —</option>
                {leaderOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label} (líder)
                  </option>
                ))}
              </select>
              <button className="agent-btn" onClick={saveCharter}>
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
                    {state?.leader === a.name ? <span className="prog-lead">líder</span> : null}
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
