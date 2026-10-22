import { useEffect, useMemo, useState } from "react";
import { agentLabel, errMsg, teamModels } from "../lib/team";
import type { ModelEntry, TeamSchedule, TeamTask } from "../lib/team";
import { chatAt, dayKey, nextRun, parseEvery, scheduleOrder } from "../lib/schedule";
import type { ChatWindow } from "../lib/schedule";
import { projectKey } from "../lib/project";
import { Markdown } from "./Markdown";
import { Icon } from "./Icon";
import "../schedule.css";

/** Lo que se escribe al crear o editar (lo mismo que `schedule::Draft` del hub). */
export type ScheduleDraft = {
  title: string;
  notes: string;
  every: string;
  assign: string;
  level: string;
  model: string;
  daily_cap: number;
  chat: string;
  chat_title: string;
};

type Op = "approve" | "pause" | "resume" | "delete" | "run";

const PRESETS = ["cada día 9:00", "lun-vie 8:30", "cada 2 h", "cada 30 min", "lun 9:00"];
const LEVELS = [
  { v: "simple", l: "Simple" },
  { v: "media", l: "Media" },
  { v: "dificil", l: "Difícil" },
];
const STATUS: Record<string, string> = { pending: "Espera tu OK", active: "Activa", paused: "En pausa" };
const TASK_STATUS: Record<string, string> = {
  open: "por hacer",
  claimed: "en curso",
  review: "en revisión",
  done: "hecha",
  draft: "sin encargo",
  plan: "espera tu OK",
};

/** «hoy 9:00», «mañana 8:30», «lun 26, 8:30». */
function when(ms: number): string {
  const d = new Date(ms);
  const hm = d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return `hoy ${hm}`;
  if (d.toDateString() === tomorrow.toDateString()) return `mañana ${hm}`;
  return `${d.toLocaleDateString("es", { weekday: "short", day: "numeric", month: "short" })}, ${hm}`;
}

function nextOf(s: TeamSchedule): number {
  const spec = parseEvery(s.every);
  const base = s.last_ms || s.approved_ms;
  return s.status === "active" && spec && base ? nextRun(spec, base) : 0;
}

/**
 * Programadas: todas las tareas que se repiten, de todos los chats, en un solo sitio. Se crean
 * aquí (ya activas) o se las pides al líder en un chat (llegan pendientes de tu OK). Cada una
 * dice de qué chat viene y guarda sus ejecuciones.
 */
