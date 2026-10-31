// Despachador ligero: cada pocos segundos pide a los agentes libres que tomen las tareas listas
// (y le recuerda a su dueño una tarea que quedó a medias al cerrar Prometeo).
import { useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { Panel } from "../../store";
import { agentLabel, errMsg, teamDm } from "../../lib/team";
import type { InboxInfo, TeamAgent, TeamEvent, TeamTask } from "../../lib/team";
import { dispatchPrompt, remindPrompt, sendFailed, tick as dispatchTick, verdictHold } from "../../lib/dispatcher";
import type { DAgent, DispatchState } from "../../lib/dispatcher";
import { termWrite } from "../../lib/pty";
import { isPrimary } from "../../lib/bridge";
import { termLastBusyMs } from "../../lib/activity";
import { dispatchConfig, getSettings } from "../../lib/settings";
import { quotaPace } from "../../lib/limits";
import type { AgentLimits } from "../../lib/limits";
import type { AgentState } from "../TeamModal";
import { BOOT_MS, WORK_KINDS, claimTimes, panelForAgent } from "./shared";

/** Lo último que el ciclo necesita ver (lo actualiza el Centro de Mando en cada render). */
export type DispatchLatest = {
    tasks: TeamTask[];
    agents: TeamAgent[];
    leader: string;
    director: boolean;
    blocked: string[];
    panels: Panel[];
    lastByAgent: Map<string, TeamEvent>;
    events: TeamEvent[];
    states: Map<string, AgentState>;
    inbox: Record<string, InboxInfo>;
    /** Límites de uso de cada agente (para repartir lo difícil según su cuota). */
    limits?: Record<string, AgentLimits>;
  };

export function useDispatchLoop({
  dispatchOn,
  say,
  latestRef,
  dispatchRef,
  dispatchBusy,
  switchModelRef,
  modelNow,
  setDispatchView,
}: {
  dispatchOn: boolean;
  say: (text: string, err?: boolean) => void;
  latestRef: MutableRefObject<DispatchLatest | null>;
  dispatchRef: MutableRefObject<DispatchState>;
  dispatchBusy: MutableRefObject<boolean>;
  /** Reinicia a un agente con otro modelo (para una tarea programada que lo pide). */
  switchModelRef: MutableRefObject<(name: string, model: string) => Promise<boolean>>;
  /** El modelo con el que se reinició a cada agente. */
  modelNow: MutableRefObject<Record<string, string>>;
  setDispatchView: Dispatch<SetStateAction<DispatchState>>;
}) {
  useEffect(() => {
    // El despacho lo hace solo la ventana del PC; en el iPad se dispararía dos veces.
    if (!dispatchOn || !isPrimary()) return;
    const run = async () => {
      const cur = latestRef.current;
      if (!cur || dispatchBusy.current) return;
      dispatchBusy.current = true;
      try {
        const now = Date.now();
        const byName = new Map<string, DAgent>();
        const cfg = getSettings();
        const claims = claimTimes(cur.events);
        const lastWork = new Map<string, number>();
        for (const e of cur.events)
          if (WORK_KINDS.has(e.kind) && e.ts_ms > (lastWork.get(e.agent) ?? 0)) lastWork.set(e.agent, e.ts_ms);
        for (const a of cur.agents) {
          if (cfg.skipAgents.includes(a.name)) continue;
          const prev = byName.get(a.name);
          const sid = panelForAgent(cur.panels, a.name)?.sessionId;
          byName.set(a.name, {
            name: a.name,
            online: (prev?.online ?? false) || a.online,
            hasTerminal: !!sid,
            blocked: cur.blocked.includes(a.name),
            lastActivityMs: cur.lastByAgent.get(a.name)?.ts_ms ?? 0,
            lastWorkMs: lastWork.get(a.name) ?? 0,
            busy: !!sid && now - termLastBusyMs(sid) < 5_000,
            pace: quotaPace(cur.limits?.[a.name], now),
          });
        }
        const res = dispatchTick(dispatchRef.current, {
          now,
          tasks: cur.tasks.map((t) => ({
            id: t.id,
            title: t.title,
            notes: t.notes,
            status: t.status,
            owner: t.owner,
            parents: t.parents ?? [],
            level: t.level ?? "",
            assign: t.assign ?? "",
            claimedMs: claims.get(t.id) ?? 0,
          })),
          agents: [...byName.values()],
          leader: cur.leader,
          director: cur.director,
          bootMs: BOOT_MS,
          holdUntil: verdictHold(cur.events, cur.leader, now),
        }, dispatchConfig(cfg));
        let next = res.state;
        for (const note of res.notes) say(note, true);
        if (res.send) {
          const { taskId, agent } = res.send;
          const task = cur.tasks.find((t) => t.id === taskId);
          const panel = panelForAgent(cur.panels, agent);
          try {
            if (!task || !panel?.sessionId) throw new Error("sin terminal");
            // Programada con modelo propio (nunca al líder: le cambiaría el suyo). Claude lo cambia
            // en caliente con /model; Antigravity solo al arrancar, así que se reinicia con él
            // (retomando su conversación) y la tarea le llega cuando vuelve.
            const model = (task.model ?? "").trim();
            const okModel = /^[\w.:/@+-]{2,60}$/.test(model) && agent !== cur.leader;
            const restarts = /antigravity|agy|opencode/i.test(agent);
            const hasIt = (panel.cmd ?? "").includes(`--model ${model}`) || modelNow.current[agent] === model;
            if (okModel && restarts && !hasIt) {
              if (!(await switchModelRef.current(agent, model))) throw new Error(`no se pudo reiniciar con ${model}`);
              const { [taskId]: _sent, ...pending } = next.pending;
              next = { ...next, pending, agentPausedUntil: { ...next.agentPausedUntil, [agent]: now + 30_000 } };
              say(`🔁 ${agentLabel(agent)} se reinicia con ${model} para #${taskId}; se la paso en cuanto vuelva.`);
            } else {
            if (okModel && agent.toLowerCase().includes("claude")) {
              await termWrite(panel.sessionId, `/model ${model.toLowerCase()}\r`);
              await new Promise((ok) => window.setTimeout(ok, 2500));
            }
            await termWrite(
              panel.sessionId,
              `${dispatchPrompt({
                id: task.id,
                title: task.title,
                notes: task.notes,
                status: task.status,
                owner: task.owner,
                parents: task.parents ?? [],
              })}\r`,
            );
            await teamDm(agent, `📌 Despacho: #${taskId} «${task.title}»`);
            say(`📌 #${taskId} pedida a ${agentLabel(agent)}.`);
            }
          } catch (e) {
            next = sendFailed(next, taskId, agent, now);
            say(`No pude avisar a ${agentLabel(agent)}: ${errMsg(e)}`, true);
          }
        }
        if (res.remind) {
          // Una tarea que se quedó a medias al cerrar Prometeo: se le recuerda a su dueño.
          const { taskId, agent } = res.remind;
          const task = cur.tasks.find((t) => t.id === taskId);
          const panel = panelForAgent(cur.panels, agent);
          try {
            if (!task || !panel?.sessionId) throw new Error("sin terminal");
            await termWrite(
              panel.sessionId,
              `${remindPrompt({
                id: task.id,
                title: task.title,
                notes: task.notes,
                status: task.status,
                owner: task.owner,
                parents: task.parents ?? [],
              })}\r`,
            );
            say(`🔁 #${taskId} seguía a medias desde antes de abrir Prometeo: se la recordé a ${agentLabel(agent)}.`);
          } catch (e) {
            say(`No pude recordarle #${taskId} a ${agentLabel(agent)}: ${errMsg(e)}`, true);
          }
        }
        dispatchRef.current = next;
        setDispatchView(next);
      } finally {
        dispatchBusy.current = false;
      }
    };
    const id = window.setInterval(() => {
      void run();
    }, 3000);
    void run();
    return () => window.clearInterval(id);
  }, [dispatchOn, say]);
}
