import { useCallback, useEffect, useState } from "react";
import { agentColor, ago, onTeamUpdate, teamState } from "../lib/team";
import type { TeamEvent, TeamState } from "../lib/team";

const STATUS_LABEL: Record<string, string> = {
  open: "abierta",
  claimed: "en curso",
  done: "hecha",
};

/**
 * Slim vertical dashboard: how the team is doing at a glance.
 * Tasks with progress + agents online + who leads.
 */
export function TasksPanel() {
  const [state, setState] = useState<TeamState | null>(null);

  const refresh = useCallback(() => {
    teamState()
      .then(setState)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const unlisten = onTeamUpdate(refresh);
    const interval = window.setInterval(refresh, 4000);
    return () => {
      unlisten.then((f) => f());
      window.clearInterval(interval);
    };
  }, [refresh]);

  const tasks = state?.tasks ?? [];
  const agents = (state?.agents ?? []).filter((a) => a.online);
  const leader = state?.leader ?? "";
  const done = tasks.filter((t) => t.status === "done").length;
  const total = tasks.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const pending = tasks.filter((t) => t.status !== "done");

  // Latest activity per agent (what each one is doing right now).
  const lastByAgent = new Map<string, TeamEvent>();
  for (const e of state?.events ?? []) {
    if (e.kind === "join" || e.kind === "leave") continue;
    const prev = lastByAgent.get(e.agent);
    if (!prev || e.ts_ms > prev.ts_ms) lastByAgent.set(e.agent, e);
  }

  return (
    <div className="prog">
      <div className="prog-head">
        <span className="prog-title">Progreso del equipo</span>
        <span className="prog-pct">{total > 0 ? `${pct}%` : "—"}</span>
      </div>
      <div className="prog-bar">
        <div className="prog-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="prog-sub">
        {total > 0 ? `${done}/${total} tareas` : "sin tareas aún"} · {agents.length} agente
        {agents.length === 1 ? "" : "s"} en línea
      </div>

      <div className="team-section-title">Agentes — ahora mismo</div>
      {agents.length === 0 ? (
        <div className="prog-empty">Ninguno conectado todavía.</div>
      ) : (
        agents.map((a) => {
          const last = lastByAgent.get(a.name);
          return (
            <div className="prog-agent" key={a.session_id}>
              <div className="prog-agent-row">
                <span className="agent-dot" data-on="1" />
                <span style={{ color: agentColor(a.name) }}>{a.name}</span>
                {leader === a.name && <span className="prog-lead">líder</span>}
                <span className="prog-seen">hace {ago(a.last_seen_ms)}</span>
              </div>
              <div className="prog-now" title={last?.text}>
                {last ? last.text : "en línea, sin actividad aún"}
              </div>
            </div>
          );
        })
      )}

      <div className="team-section-title">Tareas pendientes</div>
      {pending.length === 0 ? (
        <div className="prog-empty">
          {total === 0
            ? "Sin tareas todavía. Manda un 📣 al equipo pidiendo que reparta el trabajo, o créalas en la pestaña Tareas."
            : "¡Todo hecho! 🎉"}
        </div>
      ) : (
        pending.map((t) => (
          <div className="prog-task" key={t.id}>
            <span className="task-chip" data-s={t.status}>
              #{t.id} {STATUS_LABEL[t.status] ?? t.status}
            </span>
            <span className="prog-task-title">
              {t.title}
              {t.owner ? <span className="agent-meta"> — {t.owner}</span> : null}
            </span>
          </div>
        ))
      )}

      {done > 0 && (
        <>
          <div className="team-section-title">Completadas</div>
          {tasks
            .filter((t) => t.status === "done")
            .slice(-6)
            .reverse()
            .map((t) => (
              <div className="prog-task" key={t.id} data-done="1">
                <span className="task-chip" data-s="done">
                  #{t.id} hecha
                </span>
                <span className="prog-task-title">
                  {t.title}
                  {t.owner ? <span className="agent-meta"> — {t.owner}</span> : null}
                </span>
              </div>
            ))}
        </>
      )}
    </div>
  );
}
