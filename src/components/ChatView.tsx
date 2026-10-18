import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { stampLabel } from "../lib/chats";
import { agentColor, agentInitial, agentLabel, shortPath } from "../lib/team";
import type { TeamEvent } from "../lib/team";
import { buildTimeline, clock, eventImages, isDispatch, span } from "../lib/timeline";
import type { Part, Row } from "../lib/timeline";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { Markdown } from "./Markdown";

/** Lo que hace ahora un agente, para la fila en vivo del final del chat. */
export type LiveAgent = {
  name: string;
  /** Su terminal muestra que está trabajando. */
  busy: boolean;
  since: number;
  /** Línea de estado de su CLI («Pondering… (12s)»). */
  status: string;
  /** Última acción que avisó al equipo (Bash …, Edit …). */
  lastAction?: string;
  /** Le escribiste y aún no contesta: desde cuándo. */
  waitingSince?: number;
  hasTerminal: boolean;
};

type Props = {
  events: TeamEvent[];
  /** Cambia al cambiar de conversación: vuelve a pegarse al final. */
  resetKey: string;
  empty: ReactNode;
  live: LiveAgent[];
  project: string | null;
  onOpenPath: (path: string) => void;
  onTerminal: (agent: string) => void;
  onInterrupt: (agent: string) => void;
};

// ---- imágenes ------------------------------------------------------------------

const imageCache = new Map<string, Promise<string>>();

function loadImage(path: string, project: string | null): Promise<string> {
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

function Thumb({ path, project, onOpen }: { path: string; project: string | null; onOpen: (src: string, path: string) => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let alive = true;
    loadImage(path, project)
      .then((s) => alive && setSrc(s))
      .catch(() => alive && setErr(true));
    return () => {
      alive = false;
    };
  }, [path, project]);
  if (err) {
    return (
      <span className="cv-thumb-missing" title={path}>
        <Icon name="eye" size={13} />
        {shortPath(path)} · no disponible
      </span>
    );
  }
  return (
    <button className="cv-thumb" onClick={() => src && onOpen(src, path)} title={path} disabled={!src}>
      {src ? <img src={src} alt={shortPath(path)} /> : <span className="cv-thumb-skel" />}
      <span className="cv-thumb-cap">{shortPath(path)}</span>
    </button>
  );
}

// ---- acciones de trabajo ---------------------------------------------------------

type Step = { icon: IconName; verb: string; detail: string; path?: string };

function stepOf(e: TeamEvent): Step {
  if (e.kind === "claim") return { icon: "lock", verb: "Reservó", detail: e.files.map(shortPath).join(", ") || e.text };
  if (e.kind === "release") return { icon: "lock", verb: "Liberó", detail: e.files.map(shortPath).join(", ") || e.text };
  const m = /^(\S+)\s*([\s\S]*)$/.exec(e.text);
  const tool = m?.[1] ?? "";
  const rest = m?.[2] ?? "";
  const path = e.files[0];
  if (tool === "Bash") return { icon: "term", verb: "Ejecutó", detail: rest };
  if (tool === "Write") return { icon: "plus", verb: "Creó", detail: rest, path };
  if (/^(Edit|MultiEdit|NotebookEdit)$/.test(tool)) return { icon: "pencil", verb: "Editó", detail: rest, path };
  if (tool === "Read" || /screenshot/i.test(tool)) return { icon: "eye", verb: "Miró", detail: rest, path };
  return { icon: "pulse", verb: tool || "Acción", detail: rest, path };
}

/** «editó 3 archivos · 4 comandos · miró 1 imagen» */
function workSummary(events: TeamEvent[]): string {
  const edited = new Set<string>();
  let cmds = 0;
  let looks = 0;
  let claims = 0;
  for (const e of events) {
    const s = stepOf(e);
    if (s.icon === "pencil" || s.icon === "plus") edited.add(s.path ?? s.detail);
    else if (s.icon === "term") cmds++;
    else if (s.icon === "eye") looks++;
    else if (s.icon === "lock") claims++;
  }
  const bits: string[] = [];
  if (edited.size) bits.push(`editó ${edited.size} ${edited.size === 1 ? "archivo" : "archivos"}`);
  if (cmds) bits.push(`${cmds} ${cmds === 1 ? "comando" : "comandos"}`);
  if (looks) bits.push(`miró ${looks} ${looks === 1 ? "imagen" : "imágenes"}`);
  if (claims) bits.push(`${claims} ${claims === 1 ? "reserva" : "reservas"}`);
  return bits.join(" · ");
}

