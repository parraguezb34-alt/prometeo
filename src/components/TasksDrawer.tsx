import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { agentColor, agentInitial, agentLabel, ago, shortPath } from "../lib/team";
import { waitingFor } from "../lib/team";
import { isParked } from "../lib/dispatcher";
import type { DispatchState } from "../lib/dispatcher";
import type { MemoryEntry, TeamEvent, TeamTask } from "../lib/team";
import { GLYPHS } from "./FeedList";
import { Icon } from "./Icon";
import { MemoryTab } from "./MemoryTab";
import { ProjectMemory } from "./ProjectMemory";

type Filter = "all" | "active" | "done";

/**
 * Panel lateral de tareas y actividad. Se abre desde la cabecera, donde el
 * progreso (hechas/total) y los bloqueos quedan siempre a la vista.
 */
export function TasksDrawer({
  tasks,
  events,
  agentNames,
  blocked,
  lastByAgent,
  taskFileCount,
  activeTaskId,
  hasProject,
  initialTab = "tasks",
  memory,
  leader,
  onComment,
  onMemoryAdd,
  onMemoryResolve,
  onMemoryForget,
  dispatch,
  onPreview,
  onClose,
  onOpenTask,
  onTaskOp,
  onAddTask,
  onAnswer,
  onTerminal,
  onSelectAgent,
}: {
  tasks: TeamTask[];
  events: TeamEvent[];
  agentNames: string[];
  blocked: string[];
  lastByAgent: Map<string, TeamEvent>;
  taskFileCount: Map<number, number>;
  activeTaskId: number | null;
  hasProject: boolean;
  initialTab?: "tasks" | "feed" | "handover" | "memory";
  /** Memoria del proyecto (guardada y propuestas). */
  memory: MemoryEntry[];
  leader: string;
  onComment: (id: number, text: string) => Promise<void>;
  onMemoryAdd: (text: string, kind: string) => Promise<void>;
  onMemoryResolve: (id: number, accept: boolean, text?: string) => Promise<void>;
  onMemoryForget: (id: number) => Promise<void>;
  /** Despacho automático: interruptor, estado de los avisos y reintento de tareas paradas. */
  dispatch: {
    enabled: boolean;
    state: DispatchState;
    onToggle: (on: boolean) => void;
    onRetry: (id: number) => void;
  };
  onPreview: (rel: string) => void;
  onClose: () => void;
  onOpenTask: (id: number) => void;
  onTaskOp: (id: number, op: string) => void;
  onAddTask: (title: string, parents: number[]) => Promise<void>;
  onAnswer: (name: string) => void;
  onTerminal: (name: string) => void;
  onSelectAgent: (name: string) => void;
}) {
  const [tab, setTab] = useState<"tasks" | "feed" | "handover" | "memory">(initialTab);
  const [filter, setFilter] = useState<Filter>("all");
  const [draft, setDraft] = useState("");
  const [deps, setDeps] = useState<number[]>([]);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [depsOpen, setDepsOpen] = useState(false);
  /** Tarea que espera confirmación para borrarse (se pide un segundo clic). */
  const [delAsk, setDelAsk] = useState<number | null>(null);
  useEffect(() => {
    if (delAsk == null) return;
    const id = window.setTimeout(() => setDelAsk(null), 4000);
    return () => window.clearTimeout(id);
  }, [delAsk]);

  const pausedAgents = Object.entries(dispatch.state.agentPausedUntil)
    .filter(([, until]) => until > Date.now())
    .map(([name]) => agentLabel(name));
  const done = tasks.filter((t) => t.status === "done").length;
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;

  const shown = useMemo(
    () =>
      tasks
        .filter((t) =>
          filter === "all" ? true : filter === "done" ? t.status === "done" : t.status !== "done",
        )
        .slice()
        .reverse(),
    [tasks, filter],
  );
  const feed = useMemo(() => events.slice(0, 120), [events]);

  const add = async () => {
    const t = draft.trim();
    if (!t) return;
    await onAddTask(t, deps);
    setDraft("");
    setDeps([]);
    setDepsOpen(false);
  };

  return (
    <>
      <div className="cc-scrim" data-light="1" onClick={onClose} />
      <aside className="cc-tdrawer" aria-label="Tareas y actividad">
        <div className="cc-tdrawer-top">
          <h3>Tareas</h3>
          <button className="cc-icon-btn" onClick={onClose} aria-label="Cerrar" title="Cerrar (Esc)">
            <Icon name="x" />
          </button>
        </div>

        <div className="cc-tprog">
          <div className="cc-tprog-row">
            <span>Avance del equipo</span>
            <b>
              {done} de {tasks.length} hechas
            </b>
          </div>
          <div className="cc-meter">
            <i style={{ width: `${pct}%` }} />
          </div>
          <div className="cc-dispatch-row">
            <button
              className="cc-toggle"
              aria-pressed={dispatch.enabled}
              onClick={() => dispatch.onToggle(!dispatch.enabled)}
              title="Cuando una tarea esté lista y un agente libre, lienzo le escribe que la tome. Un trabajo en curso por agente."
            >
              <span className="cc-sw" />
              Despacho automático
            </button>
            <span className="cc-dispatch-hint">
              {!dispatch.enabled
                ? "Apagado: repartes tú o el líder."
                : pausedAgents.length > 0
                  ? `En pausa: ${pausedAgents.join(", ")}`
                  : "Pide las tareas listas a los agentes libres."}
            </span>
          </div>
        </div>

        <div className="cc-pilltabs" role="tablist">
          <button role="tab" aria-selected={tab === "tasks"} onClick={() => setTab("tasks")}>
            <Icon name="list" size={14} />
            Tareas <span className="cc-count">{tasks.filter((t) => t.status !== "done").length}</span>
          </button>
          <button role="tab" aria-selected={tab === "feed"} onClick={() => setTab("feed")}>
            <Icon name="pulse" size={14} />
            Actividad
          </button>
          <button role="tab" aria-selected={tab === "handover"} onClick={() => setTab("handover")}>
            <Icon name="refresh" size={14} />
            Relevos <span className="cc-count">{tasks.filter((t) => t.handover).length}</span>
          </button>
          <button role="tab" aria-selected={tab === "memory"} onClick={() => setTab("memory")}>
            <Icon name="book" size={14} />
            Memoria{" "}
            <span className="cc-count" data-hot={memory.some((m) => m.status === "proposed") ? "1" : "0"}>
              {memory.filter((m) => m.status === "active").length}
              {memory.some((m) => m.status === "proposed") ? "+" : ""}
            </span>
          </button>
        </div>

        <div className="cc-tdrawer-body">
          {tab === "tasks" ? (
            <>
              <div className="cc-td-filters">
                {(
                  [
                    ["all", "Todas"],
                    ["active", "En curso"],
                    ["done", "Hechas"],
                  ] as [Filter, string][]
                ).map(([k, label]) => (
                  <button key={k} data-active={filter === k ? "1" : "0"} onClick={() => setFilter(k)}>
                    {label}
                  </button>
                ))}
              </div>

              {blocked.map((name) => {
                const ev = lastByAgent.get(name);
                return (
                  <div className="cc-blocker" key={name}>
                    <div className="cc-blocker-h">
                      <Icon name="warn" size={14} />
                      {agentLabel(name)} necesita tu respuesta
                      {ev ? <span className="cc-blocker-ago">hace {ago(ev.ts_ms)}</span> : null}
                    </div>
                    <div className="cc-blocker-t">{ev?.text ?? "pide tu respuesta"}</div>
                    <div className="cc-btn-row">
                      <button className="cc-btn warn" onClick={() => onAnswer(name)}>
                        Responder
                      </button>
                      <button className="cc-btn sec" onClick={() => onTerminal(name)}>
                        <Icon name="term" size={14} />
                        Terminal
                      </button>
                    </div>
                  </div>
                );
              })}

              {tasks.length === 0 && (
                <div className="cc-td-empty">
                  Sin tareas. El equipo las crea al trabajar, o añade una aquí abajo.
                </div>
              )}

              {shown.map((t) => {
                const waiting = waitingFor(t, tasks);
                return (
                <div
                  className="cc-td-task"
                  key={t.id}
                  data-done={t.status === "done" ? "1" : "0"}
                  data-active={activeTaskId === t.id ? "1" : "0"}
                  onClick={() => onOpenTask(t.id)}
                  title={
                    hasProject
                      ? `Ver los cambios de la tarea #${t.id}`
                      : "Elige la carpeta del proyecto para ver cambios"
                  }
                >
                  <span className="cc-td-id">#{t.id}</span>
                  <div className="cc-td-main">
                    <div className="cc-td-title">{t.title}</div>
                    {t.status !== "done" && waiting.length > 0 && (
                      <div className="cc-td-wait" title="No se puede reclamar hasta que terminen sus tareas padre">
                        <Icon name="lock" size={12} />
                        Espera a {waiting.map((id) => `#${id}`).join(", ")}
                      </div>
                    )}
                    {t.status === "done" || waiting.length === 0
                      ? (t.parents ?? []).length > 0 && (
                          <div className="cc-td-deps">
                            Depende de {(t.parents ?? []).map((id) => `#${id}`).join(", ")}
                          </div>
                        )
                      : null}
                    {dispatch.enabled && t.status === "open" && dispatch.state.pending[t.id] && (
                      <div className="cc-td-disp">
                        <Icon name="pulse" size={12} />
                        Pedida a {agentLabel(dispatch.state.pending[t.id].agent)}
                      </div>
                    )}
                    {t.status === "open" && isParked(dispatch.state, t.id) && (
                      <div className="cc-td-parked">
                        Nadie la reclamó tras {dispatch.state.taskFails[t.id]} avisos
                        <button
                          className="cc-td-retry"
                          onClick={(e) => {
                            e.stopPropagation();
                            dispatch.onRetry(t.id);
                          }}
                        >
                          Reintentar
                        </button>
                      </div>
                    )}
                    <div className="cc-td-meta">
                      {t.owner ? (
                        <span
                          className="cc-mini-av"
                          style={{ "--ac": agentColor(t.owner) } as CSSProperties}
                        >
                          {agentInitial(t.owner)}
                        </span>
                      ) : null}
                      <span>
                        {t.owner ? `${agentLabel(t.owner)} · ` : "Sin dueño · "}
                        {taskFileCount.get(t.id)
                          ? `${taskFileCount.get(t.id)} archivo${taskFileCount.get(t.id) === 1 ? "" : "s"}`
                          : "sin archivos aún"}
                      </span>
                      {t.handover && (
                        <span
                          className="cc-td-handover"
                          title={`Relevo de ${t.handover.by} hace ${ago(t.handover.ts_ms)}: ${t.handover.text}`}
                        >
                          <Icon name="book" size={13} />
                        </span>
                      )}
                    </div>
                    <details className="cc-td-board" onClick={(e) => e.stopPropagation()}>
                      <summary>
                        Tablón{(t.comments ?? []).length > 0 ? ` (${(t.comments ?? []).length})` : ""}
                      </summary>
                      {(t.comments ?? []).map((c, i) => (
                        <div className="cc-td-note" key={i} style={{ "--ac": agentColor(c.by) } as CSSProperties}>
                          <b>{c.by === "tú" ? "Tú" : agentLabel(c.by)}</b>
                          <span>{c.text}</span>
                          <time>{ago(c.ts_ms)}</time>
                        </div>
                      ))}
                      <input
                        className="cc-td-noteinput"
                        type="text"
                        placeholder="Dejar una nota para quien la lleve…"
                        value={notes[t.id] ?? ""}
                        onChange={(e) => setNotes((cur) => ({ ...cur, [t.id]: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") return;
                          const text = (notes[t.id] ?? "").trim();
                          if (!text) return;
                          void onComment(t.id, text).then(() => setNotes((cur) => ({ ...cur, [t.id]: "" })));
                        }}
                      />
                    </details>
                    {t.result && (
                      <details className="cc-td-result" onClick={(e) => e.stopPropagation()}>
                        <summary>Entrega de {agentLabel(t.result.by)}</summary>
                        <p>{t.result.summary}</p>
                        {t.result.files.length > 0 && (
                          <div className="cc-td-rfiles">
                            {t.result.files.map((f) => (
                              <span className="cc-file-chip" key={f} title={f}>
                                {shortPath(f)}
                              </span>
                            ))}
                          </div>
                        )}
                        {t.result.evidence && <p className="cc-td-evidence">Comprobado: {t.result.evidence}</p>}
                      </details>
                    )}
                  </div>
                  <div className="cc-td-side">
                    <span className="cc-td-status" data-s={t.status}>
                      <span className="cc-td-dot" data-s={t.status} />
                      {t.status === "done" ? "Hecha" : t.status === "claimed" ? "En curso" : "Abierta"}
                    </span>
                    <button
                      className="cc-icon-btn sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onTaskOp(t.id, t.status === "done" ? "reopen" : "done");
                      }}
                      title={t.status === "done" ? "Reabrir" : "Marcar hecha"}
                      aria-label={t.status === "done" ? "Reabrir tarea" : "Marcar hecha"}
                    >
                      {t.status === "done" ? <Icon name="refresh" size={14} /> : <Icon name="check" size={14} />}
                    </button>
                    <button
                      className="cc-icon-btn sm cc-td-del"
                      data-ask={delAsk === t.id ? "1" : "0"}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (delAsk === t.id) {
                          setDelAsk(null);
                          onTaskOp(t.id, "delete");
                        } else {
                          setDelAsk(t.id);
                        }
                      }}
                      title={delAsk === t.id ? "Pulsa otra vez para borrarla" : "Borrar tarea"}
                      aria-label={delAsk === t.id ? "Confirmar borrado" : "Borrar tarea"}
                    >
                      {delAsk === t.id ? <span className="cc-td-delq">¿Borrar?</span> : <Icon name="trash" size={14} />}
                    </button>
                  </div>
                </div>
                );
              })}
            </>
          ) : tab === "handover" ? (
            <MemoryTab tasks={tasks} onOpenTask={onOpenTask} onPreview={onPreview} />
          ) : tab === "memory" ? (
            <ProjectMemory
              memory={memory}
              leader={leader}
              onAdd={onMemoryAdd}
              onResolve={onMemoryResolve}
              onForget={onMemoryForget}
            />
          ) : (
            <>
              {feed.length === 0 && <div className="cc-td-empty">Aún no hay actividad del equipo.</div>}
              {feed.map((e) => (
                <div className="cc-td-feed" key={e.seq} style={{ "--ac": agentColor(e.agent) } as CSSProperties}>
                  <span className="cc-td-fglyph">{GLYPHS[e.kind] ?? "•"}</span>
                  <span className="cc-td-ftxt">
                    <button
                      className="cc-td-fagent"
                      onClick={() => {
                        if (agentNames.includes(e.agent)) onSelectAgent(e.agent);
                      }}
                      title={agentNames.includes(e.agent) ? `Abrir la conversación con ${e.agent}` : e.agent}
                    >
                      {e.agent === "tú" ? "Tú" : agentLabel(e.agent)}
                    </button>{" "}
                    {e.text}
                    {e.files.length > 0 && (
                      <span className="feed-files"> · {e.files.map(shortPath).join(", ")}</span>
                    )}
                  </span>
                  <time>{ago(e.ts_ms)}</time>
                </div>
              ))}
            </>
          )}
        </div>

        {tab === "tasks" && (
          <div className="cc-tdrawer-addwrap">
            {depsOpen && (
              <div className="cc-deps-pick">
                <span className="cc-deps-l">Depende de</span>
                {tasks.filter((t) => t.status !== "done").length === 0 && (
                  <span className="cc-deps-none">No hay tareas pendientes.</span>
                )}
                {tasks
                  .filter((t) => t.status !== "done")
                  .map((t) => (
                    <button
                      key={t.id}
                      className="cc-deps-chip"
                      data-on={deps.includes(t.id) ? "1" : "0"}
                      title={t.title}
                      onClick={() =>
                        setDeps((cur) => (cur.includes(t.id) ? cur.filter((x) => x !== t.id) : [...cur, t.id]))
                      }
                    >
                      #{t.id}
                    </button>
                  ))}
              </div>
            )}
            <div className="cc-tdrawer-add">
              <input
                type="text"
                value={draft}
                placeholder={deps.length > 0 ? `Nueva tarea (tras ${deps.map((x) => `#${x}`).join(", ")})…` : "Nueva tarea…"}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void add();
                }}
              />
              <button
                className="cc-deps-btn"
                data-on={deps.length > 0 ? "1" : "0"}
                onClick={() => setDepsOpen((o) => !o)}
                title="Que esta tarea espere a otras"
                aria-label="Dependencias"
              >
                <Icon name="lock" size={14} />
                {deps.length > 0 ? deps.length : null}
              </button>
              <button className="cc-send-mini" onClick={() => void add()} disabled={!draft.trim()} aria-label="Crear tarea">
                <Icon name="plus" size={15} />
              </button>
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
