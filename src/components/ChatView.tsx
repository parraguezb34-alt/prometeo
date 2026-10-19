import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { displayName, kindOf, splitAttachments } from "../lib/attach";
import { stampLabel } from "../lib/chats";
import { agentColor, agentInitial, agentLabel, shortPath } from "../lib/team";
import type { QAnswer, TeamEvent, TeamQuestion } from "../lib/team";
import type { Skill } from "../lib/skills";
import { QuestionCard, SkillCard } from "./AskCards";

const NO_QUESTIONS: TeamQuestion[] = [];
const NO_SKILLS: Skill[] = [];
const noop = async () => {};
import { askPhrase, buildTimeline, clock, eventImages, isDispatch, samePath, span } from "../lib/timeline";
import type { Part, Row, TaskInfo, Turn } from "../lib/timeline";
import { parseNotice, splitOrders } from "../lib/notices";
import type { Notice } from "../lib/notices";
import { doingOf, statusEs, stepOf, workSummary } from "../lib/steps";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { Markdown } from "./Markdown";

/** Lo que hace ahora un agente que está trabajando (leído de su terminal o de sus acciones). */
export type LiveAgent = {
  name: string;
  busy: boolean;
  since: number;
  /** Frase de estado de su CLI («Pondering…», «Reading file...»). */
  status: string;
  /** Última acción que avisó al equipo (Bash …, Edit …). */
  lastAction?: string;
  hasTerminal: boolean;
};

export type ChatTask = { id: number; title: string; status: string };

type Props = {
  events: TeamEvent[];
  /** Cambia al cambiar de conversación: vuelve a pegarse al final y no anima lo que ya había. */
  resetKey: string;
  empty: ReactNode;
  live: LiveAgent[];
  /** Agentes en línea de esta conversación (para el acuse de un mensaje al equipo). */
  team: string[];
  /** Agentes con terminal abierta en lienzo. */
  terminals: string[];
  leader: string;
  tasks: ChatTask[];
  project: string | null;
  onOpenPath: (path: string) => void;
  onOpenTask: (id: number) => void;
  onTerminal: (agent: string) => void;
  onInterrupt: (agent: string) => void;
  /** Preguntas de los agentes (team_ask_user) y cómo contestarlas. */
  questions?: TeamQuestion[];
  onAnswer?: (id: number, answers: QAnswer[] | null) => Promise<void>;
  /** Biblioteca de skills (para las propuestas de los agentes) y cómo instalar una. */
  skills?: Skill[];
  onSkill?: (source: string, agent: string) => Promise<void>;
  /** Para la página de pruebas: de dónde salen las imágenes (por defecto, del disco vía Tauri). */
  loadImage?: (path: string, project: string | null) => Promise<string>;
};

// ---- imágenes ------------------------------------------------------------------

const imageCache = new Map<string, Promise<string>>();

function diskImage(path: string, project: string | null): Promise<string> {
  const key = `${project ?? ""}|${path}`;
  let p = imageCache.get(key);
  if (!p) {
    p = invoke<string>("image_data", { path, project });
    // Un fallo (aún no existe, se está escribiendo) no se queda en caché para siempre.
    p.catch(() => window.setTimeout(() => imageCache.delete(key), 15_000));
    imageCache.set(key, p);
  }
  return p;
}

type Loader = (path: string, project: string | null) => Promise<string>;

function useImage(path: string, project: string | null, load: Loader) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let alive = true;
    setSrc(null);
    setErr(false);
    load(path, project)
      .then((s) => alive && setSrc(s))
      .catch(() => alive && setErr(true));
    return () => {
      alive = false;
    };
  }, [path, project, load]);
  return { src, err };
}

function Tile({
  path,
  project,
  load,
  more,
  onOpen,
}: {
  path: string;
  project: string | null;
  load: Loader;
  more: number;
  onOpen: () => void;
}) {
  const { src, err } = useImage(path, project, load);
  if (err) {
    return (
      <span className="cv-tile-missing" title={path}>
        <Icon name="eye" size={13} />
        {shortPath(path)}
      </span>
    );
  }
  return (
    <button className="cv-tile" onClick={onOpen} title={path} disabled={!src} data-ready={src ? "1" : "0"}>
      {src && <img src={src} alt={shortPath(path)} />}
      {more > 0 && <span className="cv-tile-more">+{more}</span>}
    </button>
  );
}

