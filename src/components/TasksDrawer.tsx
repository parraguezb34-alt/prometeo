import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { stampLabel } from "../lib/chats";
import { agentColor, agentInitial, agentLabel, shortPath, waitingFor } from "../lib/team";
import { isParked } from "../lib/dispatcher";
import type { DispatchState } from "../lib/dispatcher";
import { dispatchConfig, useSettings } from "../lib/settings";
import type { MemoryEntry, TeamEvent, TeamTask } from "../lib/team";
import { stepOf } from "../lib/steps";
import { askPhrase, isNotice, parseTask, span } from "../lib/timeline";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { MemoryTab } from "./MemoryTab";
import { ProjectMemory } from "./ProjectMemory";

type Tab = "tasks" | "feed" | "handover" | "memory";
type Scope = "chat" | "project";

/** «5. Integración final» → «Integración final»: el número ya lo pone #id. */
const cleanTitle = (t: string) => t.replace(/^\s*\d+\s*[.)-]\s+/, "");
const LEVEL_LABEL: Record<string, string> = { simple: "simple", media: "media", dificil: "difícil" };
/** «hace 5 min» si es reciente; si no, la hora (hoy) o el día. */
const since = (ts: number) => (Date.now() - ts < 3600_000 ? `hace ${span(Date.now() - ts)}` : stampLabel(ts));

function Av({ agent }: { agent: string }) {
  return (
    <span className="td-av" style={{ "--ac": agentColor(agent) } as CSSProperties} title={agentLabel(agent)}>
      {agentInitial(agent)}
    </span>
  );
}

/**
 * Panel lateral del chat: sus tareas, lo que hizo el equipo (actividad), relevos y memoria.
 * Las tareas viven en el hub para todo el proyecto, pero aquí se ven las del chat abierto.
 */