// ---- avisos ------------------------------------------------------------------------

function noteIcon(kind: string): IconName {
  if (kind === "task") return "list";
  if (kind === "update") return "pulse";
  if (kind === "handover" || kind === "memory") return "book";
  return "check";
}

function destLabel(e: TeamEvent): string | null {
  if (e.kind === "reply") return "respondió en su terminal";
  if (e.kind === "broadcast") return "para todo el equipo";
  if (!e.to) return null;
  if (e.to === "tú") return "para ti";
  return `para ${agentLabel(e.to)}`;
}

/** Abre el explorador en la imagen (las rutas relativas cuelgan del proyecto). */
function reveal(path: string, project: string | null) {
  const absolute = /^([A-Za-z]:)?[\\/]/.test(path);
  const abs = absolute || !project ? path : `${project.replace(/[\\/]+$/, "")}\\${path.replace(/\//g, "\\")}`;
  revealItemInDir(abs).catch(() => {});
}

const PLAN_PREFIX = /^📋\s*\(modo plan\)\s*/;

export function ChatView({ events, resetKey, empty, live, project, onOpenPath, onTerminal, onInterrupt }: Props) {
  const rows = useMemo(() => buildTimeline(events), [events]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [lightbox, setLightbox] = useState<{ src: string; path: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [unseen, setUnseen] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastCount = useRef(0);

  const anyLive = live.length > 0;
  useEffect(() => {
    if (!anyLive) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [anyLive]);

  // Último turno de cada agente: si sigue trabajando, su bloque de trabajo va «en vivo».
  const liveTurn = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) if (r.k === "turn") m.set(r.agent, r.key);
    return m;
  }, [rows]);
  const busy = useMemo(() => new Set(live.filter((l) => l.busy).map((l) => l.name)), [live]);

  // Pegado al final como un chat; si estás leyendo más arriba, se cuentan los nuevos.
  const lastTop = useRef(0);
  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    // Solo te despegas del final si subes tú; si el contenido crece mientras bajamos solos, no.
    if (atBottom) stick.current = true;
    else if (el.scrollTop < lastTop.current - 4) stick.current = false;
    lastTop.current = el.scrollTop;
    if (stick.current) setUnseen(0);
  };
  const toBottom = (smooth = false) => {
    const el = boxRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    stick.current = true;
    setUnseen(0);
  };
  useLayoutEffect(() => {
    stick.current = true;
    lastCount.current = events.length;
    toBottom();
  }, [resetKey]);
  useLayoutEffect(() => {
    const added = events.length - lastCount.current;
    lastCount.current = events.length;
    // Lo que acabas de enviar siempre te lleva al final, como en cualquier chat.
    const mineNew = added > 0 && events[events.length - 1]?.agent === "tú";
    if (stick.current || mineNew) toBottom();
    else if (added > 0) setUnseen((n) => n + added);
  }, [events.length, live.length]);

  // Las imágenes cargan después y hacen crecer el chat: si estabas al final, sigues al final.
  useEffect(() => {
    const el = boxRef.current;
    const col = el?.firstElementChild;
    if (!el || !col || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(col);
    return () => ro.disconnect();
  }, [rows.length > 0]);

  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setLightbox(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [lightbox]);

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
        window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
      })
      .catch(() => {});
  };

  const thumbs = (paths: string[], key: string) =>
    paths.length > 0 ? (
      <div className="cv-thumbs" key={`${key}-img`}>
        {paths.slice(0, 6).map((p) => (
          <Thumb key={p} path={p} project={project} onOpen={(src, path) => setLightbox({ src, path })} />
        ))}
      </div>
    ) : null;

  const renderWork = (part: Extract<Part, { k: "work" }>, isLive: boolean) => {
    const evs = part.events;
    const isOpen = open.has(part.key);
    const dur = evs[evs.length - 1].ts_ms - evs[0].ts_ms;
    const summary = workSummary(evs);
    const imgs = evs.flatMap(eventImages);
    return (
      <div className="cv-work" key={part.key} data-open={isOpen ? "1" : "0"} data-live={isLive ? "1" : "0"}>
        <button className="cv-work-head" onClick={() => toggle(part.key)} aria-expanded={isOpen}>
          {isLive ? <span className="cv-spin" /> : <Icon name="check" size={13} />}
          <span className="cv-work-t">
            {isLive ? "Trabajando" : dur > 20_000 ? `Trabajó ${span(dur)}` : "Trabajó"}
          </span>
          {summary && <span className="cv-work-sum">{summary}</span>}
          <Icon name="chev" size={13} />
        </button>
        {isOpen && (
          <ol className="cv-steps">
            {evs.map((e) => {
              const s = stepOf(e);
              return (
                <li className="cv-step" key={e.seq}>
                  <span className="cv-step-ic">
                    <Icon name={s.icon} size={12} />
                  </span>
                  <span className="cv-step-verb">{s.verb}</span>
                  {s.path ? (
                    <button className="md-path" onClick={() => onOpenPath(s.path as string)} title={s.path}>
                      {shortPath(s.path)}
                    </button>
                  ) : (
                    <code className="cv-step-cmd" title={s.detail}>
                      {s.detail}
                    </code>
                  )}
                  <time title={new Date(e.ts_ms).toLocaleString("es")}>{stampLabel(e.ts_ms)}</time>
                </li>
              );
            })}
          </ol>
        )}
        {thumbs(imgs, part.key)}
      </div>
    );
  };

  const renderPart = (part: Part, agent: string, isLiveTurn: boolean, isLast: boolean): ReactNode => {
    if (part.k === "work") return renderWork(part, isLiveTurn && isLast && busy.has(agent));
    if (part.k === "images") return thumbs(part.paths, part.key);
    const e = part.e;
    if (part.k === "note") {
      const text = e.text.replace(/ claimed por /, " tomada por ").replace(/ open por /, " liberada por ");
      // Los archivos que ya salen en el texto no se repiten al lado.
      const files = e.files.filter((f) => !text.includes(f.replace(/\\/g, "/").split("/").pop() ?? f));
      return (
        <div className="cv-note" key={part.key} data-kind={e.kind}>
          <Icon name={noteIcon(e.kind)} size={13} />
          <span className="cv-note-t">
            <Markdown text={text} onPath={onOpenPath} />
          </span>
          {files.length > 0 && (
            <span className="cv-note-files">
              {files.slice(0, 3).map((f) => (
                <button className="md-path" key={f} onClick={() => onOpenPath(f)} title={f}>
                  {shortPath(f)}
                </button>
              ))}
              {files.length > 3 && <span className="cv-more">+{files.length - 3}</span>}
            </span>
          )}
        </div>
      );
    }
    const dest = destLabel(e);
    return (
      <div className="cv-text" key={part.key}>
        {dest && <div className="cv-dest">{dest}</div>}
        <Markdown text={e.text} onPath={onOpenPath} />
        {thumbs(eventImages(e), part.key)}
        <div className="cv-acts">
          <button onClick={() => copy(part.key, e.text)} title="Copiar el mensaje">
            {copied === part.key ? <Icon name="check" size={13} /> : <Icon name="list" size={13} />}
            {copied === part.key ? "Copiado" : "Copiar"}
          </button>
        </div>
      </div>
    );
  };

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
      const to = e.kind === "broadcast" ? "Para el equipo" : e.to ? `Para ${agentLabel(e.to)}` : "Para el equipo";
      return (
        <div className="cv-user cv-in" key={r.key}>
          <div className="cv-user-meta">
            {plan && <span className="cv-tag">Plan</span>}
            {to}
            <time title={new Date(e.ts_ms).toLocaleString("es")}>{stampLabel(e.ts_ms)}</time>
          </div>
          <div className="cv-bubble">{e.text.replace(PLAN_PREFIX, "")}</div>
        </div>
      );
    }
    if (r.k === "alert") {
      const e = r.e;
      return (
        <div className="cv-alert cv-in" key={r.key} style={{ "--ac": agentColor(e.agent) } as CSSProperties}>
          <Icon name="warn" size={16} />
          <div className="cv-alert-body">
            <b>{agentLabel(e.agent)} necesita tu respuesta</b>
            <span>{e.text}</span>
          </div>
          <button className="cv-btn" onClick={() => onTerminal(e.agent)}>
            <Icon name="term" size={13} />
            Responder en su terminal
          </button>
        </div>
      );
    }
    if (r.k === "sys") {
      const e = r.e;
      const imgs = e.kind === "image" ? e.files : [];
      return (
        <div className="cv-sys cv-in" key={r.key}>
          <div className="cv-sys-line">
            <Icon name={e.kind === "image" ? "eye" : isDispatch(e) ? "list" : noteIcon(e.kind)} size={13} />
            <span>
              {e.kind === "image"
                ? imgs.length === 1
                  ? "Imagen nueva en el proyecto"
                  : `${imgs.length} imágenes nuevas en el proyecto`
                : isDispatch(e)
                  ? `Asignada a ${agentLabel(e.to ?? "")}: ${e.text.replace(/^📌 Despacho:?\s*/, "")}`
                  : e.agent === "tú"
                    ? `Tú: ${e.text}`
                    : e.text}
            </span>
            <time>{stampLabel(e.ts_ms)}</time>
          </div>
          {thumbs(imgs, r.key)}
        </div>
      );
    }
    // Turno de un agente.
    const isLiveTurn = liveTurn.get(r.agent) === r.key;
    return (
      <div className="cv-turn cv-in" key={r.key} style={{ "--ac": agentColor(r.agent) } as CSSProperties}>
        <div className="cv-av">{agentInitial(r.agent)}</div>
        <div className="cv-turn-main">
          <div className="cv-turn-head">
            <b>{agentLabel(r.agent)}</b>
            <time title={new Date(r.ts).toLocaleString("es")}>{stampLabel(r.ts)}</time>
            <button className="cv-head-btn" onClick={() => onTerminal(r.agent)} title="Ver su terminal">
              <Icon name="term" size={12} />
              Terminal
            </button>
          </div>
          {r.parts.map((p, i) => renderPart(p, r.agent, isLiveTurn, i === r.parts.length - 1))}
        </div>
      </div>
    );
  };

  const liveRows = live.map((l) => (
    <div
      className="cv-live"
      key={`live-${l.name}`}
      data-busy={l.busy ? "1" : "0"}
      style={{ "--ac": agentColor(l.name) } as CSSProperties}
    >
      <div className="cv-av cv-av-live">{agentInitial(l.name)}</div>
      <div className="cv-live-main">
        <div className="cv-live-top">
          <b>{agentLabel(l.name)}</b>
          {l.busy ? (
            <>
              <span className="cv-shimmer">está trabajando</span>
              <span className="cv-live-clock">{clock(now - l.since)}</span>
            </>
          ) : (
            <span className="cv-live-wait">
              aún no responde · {span(now - (l.waitingSince ?? now))}
            </span>
          )}
        </div>
        {(l.status || l.lastAction) && (
          <div className="cv-live-status" title={l.status || l.lastAction}>
            {l.status || l.lastAction}
          </div>
        )}
        {!l.busy && (
          <div className="cv-live-hint">
            {l.hasTerminal
              ? "Su terminal está parada: ábrela para ver si espera algo."
              : "No tiene terminal abierta en lienzo; lo verá cuando use sus herramientas del equipo."}
          </div>
        )}
      </div>
      <div className="cv-live-btns">
        {l.hasTerminal && (
          <button className="cv-btn" onClick={() => onTerminal(l.name)}>
            <Icon name="term" size={13} />
            Terminal
          </button>
        )}
        {l.busy && l.hasTerminal && (
          <button className="cv-btn" onClick={() => onInterrupt(l.name)} title="Envía Esc a su terminal">
            <Icon name="x" size={13} />
            Detener
          </button>
        )}
      </div>
    </div>
  ));

  return (
    <div className="cv-wrap">
      <div className="cv" ref={boxRef} onScroll={onScroll}>
        {rows.length === 0 && live.length === 0 ? (
          empty
        ) : (
          <div className="cv-col">
            {rows.map(renderRow)}
            {liveRows}
          </div>
        )}
      </div>
      {unseen > 0 && (
        <button className="cv-jump" onClick={() => toBottom(true)}>
          <Icon name="chev" size={14} />
          {unseen === 1 ? "1 novedad" : `${unseen} novedades`}
        </button>
      )}
      {lightbox && (
        <div className="cv-lightbox" onClick={() => setLightbox(null)} role="dialog" aria-label="Imagen">
          <img src={lightbox.src} alt={lightbox.path} onClick={(e) => e.stopPropagation()} />
          <div className="cv-lightbox-bar" onClick={(e) => e.stopPropagation()}>
            <span title={lightbox.path}>{lightbox.path}</span>
            <button className="cv-btn" onClick={() => reveal(lightbox.path, project)}>
              <Icon name="folder" size={13} />
              Mostrar en la carpeta
            </button>
          </div>
          <button className="cv-lightbox-x" onClick={() => setLightbox(null)} aria-label="Cerrar">
            <Icon name="x" size={18} />
          </button>
        </div>
      )}
    </div>
  );
}