/** Capturas de un turno: tres como mucho a la vista y el resto en el visor. */
function Gallery({
  paths,
  project,
  load,
  onOpen,
}: {
  paths: string[];
  project: string | null;
  load: Loader;
  onOpen: (paths: string[], index: number) => void;
}) {
  if (paths.length === 0) return null;
  const shown = paths.slice(0, 3);
  return (
    <div className="cv-gallery" data-n={shown.length}>
      {shown.map((p, i) => (
        <Tile
          key={p}
          path={p}
          project={project}
          load={load}
          more={i === shown.length - 1 ? paths.length - shown.length : 0}
          onOpen={() => onOpen(paths, i)}
        />
      ))}
    </div>
  );
}

function Lightbox({
  paths,
  index,
  project,
  load,
  onIndex,
  onClose,
}: {
  paths: string[];
  index: number;
  project: string | null;
  load: Loader;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const path = paths[index];
  const { src } = useImage(path, project, load);
  const many = paths.length > 1;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" && many) onIndex((index + 1) % paths.length);
      else if (e.key === "ArrowLeft" && many) onIndex((index - 1 + paths.length) % paths.length);
      else return;
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [index, many, paths.length, onIndex, onClose]);
  return (
    <div className="cv-lightbox" onClick={onClose} role="dialog" aria-label="Imagen">
      <div className="cv-lightbox-stage" onClick={(e) => e.stopPropagation()}>
        {src ? <img key={path} src={src} alt={path} /> : <span className="cv-lightbox-wait" />}
      </div>
      <div className="cv-lightbox-bar" onClick={(e) => e.stopPropagation()}>
        {many && (
          <span className="cv-lightbox-n">
            {index + 1} / {paths.length}
          </span>
        )}
        <span className="cv-lightbox-path" title={path}>
          {path}
        </span>
        <button className="cv-btn" onClick={() => reveal(path, project)}>
          <Icon name="folder" size={13} />
          Mostrar en la carpeta
        </button>
      </div>
      {many && (
        <>
          <button
            className="cv-lightbox-nav"
            data-side="l"
            aria-label="Anterior"
            onClick={(e) => {
              e.stopPropagation();
              onIndex((index - 1 + paths.length) % paths.length);
            }}
          >
            <Icon name="chev" size={20} />
          </button>
          <button
            className="cv-lightbox-nav"
            data-side="r"
            aria-label="Siguiente"
            onClick={(e) => {
              e.stopPropagation();
              onIndex((index + 1) % paths.length);
            }}
          >
            <Icon name="chev" size={20} />
          </button>
        </>
      )}
      <button className="cv-lightbox-x" onClick={onClose} aria-label="Cerrar">
        <Icon name="x" size={18} />
      </button>
    </div>
  );
}

/** Abre el explorador en la imagen (las rutas relativas cuelgan del proyecto). */
function reveal(path: string, project: string | null) {
  const absolute = /^([A-Za-z]:)?[\\/]/.test(path);
  const abs = absolute || !project ? path : `${project.replace(/[\\/]+$/, "")}\\${path.replace(/\//g, "\\")}`;
  revealItemInDir(abs).catch(() => {});
}

// ---- piezas pequeñas -----------------------------------------------------------------

const PLAN_PREFIX = /^📋\s*\(modo plan\)\s*/;

function Avatar({ agent, live = false, size }: { agent: string; live?: boolean; size?: "sm" }) {
  return (
    <span
      className="cv-av"
      data-live={live ? "1" : "0"}
      data-size={size}
      style={{ "--ac": agentColor(agent) } as CSSProperties}
      title={agentLabel(agent)}
    >
      {agentInitial(agent)}
    </span>
  );
}