export function ScheduleTab({
  schedules,
  tasks,
  chats,
  activeChat,
  project,
  agents,
  onSave,
  onOp,
  onOpenChat,
  onOpenTask,
  onAsk,
}: {
  schedules: TeamSchedule[];
  tasks: TeamTask[];
  /** Chats del equipo de este proyecto. */
  chats: ChatWindow[];
  /** El chat abierto ahora (al que se liga lo nuevo por defecto). */
  activeChat: ChatWindow | null;
  project: string | null;
  agents: string[];
  onSave: (id: number | null, draft: ScheduleDraft) => Promise<TeamSchedule | null>;
  onOp: (id: number, op: Op) => void;
  onOpenChat: (id: string) => void;
  onOpenTask: (id: number) => void;
  onAsk: (text: string) => void;
}) {
  const key = project ? projectKey(project) : "";
  const ordered = useMemo(() => scheduleOrder(schedules, Date.now(), key), [schedules, key]);
  const [sel, setSel] = useState<number | "new" | null>(null);
  const [editing, setEditing] = useState(false);
  const selected = typeof sel === "number" ? schedules.find((s) => s.id === sel) ?? null : null;
  // Sin nada elegido: la primera que espera tu OK, o la primera de la lista.
  useEffect(() => {
    if (sel === null && ordered.length > 0) setSel(ordered[0].id);
    if (typeof sel === "number" && !schedules.some((s) => s.id === sel)) setSel(ordered[0]?.id ?? null);
  }, [sel, ordered, schedules]);

  const groups = useMemo(() => {
    const mine = (s: TeamSchedule) => !s.project || projectKey(s.project) === key;
    return [
      { key: "pending", label: "Esperan tu OK", items: ordered.filter((s) => mine(s) && s.status === "pending") },
      { key: "active", label: "Activas", items: ordered.filter((s) => mine(s) && s.status === "active") },
      { key: "paused", label: "En pausa", items: ordered.filter((s) => mine(s) && s.status === "paused") },
      { key: "other", label: "Otros proyectos (solo corren con ese proyecto abierto)", items: ordered.filter((s) => !mine(s)) },
    ].filter((g) => g.items.length > 0);
  }, [ordered, key]);

  const chatName = (s: TeamSchedule) => {
    if (s.chat) return chats.find((c) => c.id === s.chat)?.title ?? s.chat_title ?? "chat borrado";
    return "";
  };

  return (
    <div className="rs sc">
      <aside className="rs-side">
        <div className="rs-new sc-new">
          <button
            className="cc-btn"
            onClick={() => {
              setSel("new");
              setEditing(true);
            }}
          >
            <Icon name="plus" size={14} />
            Nueva programada
          </button>
          <small className="rs-hint">
            También puedes pedírsela al líder en cualquier chat: «programa que opencode revise X cada día a las 9».
          </small>
        </div>
        <div className="rs-list">
          {groups.length === 0 && <div className="rs-none">Aún no hay tareas programadas.</div>}
          {groups.map((g) => (
            <div className="sc-group" key={g.key} data-g={g.key}>
              <div className="sc-group-h">
                {g.label}
                <span>{g.items.length}</span>
              </div>
              {g.items.map((s) => {
                const next = nextOf(s);
                return (
                  <button
                    key={s.id}
                    className="rs-item"
                    data-active={sel === s.id ? "1" : "0"}
                    onClick={() => {
                      setSel(s.id);
                      setEditing(false);
                    }}
                  >
                    <span className="rs-item-q">{s.title}</span>
                    <span className="rs-item-m">
                      <span className="rs-chip" data-st={s.status}>
                        P{s.id}
                      </span>
                      <span>{s.every}</span>
                      {next > 0 && <time>{when(next)}</time>}
                    </span>
                    <span className="rs-item-m">
                      <span>{s.assign ? agentLabel(s.assign) : "quien esté libre"}</span>
                      {chatName(s) && <span className="sc-chat">💬 {chatName(s)}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </aside>

      <section className="rs-main">
        {sel === "new" || (editing && selected) ? (
          <ScheduleForm
            key={sel === "new" ? "new" : selected?.id}
            initial={sel === "new" ? null : selected}
            chats={chats}
            activeChat={activeChat}
            agents={agents}
            onCancel={() => {
              setEditing(false);
              if (sel === "new") setSel(ordered[0]?.id ?? null);
            }}
            onSave={async (d) => {
              const saved = await onSave(sel === "new" ? null : selected?.id ?? null, d);
              if (saved) {
                setSel(saved.id);
                setEditing(false);
              }
            }}
          />
        ) : selected ? (
          <ScheduleDetail
            s={selected}
            runs={tasks.filter((t) => t.schedule === selected.id).sort((a, b) => b.id - a.id)}
            chats={chats}
            chatName={chatName(selected)}
            mine={!selected.project || projectKey(selected.project) === key}
            onOp={(op) => onOp(selected.id, op)}
            onEdit={() => setEditing(true)}
            onOpenChat={onOpenChat}
            onOpenTask={onOpenTask}
          />
        ) : (
          <div className="rs-intro">
            <Icon name="refresh" size={22} />
            <h3>Tareas que se repiten solas</h3>
            <ol>
              <li>
                <b>Escribes el encargo una vez</b> con su frecuencia («cada día 9:00», «lun-vie 8:30», «cada 2 h»).
              </li>
              <li>
                <b>A su hora, Prometeo crea una tarea normal</b> y la reparte, mejor a un agente económico como opencode.
              </li>
              <li>
                <b>Nada gasta a escondidas:</b> tope diario, se salta si el agente pasa del 80 % de su límite y no se
                amontonan (si la anterior no acabó, espera).
              </li>
            </ol>
            <div className="sc-row">
              <button
                className="cc-btn"
                onClick={() => {
                  setSel("new");
                  setEditing(true);
                }}
              >
                <Icon name="plus" size={14} />
                Nueva programada
              </button>
              <button
                className="cc-btn sec"
                onClick={() => onAsk("Programa una tarea que se repita: ")}
                title="Escribe la petición en el chat para el líder"
              >
                Pedírsela al líder
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function ScheduleDetail({
  s,
  runs,
  chats,
  chatName,
  mine,
  onOp,
  onEdit,
  onOpenChat,
  onOpenTask,
}: {
  s: TeamSchedule;
  runs: TeamTask[];
  chats: ChatWindow[];
  chatName: string;
  mine: boolean;
  onOp: (op: Op) => void;
  onEdit: () => void;
  onOpenChat: (id: string) => void;
  onOpenTask: (id: number) => void;
}) {
  const [sure, setSure] = useState(false);
  const next = nextOf(s);
  const today = s.day === dayKey(Date.now()) ? s.runs_day : 0;
  const chatAlive = !!s.chat && chats.some((c) => c.id === s.chat);
  return (
    <div className="sc-detail">
      <div className="rs-head">
        <div className="rs-head-q">
          <h3>{s.title}</h3>
          <small>
            P{s.id} · {s.every}
          </small>
        </div>
        <span className="sc-pill" data-st={s.status}>
          {STATUS[s.status] ?? s.status}
        </span>
      </div>

      <div className="sc-row sc-actions">
        {s.status === "pending" && (
          <button className="cc-btn" onClick={() => onOp("approve")}>
            <Icon name="check" size={14} />
            Aprobar
          </button>
        )}
        {s.status === "active" && (
          <button className="cc-btn sec" onClick={() => onOp("pause")}>
            Pausar
          </button>
        )}
        {s.status === "paused" && (
          <button className="cc-btn sec" onClick={() => onOp("resume")}>
            Reanudar
          </button>
        )}
        <button className="cc-btn sec" disabled={!mine} onClick={() => onOp("run")} title="Crea la tarea ahora (cuenta para el tope de hoy)">
          <Icon name="play" size={13} />
          Ejecutar ahora
        </button>
        <button className="cc-btn sec" onClick={onEdit}>
          <Icon name="pencil" size={13} />
          Editar
        </button>
        <button className="cc-btn sec" onClick={() => (sure ? onOp("delete") : setSure(true))} onBlur={() => setSure(false)}>
          <Icon name="trash" size={13} />
          {sure ? "¿Seguro?" : "Borrar"}
        </button>
      </div>

      <dl className="sc-facts">
        <dt>Próxima</dt>
        <dd>{next ? when(next) : s.status === "pending" ? "cuando la apruebes" : s.status === "paused" ? "en pausa" : "—"}</dd>
        <dt>Quién</dt>
        <dd>
          {s.assign ? agentLabel(s.assign) : "quien esté libre"}
          {s.level ? ` · ${s.level}` : ""}
          {s.model ? ` · modelo ${s.model}` : ""}
        </dd>
        <dt>Hoy</dt>
        <dd>
          {today} de {s.daily_cap} · {s.runs_total} en total
        </dd>
        <dt>Chat</dt>
        <dd>
          {chatName ? (
            chatAlive ? (
              <button className="rs-link" onClick={() => onOpenChat(s.chat)}>
                💬 {chatName}
              </button>
            ) : (
              chatName
            )
          ) : (
            "ninguno"
          )}
        </dd>
        <dt>La creó</dt>
        <dd>
          {agentLabel(s.by)} · {when(s.created_ms)}
        </dd>
        {!mine && (
          <>
            <dt>Proyecto</dt>
            <dd>{s.project} (solo corre con ese proyecto abierto)</dd>
          </>
        )}
        {s.skipped && (
          <>
            <dt>Última vez</dt>
            <dd className="sc-warn">saltada: {s.skipped}</dd>
          </>
        )}
      </dl>

      <div className="sc-block">
        <h4>Encargo de cada ejecución</h4>
        <div className="sc-notes">
          <Markdown text={s.notes} onPath={() => {}} />
        </div>
      </div>

      <div className="sc-block">
        <h4>Ejecuciones</h4>
        {runs.length === 0 ? (
          <p className="rs-muted">Aún no se ha ejecutado.</p>
        ) : (
          <ul className="sc-runs">
            {runs.slice(0, 30).map((t) => {
              const chat = chatAt(chats, t.created_ms);
              return (
                <li key={t.id}>
                  <button className="rs-link" onClick={() => onOpenTask(t.id)}>
                    #{t.id}
                  </button>
                  <span className="sc-run-st" data-st={t.status}>
                    {TASK_STATUS[t.status] ?? t.status}
                  </span>
                  <span>{when(t.created_ms)}</span>
                  {t.owner && <span>{agentLabel(t.owner)}</span>}
                  {chat && (
                    <button className="rs-link sc-chat" onClick={() => onOpenChat(chat.id)}>
                      💬 {chat.title}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function ScheduleForm({
  initial,
  chats,
  activeChat,
  agents,
  onCancel,
  onSave,
}: {
  initial: TeamSchedule | null;
  chats: ChatWindow[];
  activeChat: ChatWindow | null;
  agents: string[];
  onCancel: () => void;
  onSave: (d: ScheduleDraft) => Promise<void>;
}) {
  const [d, setD] = useState<ScheduleDraft>(() => ({
    title: initial?.title ?? "",
    notes: initial?.notes ?? "",
    every: initial?.every ?? "cada día 9:00",
    assign: initial?.assign ?? "",
    level: initial?.level || "simple",
    model: initial?.model ?? "",
    daily_cap: initial?.daily_cap ?? 6,
    chat: initial ? initial.chat : activeChat?.id ?? "",
    chat_title: initial ? initial.chat_title : activeChat?.title ?? "",
  }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (p: Partial<ScheduleDraft>) => setD((cur) => ({ ...cur, ...p }));
  const spec = parseEvery(d.every);
  const preview = spec ? when(nextRun(spec, Date.now())) : "";
  const isClaude = d.assign.toLowerCase().includes("claude");
  // Antigravity y OpenCode eligen modelo al arrancar: Prometeo los reinicia con él (retomando su
  // conversación) antes de pasarles la tarea.
  const restartAgent = /antigravity|agy/i.test(d.assign) ? "antigravity" : /opencode/i.test(d.assign) ? "opencode" : "";
  const isAgy = restartAgent !== "";
  const [agyModels, setAgyModels] = useState<{ agent: string; models: ModelEntry[] } | null>(null);
  useEffect(() => {
    if (!restartAgent || agyModels?.agent === restartAgent) return;
    teamModels(restartAgent)
      .then((c) => setAgyModels({ agent: restartAgent, models: c.models }))
      .catch(() => setAgyModels({ agent: restartAgent, models: [] }));
  }, [restartAgent, agyModels]);
  const teamChats = chats.filter((c) => c.kind === "team").slice().sort((a, b) => b.startMs - a.startMs);
  const ready = d.title.trim() && d.notes.trim() && spec;

  return (
    <form
      className="sc-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || busy) return;
        setBusy(true);
        setErr("");
        onSave({ ...d, model: isClaude || isAgy ? d.model : "" })
          .catch((e2) => setErr(errMsg(e2)))
          .finally(() => setBusy(false));
      }}
    >
      <h3>{initial ? `Editar P${initial.id}` : "Nueva tarea programada"}</h3>

      <label className="sc-field">
        <span>Título</span>
        <input value={d.title} onChange={(e) => set({ title: e.target.value })} placeholder="Revisar enlaces rotos de la documentación" autoFocus />
      </label>

      <label className="sc-field">
        <span>Encargo de cada ejecución</span>
        <textarea
          value={d.notes}
          onChange={(e) => set({ notes: e.target.value })}
          rows={7}
          placeholder={"Qué hacer, con rutas absolutas. Ej.: Recorre C:\\…\\docs\\*.md, comprueba cada enlace y anota los rotos en C:\\…\\docs\\enlaces-rotos.md. Hecho cuando: el archivo lista cada enlace roto con su archivo y línea."}
        />
        <small>Lo hará otro agente sin preguntarte: rutas exactas, qué es «hecho» y cómo comprobarlo.</small>
      </label>

      <div className="sc-field">
        <span>Frecuencia</span>
        <input value={d.every} onChange={(e) => set({ every: e.target.value })} aria-invalid={!spec} />
        <div className="sc-presets">
          {PRESETS.map((p) => (
            <button type="button" key={p} data-on={d.every === p ? "1" : "0"} onClick={() => set({ every: p })}>
              {p}
            </button>
          ))}
        </div>
        <small className={spec ? "" : "sc-warn"}>
          {spec ? `Próxima: ${preview}` : "No la entiendo: «cada día 9:00», «lun-vie 8:30», «lun,mie,vie 18:00», «cada 2 h» (mínimo 15 min)."}
        </small>
      </div>

      <div className="sc-grid">
        <label className="sc-field">
          <span>Quién la hace</span>
          <select className="cc-mini-select" value={d.assign} onChange={(e) => set({ assign: e.target.value })}>
            <option value="">Quien esté libre</option>
            {agents.map((a) => (
              <option key={a} value={a}>
                {agentLabel(a)}
              </option>
            ))}
          </select>
        </label>
        <div className="sc-field">
          <span>Nivel</span>
          <div className="rs-seg sc-seg3" role="radiogroup" aria-label="Nivel">
            {LEVELS.map((l) => (
              <button key={l.v} type="button" role="radio" aria-checked={d.level === l.v} data-on={d.level === l.v ? "1" : "0"} onClick={() => set({ level: l.v })}>
                {l.l}
              </button>
            ))}
          </div>
        </div>
        <label className="sc-field">
          <span>Máximo al día</span>
          <input type="number" min={1} max={48} value={d.daily_cap} onChange={(e) => set({ daily_cap: Math.max(1, Math.min(48, Number(e.target.value) || 1)) })} />
        </label>
        {isClaude && (
          <label className="sc-field">
            <span>Modelo (Claude)</span>
            <select className="cc-mini-select" value={d.model} onChange={(e) => set({ model: e.target.value })}>
              <option value="">El suyo</option>
              <option value="haiku">Haiku (el más económico)</option>
              <option value="sonnet">Sonnet</option>
              <option value="opus">Opus</option>
            </select>
          </label>
        )}
        {isAgy && (
          <label className="sc-field">
            <span>Modelo ({agentLabel(restartAgent)})</span>
            {agyModels && agyModels.agent === restartAgent && agyModels.models.length > 0 ? (
              <select className="cc-mini-select" value={d.model} onChange={(e) => set({ model: e.target.value })}>
                <option value="">El suyo</option>
                {agyModels.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label || m.id}
                  </option>
                ))}
              </select>
            ) : (
              <input value={d.model} onChange={(e) => set({ model: e.target.value.trim() })} placeholder="El suyo" />
            )}
            <small>
              Si no es el que tiene, se reinicia con este antes de la tarea y retoma su conversación; después sigue con él
              {restartAgent === "opencode" ? " (queda guardado en el opencode.json del proyecto)" : ""}.
            </small>
          </label>
        )}
      </div>

      <label className="sc-field">
        <span>Chat al que va ligada</span>
        <select
          className="cc-mini-select"
          value={d.chat}
          onChange={(e) => {
            const c = teamChats.find((x) => x.id === e.target.value);
            set({ chat: e.target.value, chat_title: c?.title ?? "" });
          }}
        >
          <option value="">Ninguno</option>
          {teamChats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
              {c.id === activeChat?.id ? " (el abierto)" : ""}
            </option>
          ))}
        </select>
        <small>Sus ejecuciones salen en el chat que esté abierto a esa hora; aquí queda de dónde viene.</small>
      </label>

      {err && <p className="sc-warn">{err}</p>}
      <div className="sc-row">
        <button className="cc-btn" type="submit" disabled={!ready || busy}>
          <Icon name="check" size={14} />
          {initial ? "Guardar cambios" : "Crear y activar"}
        </button>
        <button className="cc-btn sec" type="button" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </form>
  );
}