export function TasksDrawer({
  tasks,
  earlier,
  allTasks,
  chatTitle,
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
  onOpenPath,
  onClose,
  onOpenTask,
  onTaskOp,
  onAddTask,
  onAnswer,
  onTerminal,
  onSelectAgent,
}: {
  /** Tareas de este chat. */
  tasks: TeamTask[];
  /** Sin terminar, de chats anteriores. */
  earlier: TeamTask[];
  /** Todas las del proyecto. */
  allTasks: TeamTask[];
  chatTitle: string;
  /** Eventos de este chat, del más nuevo al más viejo. */
  events: TeamEvent[];
  agentNames: string[];
  blocked: string[];
  lastByAgent: Map<string, TeamEvent>;
  taskFileCount: Map<number, number>;
  activeTaskId: number | null;
  hasProject: boolean;
  initialTab?: Tab;
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
  onOpenPath: (path: string) => void;
  onClose: () => void;
  onOpenTask: (id: number) => void;
  onTaskOp: (id: number, op: string) => void;
  onAddTask: (title: string, parents: number[]) => Promise<void>;
  onAnswer: (name: string) => void;
  onTerminal: (name: string) => void;
  onSelectAgent: (name: string) => void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [scope, setScope] = useState<Scope>("chat");
  const [draft, setDraft] = useState("");
  const [deps, setDeps] = useState<number[]>([]);
  const [depsOpen, setDepsOpen] = useState(false);

  const list = scope === "chat" ? tasks : allTasks;
  const done = list.filter((t) => t.status === "done").length;
  const pct = list.length ? Math.round((done / list.length) * 100) : 0;
  const pausedAgents = Object.entries(dispatch.state.agentPausedUntil)
    .filter(([, until]) => until > Date.now())
    .map(([name]) => agentLabel(name));

  const groups = useMemo(() => {
    const newest = (a: TeamTask, b: TeamTask) => b.id - a.id;
    return [
      { key: "review", label: "En revisión", items: list.filter((t) => t.status === "review").sort(newest) },
      { key: "claimed", label: "En curso", items: list.filter((t) => t.status === "claimed").sort(newest) },
      { key: "open", label: "Por hacer", items: list.filter((t) => t.status === "open" || t.status === "draft").sort(newest) },
      { key: "done", label: "Hechas", items: list.filter((t) => t.status === "done").sort(newest) },
    ];
  }, [list]);

  const add = async () => {
    const t = draft.trim();
    if (!t) return;
    await onAddTask(t, deps);
    setDraft("");
    setDeps([]);
    setDepsOpen(false);
  };

  const row = (t: TeamTask) => (
    <TaskRow
      key={t.id}
      t={t}
      all={allTasks}
      files={taskFileCount.get(t.id) ?? 0}
      active={activeTaskId === t.id}
      hasProject={hasProject}
      dispatch={dispatch}
      onComment={onComment}
      onOpenTask={onOpenTask}
      onOpenPath={onOpenPath}
      onTaskOp={onTaskOp}
    />
  );

  const openCount = tasks.filter((t) => t.status !== "done").length;
  const active = memory.filter((m) => m.status === "active").length;
  const proposed = memory.some((m) => m.status === "proposed");

  return (
    <>
      <div className="cc-scrim" data-light="1" onClick={onClose} />
      <aside className="cc-tdrawer td" aria-label="Tareas y actividad del chat">
        <div className="cc-tdrawer-top">
          <div className="td-head">
            <h3>Panel del chat</h3>
            <span className="td-chat" title={chatTitle}>
              {chatTitle}
            </span>
          </div>
          <button className="cc-icon-btn" onClick={onClose} aria-label="Cerrar" title="Cerrar (Esc)">
            <Icon name="x" />
          </button>
        </div>

        <div className="td-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "tasks"} onClick={() => setTab("tasks")}>
            Tareas{openCount > 0 && <span className="td-n">{openCount}</span>}
          </button>
          <button role="tab" aria-selected={tab === "feed"} onClick={() => setTab("feed")}>
            Actividad
          </button>
          <button role="tab" aria-selected={tab === "handover"} onClick={() => setTab("handover")}>
            Relevos
            {allTasks.some((t) => t.handover) && (
              <span className="td-n">{allTasks.filter((t) => t.handover).length}</span>
            )}
          </button>
          <button role="tab" aria-selected={tab === "memory"} onClick={() => setTab("memory")}>
            Memoria
            {(active > 0 || proposed) && (
              <span className="td-n" data-hot={proposed ? "1" : "0"}>
                {active}
                {proposed ? "+" : ""}
              </span>
            )}
          </button>
        </div>

        <div className="cc-tdrawer-body td-body" key={tab}>
          {tab === "tasks" ? (
            <>
              <div className="td-bar">
                <div className="td-seg" role="radiogroup" aria-label="Qué tareas ver">
                  <button role="radio" aria-checked={scope === "chat"} onClick={() => setScope("chat")}>
                    Este chat
                  </button>
                  <button role="radio" aria-checked={scope === "project"} onClick={() => setScope("project")}>
                    Todo el proyecto
                  </button>
                </div>
                <button
                  className="td-auto"
                  aria-pressed={dispatch.enabled}
                  onClick={() => dispatch.onToggle(!dispatch.enabled)}
                  title={
                    !dispatch.enabled
                      ? "Despacho automático apagado: repartes tú o el líder."
                      : pausedAgents.length > 0
                        ? `Despacho automático. En pausa: ${pausedAgents.join(", ")}`
                        : "Despacho automático: cuando una tarea del chat abierto está lista y un agente libre, lienzo le pide que la tome."
                  }
                >
                  <span className="cc-sw" />
                  Auto
                </button>
              </div>

              {list.length > 0 && (
                <div className="td-prog">
                  <div className="td-prog-row">
                    <span>{scope === "chat" ? "Avance de este chat" : "Avance del proyecto"}</span>
                    <b>
                      {done} de {list.length}
                    </b>
                  </div>
                  <div className="td-meter" data-full={pct === 100 ? "1" : "0"}>
                    <i style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )}

              {blocked.map((name) => {
                const ev = lastByAgent.get(name);
                return (
                  <div className="cc-blocker" key={name}>
                    <div className="cc-blocker-h">
                      <Icon name="warn" size={14} />
                      {agentLabel(name)} necesita tu respuesta
                      {ev ? <span className="cc-blocker-ago">{since(ev.ts_ms)}</span> : null}
                    </div>
                    <div className="cc-blocker-t">{ev ? askPhrase(ev.text) : "pide tu respuesta"}</div>
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

              {list.length === 0 && (
                <div className="td-empty">
                  <Icon name="list" size={20} />
                  <b>{scope === "chat" ? "Este chat aún no tiene tareas" : "El proyecto no tiene tareas"}</b>
                  <span>
                    El líder las crea al repartir una misión. También puedes añadir una abajo.
                  </span>
                </div>
              )}

              {groups.map((g) =>
                g.items.length === 0 ? null : (
                  <Group
                    key={`${scope}-${g.key}`}
                    label={g.label}
                    count={g.items.length}
                    status={g.key}
                    // Muchas hechas se pliegan para que lo pendiente quede arriba, salvo que no haya nada más.
                    startOpen={g.key !== "done" || g.items.length <= 6 || done === list.length}
                  >
                    {g.items.map(row)}
                  </Group>
                ),
              )}

              {scope === "chat" && earlier.length > 0 && (
                <Group
                  label="Sin terminar de chats anteriores"
                  count={earlier.length}
                  status="earlier"
                  startOpen={false}
                >
                  {earlier.slice().sort((a, b) => b.id - a.id).map(row)}
                </Group>
              )}
            </>
          ) : tab === "handover" ? (
            <MemoryTab tasks={allTasks} onOpenTask={onOpenTask} onPreview={onPreview} />
          ) : tab === "memory" ? (
            <ProjectMemory
              memory={memory}
              leader={leader}
              onAdd={onMemoryAdd}
              onResolve={onMemoryResolve}
              onForget={onMemoryForget}
            />
          ) : (
            <Activity
              events={events}
              tasks={allTasks}
              agentNames={agentNames}
              onOpenPath={onOpenPath}
              onOpenTask={onOpenTask}
              onSelectAgent={onSelectAgent}
            />
          )}
        </div>

        {tab === "tasks" && (
          <div className="cc-tdrawer-addwrap">
            {depsOpen && (
              <div className="cc-deps-pick">
                <span className="cc-deps-l">Depende de</span>
                {allTasks.filter((t) => t.status !== "done").length === 0 && (
                  <span className="cc-deps-none">No hay tareas pendientes.</span>
                )}
                {allTasks
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

// ---- tareas ---------------------------------------------------------------------------

function Group({
  label,
  count,
  status,
  startOpen,
  children,
}: {
  label: string;
  count: number;
  status: string;
  startOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(startOpen);
  return (
    <section className="td-group" data-s={status}>
      <button className="td-group-h" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="td-chev" data-open={open ? "1" : "0"}>
          <Icon name="chev" size={12} />
        </span>
        {label}
        <span className="td-group-n">{count}</span>
      </button>
      {open && <div className="td-list">{children}</div>}
    </section>
  );
}

function TaskRow({
  t,
  all,
  files,
  active,
  hasProject,
  dispatch,
  onComment,
  onOpenTask,
  onOpenPath,
  onTaskOp,
}: {
  t: TeamTask;
  all: TeamTask[];
  files: number;
  active: boolean;
  hasProject: boolean;
  dispatch: { enabled: boolean; state: DispatchState; onRetry: (id: number) => void };
  onComment: (id: number, text: string) => Promise<void>;
  onOpenTask: (id: number) => void;
  onOpenPath: (path: string) => void;
  onTaskOp: (id: number, op: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [delAsk, setDelAsk] = useState(false);
  useEffect(() => {
    if (!delAsk) return;
    const id = window.setTimeout(() => setDelAsk(false), 4000);
    return () => window.clearTimeout(id);
  }, [delAsk]);

  const waiting = t.status !== "done" ? waitingFor(t, all) : [];
  const pending = dispatch.enabled && t.status === "open" ? dispatch.state.pending[t.id] : undefined;
  const cfg = dispatchConfig(useSettings());
  const parked = t.status === "open" && isParked(dispatch.state, t.id, cfg);
  const comments = t.comments ?? [];
  const isDone = t.status === "done";
  const inReview = t.status === "review";
  // En revisión, cerrarla desde aquí es aprobarla (como haría el líder).
  const closeOp = isDone ? "reopen" : inReview ? "approve" : "done";
  const nFiles = Math.max(files, t.result?.files.length ?? 0);

  return (
    <div className="td-task" data-s={t.status} data-open={open ? "1" : "0"} data-active={active ? "1" : "0"}>
      <button
        className="td-check"
        data-s={t.status}
        onClick={() => onTaskOp(t.id, closeOp)}
        title={isDone ? "Reabrir" : inReview ? "Aprobar la entrega" : "Marcar hecha"}
        aria-label={
          isDone ? `Reabrir la tarea #${t.id}` : inReview ? `Aprobar la tarea #${t.id}` : `Marcar hecha la tarea #${t.id}`
        }
      >
        {isDone && <Icon name="check" size={11} />}
      </button>
      <button className="td-main" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="td-title">{cleanTitle(t.title)}</span>
        <span className="td-meta">
          <span className="td-id">#{t.id}</span>
          {t.owner ? (
            <span className="td-who">
              <Av agent={t.owner} />
              {agentLabel(t.owner)}
            </span>
          ) : t.assign ? (
            <span className="td-free">para {agentLabel(t.assign)}</span>
          ) : (
            <span className="td-free">sin dueño</span>
          )}
          {t.status === "draft" && (
            <span className="td-review" title="En modo director, el líder escribe el encargo antes de repartirla">
              esperando encargo del líder
            </span>
          )}
          {inReview && (
            <span className="td-review" title="El líder revisa la entrega antes de cerrarla">
              en revisión{t.fix_rounds ? ` · ronda ${t.fix_rounds}` : ""}
            </span>
          )}
          {!inReview && !isDone && (t.fix_rounds ?? 0) > 0 && (
            <span className="td-review">corrigiendo · ronda {t.fix_rounds}</span>
          )}
          {t.level && <span className="td-level" data-l={t.level}>{LEVEL_LABEL[t.level] ?? t.level}</span>}
          {waiting.length > 0 && (
            <span className="td-wait" title="No se puede tomar hasta que terminen sus tareas padre">
              <Icon name="lock" size={11} />
              espera {waiting.map((id) => `#${id}`).join(", ")}
            </span>
          )}
          {pending && <span className="td-disp">pedida a {agentLabel(pending.agent)}</span>}
          {parked && <span className="td-parked">nadie la tomó</span>}
          {nFiles > 0 && <span>{nFiles === 1 ? "1 archivo" : `${nFiles} archivos`}</span>}
          {comments.length > 0 && (
            <span className="td-notes">
              <Icon name="msg" size={11} />
              {comments.length}
            </span>
          )}
          <span className="td-when">{since(isDone && t.result ? t.result.ts_ms : t.created_ms)}</span>
        </span>
      </button>

      {open && (
        <div className="td-more">
          {(t.parents ?? []).length > 0 && waiting.length === 0 && (
            <div className="td-line">Dependía de {(t.parents ?? []).map((id) => `#${id}`).join(", ")}</div>
          )}
          {parked && (
            <div className="td-line warn">
              Nadie la tomó tras {dispatch.state.taskFails[t.id]} avisos.
              <button className="td-link" onClick={() => dispatch.onRetry(t.id)}>
                Reintentar
              </button>
            </div>
          )}
          {t.result && (
            <div className="td-result">
              <div className="td-label">
                <Av agent={t.result.by} />
                Entrega de {agentLabel(t.result.by)}
              </div>
              <p>{t.result.summary}</p>
              {t.result.files.length > 0 && (
                <div className="td-files">
                  {t.result.files.map((f) => (
                    <button className="cc-file-chip" key={f} title={f} onClick={() => onOpenPath(f)}>
                      {shortPath(f)}
                    </button>
                  ))}
                </div>
              )}
              {t.result.evidence && <p className="td-evidence">Comprobado: {t.result.evidence}</p>}
            </div>
          )}
          {t.handover && (
            <div className="td-result">
              <div className="td-label">
                <Icon name="book" size={12} />
                Relevo de {agentLabel(t.handover.by)} · {since(t.handover.ts_ms)}
              </div>
              <p>{t.handover.text}</p>
            </div>
          )}
          <div className="td-board">
            {comments.map((c, i) => (
              <div className="td-note" key={i}>
                {c.by === "tú" ? <span className="td-av td-you">T</span> : <Av agent={c.by} />}
                <span>{c.text}</span>
                <time>{since(c.ts_ms)}</time>
              </div>
            ))}
            <input
              className="td-noteinput"
              type="text"
              placeholder="Nota para quien la lleve…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                const text = note.trim();
                if (text) void onComment(t.id, text).then(() => setNote(""));
              }}
            />
          </div>
          <div className="td-actions">
            <button
              className="td-btn"
              onClick={() => onOpenTask(t.id)}
              title={hasProject ? `Ver los cambios de la tarea #${t.id}` : "Elige la carpeta del proyecto para ver cambios"}
            >
              <Icon name="diff" size={13} />
              Ver cambios
            </button>
            <button className="td-btn" onClick={() => onTaskOp(t.id, closeOp)}>
              <Icon name={isDone ? "refresh" : "check"} size={13} />
              {isDone ? "Reabrir" : inReview ? "Aprobar" : "Marcar hecha"}
            </button>
            <button
              className="td-btn danger"
              data-ask={delAsk ? "1" : "0"}
              onClick={() => {
                if (delAsk) {
                  setDelAsk(false);
                  onTaskOp(t.id, "delete");
                } else setDelAsk(true);
              }}
            >
              <Icon name="trash" size={13} />
              {delAsk ? "¿Seguro? Pulsa otra vez" : "Borrar"}
            </button>
          </div>
        </div>
      )}
      {active && <span className="td-viewing">viendo sus cambios</span>}
    </div>
  );
}

// ---- actividad --------------------------------------------------------------------------

/** Lo que el chat ya cuenta como conversación: aquí solo va el trabajo. */
const TALK = new Set(["message", "broadcast", "reply", "prompt", "stop", "session"]);

type Line = {
  key: string;
  icon: IconName;
  verb: string;
  detail: string;
  path?: string;
  task?: number;
  tone?: string;
  /** Veces seguidas que repitió lo mismo («Editó app.ts ×4»). */
  n?: number;
};

const TASK_VERB: Record<string, [string, IconName]> = {
  creada: ["Creó", "plus"],
  tomada: ["Tomó", "pulse"],
  liberada: ["Soltó", "refresh"],
  hecha: ["Terminó", "check"],
  entregada: ["Entregó", "check"],
  aprobada: ["Aprobó", "check"],
  borrada: ["Borró", "trash"],
};

function lineOf(e: TeamEvent, tasks: TeamTask[]): Line | null {
  const key = String(e.seq);
  if (TALK.has(e.kind)) return null;
  if (e.kind === "tool" || e.kind === "claim" || e.kind === "release") {
    const s = stepOf(e);
    return { key, ...s };
  }
  if (e.kind === "task") {
    const t = parseTask(e);
    if (!t) return { key, icon: "list", verb: "Tarea", detail: e.text };
    const [verb, icon] = TASK_VERB[t.op] ?? ["Tarea", "list"];
    const title = tasks.find((x) => x.id === t.id)?.title;
    return {
      key,
      icon,
      verb: `${verb} #${t.id}`,
      detail: title ? cleanTitle(title) : t.detail,
      task: t.id,
      tone: t.op === "hecha" || t.op === "aprobada" ? "ok" : undefined,
    };
  }
  if (e.kind === "waiting") {
    if (isNotice(e)) return null;
    return { key, icon: "warn", verb: "Pidió", detail: askPhrase(e.text), tone: "warn" };
  }
  if (e.kind === "update") return { key, icon: "pulse", verb: "Avance", detail: e.text };
  if (e.kind === "handover") return { key, icon: "book", verb: "Dejó un relevo", detail: e.text };
  if (e.kind === "memory") return { key, icon: "book", verb: "Memoria", detail: e.text };
  if (e.kind === "join") return { key, icon: "users", verb: "Se conectó", detail: "", tone: "faint" };
  if (e.kind === "leave") return { key, icon: "users", verb: "Se desconectó", detail: "", tone: "faint" };
  return { key, icon: "pulse", verb: e.kind, detail: e.text };
}

const PAGE = 120;

function Activity({
  events,
  tasks,
  agentNames,
  onOpenPath,
  onOpenTask,
  onSelectAgent,
}: {
  events: TeamEvent[];
  tasks: TeamTask[];
  agentNames: string[];
  onOpenPath: (path: string) => void;
  onOpenTask: (id: number) => void;
  onSelectAgent: (name: string) => void;
}) {
  const [who, setWho] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);

  const items = useMemo(() => {
    const out: { e: TeamEvent; line: Line }[] = [];
    for (const e of events) {
      const line = lineOf(e, tasks);
      if (line) out.push({ e, line });
    }
    return out;
  }, [events, tasks]);

  const people = useMemo(() => {
    const seen: string[] = [];
    for (const { e } of items) if (e.agent && !seen.includes(e.agent)) seen.push(e.agent);
    return seen;
  }, [items]);

  // Seguidas del mismo agente (con menos de 10 min entre una y otra) van en un bloque.
  const blocks = useMemo(() => {
    const shown = items.filter(({ e }) => !who || e.agent === who).slice(0, limit);
    const out: { agent: string; from: number; to: number; lines: Line[] }[] = [];
    for (const { e, line } of shown) {
      const last = out[out.length - 1];
      if (last && last.agent === e.agent && last.from - e.ts_ms < 10 * 60_000) {
        const prev = last.lines[last.lines.length - 1];
        if (prev.verb === line.verb && prev.detail === line.detail && prev.path === line.path) {
          prev.n = (prev.n ?? 1) + 1;
        } else {
          last.lines.push({ ...line });
        }
        last.from = e.ts_ms;
      } else {
        out.push({ agent: e.agent, from: e.ts_ms, to: e.ts_ms, lines: [{ ...line }] });
      }
    }
    return out;
  }, [items, who, limit]);
  const total = items.filter(({ e }) => !who || e.agent === who).length;

  if (items.length === 0) {
    return (
      <div className="td-empty">
        <Icon name="pulse" size={20} />
        <b>Sin actividad en este chat</b>
        <span>Aquí aparece el trabajo de los agentes: archivos que tocan, comandos, tareas y avisos.</span>
      </div>
    );
  }

  return (
    <>
      {people.length > 1 && (
        <div className="td-who-filter">
          <button aria-pressed={who == null} onClick={() => setWho(null)}>
            Todos
          </button>
          {people.map((p) => (
            <button key={p} aria-pressed={who === p} onClick={() => setWho(who === p ? null : p)}>
              {p === "tú" ? <span className="td-av td-you">T</span> : <Av agent={p} />}
              {p === "tú" ? "Tú" : agentLabel(p)}
            </button>
          ))}
        </div>
      )}
      <div className="td-act">
        {blocks.map((b) => (
          <section className="td-act-block" key={b.lines[0].key} style={{ "--ac": agentColor(b.agent) } as CSSProperties}>
            <header>
              {b.agent === "tú" ? <span className="td-av td-you">T</span> : <Av agent={b.agent} />}
              <button
                className="td-act-who"
                onClick={() => agentNames.includes(b.agent) && onSelectAgent(b.agent)}
                title={agentNames.includes(b.agent) ? `Abrir la conversación con ${agentLabel(b.agent)}` : undefined}
              >
                {b.agent === "tú" ? "Tú" : agentLabel(b.agent)}
              </button>
              <time title={new Date(b.to).toLocaleString("es")}>{since(b.to)}</time>
            </header>
            <ul>
              {b.lines.map((l) => (
                <li key={l.key} data-tone={l.tone}>
                  <span className="td-act-ic">
                    <Icon name={l.icon} size={12} />
                  </span>
                  <span className="td-act-txt">
                    <b>{l.verb}</b>{" "}
                    {l.path ? (
                      <button className="td-link" title={l.path} onClick={() => onOpenPath(l.path as string)}>
                        {shortPath(l.path)}
                      </button>
                    ) : l.task != null ? (
                      <button className="td-link plain" onClick={() => onOpenTask(l.task as number)}>
                        {l.detail}
                      </button>
                    ) : (
                      <span className="td-act-d" data-cmd={l.icon === "term" ? "1" : undefined} title={l.detail}>
                        {l.detail}
                      </span>
                    )}
                    {l.n && l.n > 1 ? <span className="td-act-x">×{l.n}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {total > limit && (
        <button className="td-more-btn" onClick={() => setLimit((n) => n + PAGE)}>
          Ver más ({total - limit})
        </button>
      )}
    </>
  );
}