function Dots() {
  return (
    <span className="cv-dots" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

function stamp(ts: number) {
  return (
    <time title={new Date(ts).toLocaleString("es")} dateTime={new Date(ts).toISOString()}>
      {stampLabel(ts)}
    </time>
  );
}

// ---- la conversación -------------------------------------------------------------------

export function ChatView({
  events,
  resetKey,
  empty,
  live,
  team,
  terminals,
  leader,
  tasks,
  project,
  onOpenPath,
  onOpenTask,
  onTerminal,
  onInterrupt,
  questions = NO_QUESTIONS,
  onAnswer = noop,
  skills = NO_SKILLS,
  onSkill = noop,
  loadImage,
}: Props) {
  const load = loadImage ?? diskImage;
  const rows = useMemo(() => buildTimeline(events), [events]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [box, setBox] = useState<{ paths: string[]; index: number } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [unseen, setUnseen] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastCount = useRef(0);

  const busy = useMemo(() => new Map(live.filter((l) => l.busy).map((l) => [l.name, l])), [live]);
  const taskTitle = useMemo(() => new Map(tasks.map((t) => [t.id, t.title])), [tasks]);
  const hasTerm = (a: string) => terminals.includes(a);

  // Último evento de cada agente: una petición de permiso solo está pendiente si es lo último.
  const lastSeq = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of events) m.set(e.agent, Math.max(m.get(e.agent) ?? 0, e.seq));
    return m;
  }, [events]);

  // Reloj de segundo en segundo mientras haya algo en vivo (trabajo o un mensaje sin acuse).
  const lastUser = useMemo(() => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r.k === "user") return r;
    }
    return null;
  }, [rows]);
  const ticking = busy.size > 0 || (!!lastUser && Date.now() - lastUser.e.ts_ms < 10 * 60_000);
  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [ticking]);

  // Solo se anima lo que llega después de abrir la conversación, no todo el historial.
  const born = useRef<{ key: string; keys: Set<string>; at: number }>({ key: "", keys: new Set(), at: 0 });
  if (born.current.key !== resetKey) born.current = { key: resetKey, keys: new Set(), at: Date.now() };
  if (born.current.keys.size === 0 && rows.length > 0 && Date.now() - born.current.at < 2500) {
    for (const r of rows) {
      born.current.keys.add(r.key);
      if (r.k === "turn") for (const p of r.parts) born.current.keys.add(p.key);
    }
  }
  const isNew = (key: string) => (born.current.keys.has(key) ? undefined : "1");

  // ---- scroll: pegado al final como un chat --------------------------------------------
  const lastTop = useRef(0);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    // Solo te despegas del final si subes tú; si el contenido crece mientras bajamos solos, no.
    if (atBottom) stick.current = true;
    else if (el.scrollTop < lastTop.current - 4) stick.current = false;
    lastTop.current = el.scrollTop;
    if (stick.current) setUnseen(0);
  };
  const toBottom = (smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    stick.current = true;
    setUnseen(0);
  };
  useLayoutEffect(() => {
    stick.current = true;
    lastCount.current = events.length;
    toBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);
  useLayoutEffect(() => {
    const added = events.length - lastCount.current;
    lastCount.current = events.length;
    // Lo que acabas de enviar siempre te lleva al final, como en cualquier chat.
    const mineNew = added > 0 && events[events.length - 1]?.agent === "tú";
    if (stick.current || mineNew) toBottom(!mineNew);
    else if (added > 0) setUnseen((n) => n + added);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.length, busy.size]);
  // Las imágenes cargan después y hacen crecer el chat: si estabas al final, sigues al final.
  const hasRows = rows.length > 0;
  useEffect(() => {
    const el = scrollRef.current;
    const col = el?.firstElementChild;
    if (!el || !col || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(col);
    return () => ro.disconnect();
  }, [hasRows]);

  const toggle = (key: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const copy = (key: string, text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(key);
        window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1400);
      })
      .catch(() => {});
  };

  const openGallery = (paths: string[], index: number) => setBox({ paths, index });
  const gallery = (paths: string[]) => (
    <Gallery paths={paths} project={project} load={load} onOpen={openGallery} />
  );

  // Una ruta de imagen escrita en un mensaje se abre en el visor; el resto, en el preview.
  const openPath = (p: string) => {
    if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(p)) setBox({ paths: [p], index: 0 });
    else onOpenPath(p);
  };

  // ---- partes de un turno ------------------------------------------------------------

  /** Imágenes que aún no salieron en este turno (cada captura, una sola vez). */
  const unseenIn = (shown: string[], paths: string[]) => {
    const out = paths.filter((p) => !shown.some((x) => samePath(x, p)));
    shown.push(...out);
    return out;
  };

  const stepRow = (e: TeamEvent, style: CSSProperties) => {
    const s = stepOf(e);
    return (
      <li className="cv-step" key={e.seq} style={style}>
        <span className="cv-step-ic">
          <Icon name={s.icon} size={12} />
        </span>
        <span className="cv-step-verb">{s.verb}</span>
        {s.path ? (
          <button className="md-path" onClick={() => openPath(s.path as string)} title={s.path}>
            {shortPath(s.path)}
          </button>
        ) : (
          <code className="cv-step-cmd" title={s.detail}>
            {s.detail}
          </code>
        )}
        {stamp(e.ts_ms)}
      </li>
    );
  };

  /** Pasos que se ven sin desplegar mientras el agente trabaja: los últimos, entrando por abajo. */
  const LIVE_TAIL = 3;

  const renderWork = (part: Extract<Part, { k: "work" }>, running: boolean, shown: string[]) => {
    const evs = part.events;
    const isOpen = open.has(part.key);
    const dur = evs[evs.length - 1].ts_ms - evs[0].ts_ms;
    const summary = workSummary(evs);
    const imgs = unseenIn(shown, evs.flatMap(eventImages));
    const tail = running && !isOpen ? evs.slice(-LIVE_TAIL) : [];
    const hidden = evs.length - tail.length;
    return (
      <div
        className="cv-work"
        key={part.key}
        data-open={isOpen ? "1" : "0"}
        data-running={running ? "1" : "0"}
        data-new={isNew(part.key)}
      >
        <button className="cv-work-head" onClick={() => toggle(part.key)} aria-expanded={isOpen}>
          <span className="cv-work-ic" data-running={running ? "1" : "0"}>
            {running ? <span className="cv-spin" /> : <Icon name="check" size={12} />}
          </span>
          <span className="cv-work-t">
            {running
              ? `Trabajando${dur > 20_000 ? ` · ${span(dur)}` : ""}`
              : dur > 20_000
                ? `Trabajó ${span(dur)}`
                : "Trabajó"}
          </span>
          {summary && <span className="cv-work-sum">{summary}</span>}
          <span className="cv-work-chev">
            <Icon name="chev" size={13} />
          </span>
        </button>
        {isOpen && (
          <ol className="cv-steps">{evs.map((e, i) => stepRow(e, { "--i": Math.min(i, 14) } as CSSProperties))}</ol>
        )}
        {tail.length > 0 && (
          <ol className="cv-steps" data-live="1">
            {hidden > 0 && (
              <li className="cv-step-more" key="more">
                {hidden === 1 ? "1 paso antes" : `${hidden} pasos antes`}
              </li>
            )}
            {tail.map((e, i) => stepRow(e, { "--age": tail.length - 1 - i } as CSSProperties))}
          </ol>
        )}
        {gallery(imgs)}
      </div>
    );
  };

  const taskName = (t: TaskInfo) => taskTitle.get(t.id) ?? (t.op === "creada" ? t.detail : "");

  const renderTaskDone = (part: Extract<Part, { k: "task" }>) => {
    const t = part.task;
    const files = part.e.files;
    const longText = t.detail.length > 220;
    const expanded = open.has(part.key);
    const review = t.op === "entregada";
    return (
      <div className="cv-done" key={part.key} data-new={isNew(part.key)} data-state={review ? "review" : "done"}>
        <div className="cv-done-head">
          <span className="cv-done-ic">
            <Icon name={review ? "eye" : "check"} size={12} />
          </span>
          <b>
            #{t.id}
            {taskName(t) ? ` · ${taskName(t)}` : ""}
          </b>
          <span className="cv-done-tag">{t.op === "entregada" ? "En revisión" : "Hecha"}</span>
        </div>
        {t.detail && (
          <div className="cv-done-body" data-clamp={longText && !expanded ? "1" : "0"}>
            <Markdown text={t.detail} onPath={openPath} />
          </div>
        )}
        {(files.length > 0 || longText) && (
          <div className="cv-done-foot">
            {files.slice(0, 4).map((f) => (
              <button className="md-path" key={f} onClick={() => openPath(f)} title={f}>
                {shortPath(f)}
              </button>
            ))}
            {files.length > 4 && <span className="cv-more">+{files.length - 4}</span>}
            <span className="cv-grow" />
            {longText && (
              <button className="cv-link" onClick={() => toggle(part.key)}>
                {expanded ? "Ver menos" : "Ver más"}
              </button>
            )}
            <button className="cv-link" onClick={() => onOpenTask(t.id)}>
              <Icon name="diff" size={12} />
              Ver cambios
            </button>
          </div>
        )}
      </div>
    );
  };

  /** Varias tareas creadas seguidas (el líder repartiendo): una sola lista. */
  const renderPlan = (parts: Extract<Part, { k: "task" }>[]) => (
    <div className="cv-plan" key={parts[0].key} data-new={isNew(parts[0].key)}>
      <div className="cv-plan-head">
        <Icon name="list" size={13} />
        {parts.length === 1 ? "Creó una tarea" : `Repartió el trabajo en ${parts.length} tareas`}
      </div>
      <ol className="cv-plan-list">
        {parts.map((p) => (
          <li key={p.key}>
            <span className="cv-plan-id">#{p.task.id}</span>
            <span className="cv-plan-t">{taskName(p.task) || p.task.detail}</span>
          </li>
        ))}
      </ol>
    </div>
  );

  const renderPart = (part: Part, agent: string, running: boolean, shown: string[]): ReactNode => {
    if (part.k === "work") return renderWork(part, running, shown);
    if (part.k === "images") return <div key={part.key}>{gallery(unseenIn(shown, part.paths))}</div>;
    const e = part.e;
    if (part.k === "task") {
      const t = part.task;
      if (t.op === "hecha" || t.op === "entregada") return renderTaskDone(part);
      const verb = { tomada: "Tomó", liberada: "Liberó", borrada: "Borró", creada: "Creó", aprobada: "Aprobó" }[t.op];
      const name = taskName(t);
      return (
        <div className="cv-line" key={part.key} data-new={isNew(part.key)}>
          <Icon name={t.op === "tomada" ? "pulse" : t.op === "aprobada" ? "check" : "list"} size={13} />
          <span>
            {verb} <b>#{t.id}</b>
            {name ? ` · ${name}` : ""}
          </span>
        </div>
      );
    }
    if (part.k === "ask") {
      const pending = (lastSeq.get(agent) ?? 0) <= e.seq;
      if (!pending) {
        return (
          <div className="cv-line" key={part.key} data-tone="muted">
            <Icon name="check" size={13} />
            <span>Pidió {askPhrase(e.text)} · resuelto</span>
          </div>
        );
      }
      return (
        <div className="cv-ask" key={part.key} data-new={isNew(part.key)}>
          <span className="cv-ask-ic">
            <Icon name="warn" size={15} />
          </span>
          <div className="cv-ask-body">
            <b>Necesita tu respuesta</b>
            <span>Pide {askPhrase(e.text)}</span>
          </div>
          {hasTerm(agent) && (
            <button className="cv-btn" data-tone="warn" onClick={() => onTerminal(agent)}>
              <Icon name="term" size={13} />
              Responder
            </button>
          )}
        </div>
      );
    }
    if (part.k === "note" && e.kind === "question") {
      const id = Number(/^❓ q(\d+)/.exec(e.text)?.[1] ?? 0);
      const q = questions.find((x) => x.id === id);
      if (q) return <QuestionCard key={part.key} q={q} onAnswer={onAnswer} />;
    }
    if (part.k === "note" && e.kind === "skill" && e.files[0]) {
      return (
        <SkillCard
          key={part.key}
          seq={e.seq}
          agent={agent}
          source={e.files[0]}
          reason={e.text}
          skills={skills}
          onSkill={onSkill}
        />
      );
    }
    if (part.k === "note") {
      const icon: IconName =
        e.kind === "handover" || e.kind === "memory" ? "book" : e.kind === "update" ? "pulse" : "check";
      return (
        <div className="cv-line" key={part.key} data-kind={e.kind} data-new={isNew(part.key)}>
          <Icon name={icon} size={13} />
          <div className="cv-line-md">
            <Markdown text={e.text} onPath={openPath} />
          </div>
        </div>
      );
    }
    // Texto del agente (o, si es una corrección del líder, su tarjeta).
    const fix = e.agent !== "tú" ? parseNotice(e.text) : null;
    if (fix?.kind === "fix") return renderFix(part.key, e, fix);
    const to =
      e.kind === "broadcast" ? "a todo el equipo" : e.to && e.to !== "tú" ? `a ${agentLabel(e.to)}` : null;
    return (
      <div className="cv-text" key={part.key} data-new={isNew(part.key)}>
        {to && (
          <span className="cv-to">
            <Icon name="send" size={11} />
            {to}
          </span>
        )}
        <Markdown text={e.text} onPath={openPath} reveal={isNew(part.key) === "1"} />
        {gallery(unseenIn(shown, eventImages(e)))}
      </div>
    );
  };

  /** Las partes de un turno, juntando en una lista las tareas creadas seguidas. */
  const renderParts = (t: Turn, running: boolean): ReactNode[] => {
    const out: ReactNode[] = [];
    const runOf: Extract<Part, { k: "task" }>[] = [];
    const shown: string[] = [];
    const flush = () => {
      if (runOf.length) out.push(renderPlan([...runOf]));
      runOf.length = 0;
    };
    t.parts.forEach((p, i) => {
      if (p.k === "task" && p.task.op === "creada") {
        runOf.push(p);
        return;
      }
      flush();
      out.push(renderPart(p, t.agent, running && i === t.parts.length - 1, shown));
    });
    flush();
    return out;
  };

  /**
   * Al pie del turno de un agente que trabaja: qué está haciendo ahora mismo (su última acción
   * o la frase de su CLI), cuánto lleva y cómo pararlo.
   */
  const thinking = (l: LiveAgent) => {
    const act = l.lastAction ? doingOf(l.lastAction) : null;
    const phrase = statusEs(l.status);
    const label = act && !phrase ? `${act.verb} ${act.detail}`.trim() : phrase || "Pensando…";
    return (
      <div className="cv-think" key={`think-${l.name}`}>
        <span className="cv-think-orb" aria-hidden="true">
          {act && !phrase ? <Icon name={act.icon} size={12} /> : <Dots />}
        </span>
        {/* La clave hace que cada frase nueva entre con su animación. */}
        <span className="cv-shimmer" key={label} title={l.status || l.lastAction}>
          {label}
        </span>
        <span className="cv-think-clock">{clock(now - l.since)}</span>
        <span className="cv-grow" />
      {l.hasTerminal && (
        <>
          <button className="cv-ghost" onClick={() => onTerminal(l.name)} title="Ver su terminal">
            <Icon name="term" size={12} />
            Terminal
          </button>
          <button className="cv-ghost" onClick={() => onInterrupt(l.name)} title="Envía Esc a su terminal">
            <Icon name="x" size={12} />
            Detener
          </button>
        </>
      )}
      </div>
    );
  };

  const turnHead = (agent: string, ts: number | null, reply: boolean, liveNow: boolean, turn?: Turn) => {
    const text = turn
      ? turn.parts
          .filter((p): p is Extract<Part, { k: "text" }> => p.k === "text")
          .map((p) => p.e.text)
          .join("\n\n")
      : "";
    const done = !!turn && copied === turn.key;
    return (
      <div className="cv-turn-head">
        <b>{agentLabel(agent)}</b>
        {agent === leader && (
          <span className="cv-badge" title="Líder del equipo">
            <Icon name="crown" size={11} />
            Líder
          </span>
        )}
        {reply && <span className="cv-meta">en su terminal</span>}
        {ts != null && <span className="cv-meta">{stamp(ts)}</span>}
        {liveNow && <span className="cv-meta cv-meta-live">trabajando</span>}
        <span className="cv-head-btns">
          {text && turn && (
            <button
              className="cv-head-btn"
              data-done={done ? "1" : "0"}
              onClick={() => copy(turn.key, text)}
              title={done ? "Copiado" : "Copiar lo que dijo"}
            >
              <Icon name={done ? "check" : "list"} size={12} />
            </button>
          )}
          {hasTerm(agent) && (
            <button className="cv-head-btn" onClick={() => onTerminal(agent)} title="Ver su terminal">
              <Icon name="term" size={12} />
            </button>
          )}
        </span>
      </div>
    );
  };

  // Último turno de cada agente y si es lo último del chat: ahí va su «pensando…».
  const lastTurnOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) if (r.k === "turn") m.set(r.agent, r.key);
    return m;
  }, [rows]);
  const lastRow = rows[rows.length - 1];
  const tailAgent = lastRow?.k === "turn" ? lastRow.agent : null;

  // ---- acuse de tu último mensaje ----------------------------------------------------

  const receipt = (e: TeamEvent): ReactNode => {
    if (now - e.ts_ms > 30 * 60_000) return null;
    const after = (a: string) => events.some((x) => x.agent === a && x.seq > e.seq);
    const age = now - e.ts_ms;
    if (e.kind === "message" && e.to) {
      const a = e.to;
      if (after(a) || busy.has(a)) {
        return (
          <div className="cv-receipt" key="r-ok">
            <Icon name="check" size={12} />
            Recibido
          </div>
        );
      }
      if (age < 20_000) {
        return (
          <div className="cv-receipt" key="r-sent">
            <Dots />
            Enviado a {agentLabel(a)}
          </div>
        );
      }
      return (
        <div className="cv-receipt" data-tone="warn" key="r-late">
          <Icon name="warn" size={12} />
          {agentLabel(a)} no ha respondido · {span(age)}
          {hasTerm(a) && (
            <button className="cv-link" onClick={() => onTerminal(a)}>
              Abrir su terminal
            </button>
          )}
        </div>
      );
    }
    // Al equipo: quién ya reaccionó.
    if (team.length === 0) return null;
    const reacted = team.filter((a) => after(a) || busy.has(a));
    return (
      <div
        className="cv-receipt"
        key="r-team"
        data-tone={reacted.length === 0 && age > 30_000 ? "warn" : undefined}
      >
        <span className="cv-receipt-avs">
          {team.map((a) => (
            <span
              key={a}
              className="cv-receipt-av"
              data-on={reacted.includes(a) ? "1" : "0"}
              data-live={busy.has(a) ? "1" : "0"}
              style={{ "--ac": agentColor(a) } as CSSProperties}
              title={`${agentLabel(a)}: ${busy.has(a) ? "trabajando" : reacted.includes(a) ? "lo vio" : "aún no"}`}
            >
              {agentInitial(a)}
            </span>
          ))}
        </span>
        {reacted.length === 0
          ? age > 30_000
            ? `Nadie ha respondido aún · ${span(age)}`
            : "Enviado al equipo"
          : reacted.length === team.length
            ? "Todo el equipo lo recibió"
            : `${reacted.length} de ${team.length} lo recibieron`}
      </div>
    );
  };

  // ---- avisos del modo director --------------------------------------------------------

  /** Lienzo avisa a un agente: una línea con lo esencial; lo demás, al desplegar. */
  const renderNotice = (r: Extract<Row, { k: "notice" }>): ReactNode => {
    const { n, e } = r;
    const to = agentLabel(e.to || leader);
    const isOpen = open.has(r.key);
    let icon: IconName = "bell";
    let title: ReactNode = null;
    let sub = "";
    let body: ReactNode = null;
    if (n.kind === "review") {
      icon = "eye";
      title = (
        <>
          Pidió a <b>{to}</b> revisar <b>#{n.task}</b> · {n.title}
        </>
      );
      sub = `Entrega de ${agentLabel(n.by)}${n.round ? ` · tras ${n.round} ${n.round === 1 ? "ronda" : "rondas"} de corrección` : ""}`;
      // El resumen ya sale en la tarjeta de la entrega: aquí, lo que usa el líder para decidir.
      body = (
        <>
          {n.evidence && (
            <div className="cv-notice-ev">
              <span>Evidencia</span>
              <code>{n.evidence}</code>
            </div>
          )}
          <div className="cv-done-foot">
            {n.files.slice(0, 4).map((f) => (
              <button className="md-path" key={f} onClick={() => openPath(f)} title={f}>
                {shortPath(f)}
              </button>
            ))}
            <span className="cv-grow" />
            <button className="cv-link" onClick={() => onOpenTask(n.task)}>
              <Icon name="diff" size={12} />
              Ver cambios
            </button>
          </div>
        </>
      );
    } else if (n.kind === "remind") {
      title = (
        <>
          Recordó a <b>{to}</b> {n.count === 1 ? "una entrega" : `${n.count} entregas`} por revisar
        </>
      );
      sub = n.tasks;
    } else if (n.kind === "brief") {
      icon = "pencil";
      title = (
        <>
          Pidió a <b>{to}</b> el encargo de <b>#{n.task}</b> · {n.title}
        </>
      );
      sub = "Hasta que lo escriba, la tarea no se reparte";
    }
    return (
      <div className="cv-notice" key={r.key} data-kind={n.kind} data-open={isOpen ? "1" : "0"} data-new={isNew(r.key)}>
        <button
          className="cv-notice-head"
          onClick={() => body && toggle(r.key)}
          aria-expanded={body ? isOpen : undefined}
          data-static={body ? undefined : "1"}
          title={body ? (isOpen ? "Ocultar la entrega" : "Ver la entrega") : undefined}
        >
          <span className="cv-notice-ic">
            <Icon name={icon} size={13} />
          </span>
          <span className="cv-notice-t">
            <span>
              <span className="cv-notice-who">Lienzo</span> {title}
            </span>
            {sub && <small>{sub}</small>}
          </span>
          <span className="cv-meta">{stamp(e.ts_ms)}</span>
          {body && (
            <span className="cv-work-chev">
              <Icon name="chev" size={13} />
            </span>
          )}
        </button>
        {isOpen && body && <div className="cv-notice-body">{body}</div>}
      </div>
    );
  };

  /** El líder devuelve una entrega: sus órdenes como lista, sin las instrucciones para el agente. */
  const renderFix = (key: string, e: TeamEvent, n: Extract<Notice, { kind: "fix" }>) => (
    <div className="cv-fix" key={key} data-new={isNew(key)}>
      <div className="cv-fix-head">
        <span className="cv-fix-ic">
          <Icon name="refresh" size={12} />
        </span>
        <span className="cv-fix-t">
          Devolvió <b>#{n.task}</b> a <b>{agentLabel(e.to ?? "")}</b> para corregir
        </span>
        <span className="cv-fix-tag" data-last={n.last ? "1" : "0"}>
          {n.last ? "Última ronda" : `Ronda ${n.round} de ${n.limit}`}
        </span>
      </div>
      <div className="cv-fix-body">
        <Markdown text={splitOrders(n.notes)} onPath={openPath} />
      </div>
    </div>
  );

  // ---- filas ---------------------------------------------------------------------------

  const renderRow = (r: Row): ReactNode => {
    if (r.k === "day") {
      return (
        <div className="cv-day" key={r.key}>
          <span>{r.label}</span>
        </div>
      );
    }
    if (r.k === "user") {
      const e = r.e;
      const plan = PLAN_PREFIX.test(e.text);
      // Lo que adjuntaste: la línea con sus rutas se cambia por miniaturas y fichas.
      const { said: rest, paths } = splitAttachments(e.text);
      const shots = paths.filter((p) => kindOf(p) === "image");
      const others = paths.filter((p) => kindOf(p) !== "image");
      const said = rest.replace(PLAN_PREFIX, "").trim();
      const to = e.kind === "broadcast" || !e.to ? "Al equipo" : `A ${agentLabel(e.to)}`;
      return (
        <div className="cv-user" key={r.key} data-new={isNew(r.key)}>
          <div className="cv-user-meta">
            {plan && <span className="cv-tag">Plan</span>}
            {to}
            <span className="cv-meta">{stamp(e.ts_ms)}</span>
          </div>
          {said && <div className="cv-bubble">{said}</div>}
          {shots.length > 0 && gallery(shots)}
          {others.length > 0 && (
            <div className="cv-atts">
              {others.map((p) => (
                <button className="cv-att" key={p} data-kind={kindOf(p)} onClick={() => (kindOf(p) === "dir" ? void revealItemInDir(p.replace(/[\\/]+$/, "")).catch(() => {}) : onOpenPath(p))}
                  title={p}
                >
                  <Icon name={kindOf(p) === "dir" ? "folder" : "file"} size={14} />
                  <span>{displayName(p)}</span>
                </button>
              ))}
            </div>
          )}
          {r === lastUser && receipt(e)}
        </div>
      );
    }
    if (r.k === "notice") return renderNotice(r);
    if (r.k === "sys") {
      const e = r.e;
      const imgs = e.kind === "image" ? e.files : [];
      const text =
        e.kind === "image"
          ? imgs.length === 1
            ? "Imagen nueva en el proyecto"
            : `${imgs.length} imágenes nuevas en el proyecto`
          : isDispatch(e)
            ? `Lienzo asignó a ${agentLabel(e.to ?? "")} ${e.text.replace(/^📌 Despacho:?\s*/, "")}`
            : e.agent === "tú"
              ? `Tú: ${e.text}`
              : e.text;
      return (
        <div className="cv-sys" key={r.key} data-new={isNew(r.key)}>
          <div className="cv-sys-line">
            <Icon name={e.kind === "image" ? "eye" : "list"} size={12} />
            <span>{text}</span>
            <span className="cv-meta">{stamp(e.ts_ms)}</span>
          </div>
          {gallery(imgs)}
        </div>
      );
    }
    // Turno de un agente.
    const l = busy.get(r.agent);
    const isLatest = lastTurnOf.get(r.agent) === r.key;
    const showThink = !!l && isLatest && tailAgent === r.agent;
    const reply = r.parts.some((p) => p.k === "text" && p.e.kind === "reply");
    return (
      <div
        className="cv-turn"
        key={r.key}
        data-new={isNew(r.key)}
        style={{ "--ac": agentColor(r.agent) } as CSSProperties}
      >
        <Avatar agent={r.agent} live={showThink} />
        <div className="cv-turn-main">
          {turnHead(r.agent, r.ts, reply, false, r)}
          {renderParts(r, showThink)}
          {showThink && l && thinking(l)}
        </div>
      </div>
    );
  };

  // Agentes trabajando cuyo último turno no es lo último del chat: un turno provisional al final.
  const pending = [...busy.values()].filter((l) => tailAgent !== l.name).sort((a, b) => a.since - b.since);

  return (
    <div className="cv-wrap">
      <div className="cv" ref={scrollRef} onScroll={onScroll}>
        {rows.length === 0 && pending.length === 0 ? (
          empty
        ) : (
          <div className="cv-col">
            {rows.map(renderRow)}
            {pending.map((l) => (
              <div
                className="cv-turn"
                key={`live-${l.name}`}
                data-new="1"
                data-provisional="1"
                style={{ "--ac": agentColor(l.name) } as CSSProperties}
              >
                <Avatar agent={l.name} live />
                <div className="cv-turn-main">
                  {turnHead(l.name, null, false, true)}
                  {thinking(l)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {unseen > 0 && (
        <button className="cv-jump" onClick={() => toBottom(true)}>
          <Icon name="chev" size={14} />
          {unseen === 1 ? "1 novedad" : `${unseen} novedades`}
        </button>
      )}
      {box && (
        <Lightbox
          paths={box.paths}
          index={box.index}
          project={project}
          load={load}
          onIndex={(i) => setBox((b) => (b ? { ...b, index: i } : b))}
          onClose={() => setBox(null)}
        />
      )}
    </div>
  );
}
