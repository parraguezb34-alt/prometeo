import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isRemote, openDialog } from "../lib/bridge";
import { ago, errMsg } from "../lib/team";
import type { TeamEvent } from "../lib/team";
import { friendlySize, projectRecent } from "../lib/project";
import type { RecentFile } from "../lib/project";
import {
  LIST_EXTS,
  blobUrl,
  fileBlob,
  fileOffice,
  fileOpenExternal,
  fileReveal,
  fileText,
  groupOf,
  kindLabel,
  parseCsv,
  prettyJson,
  shortTag,
  viewKind,
} from "../lib/viewer";
import type { Group, ViewKind } from "../lib/viewer";
import { Markdown } from "./Markdown";
import { Icon } from "./Icon";
import "../viewer.css";

const GROUPS: { v: Group; l: string }[] = [
  { v: "todo", l: "Todo" },
  { v: "docs", l: "Documentos" },
  { v: "web", l: "Web" },
  { v: "media", l: "Imágenes y vídeo" },
  { v: "datos", l: "Datos" },
];

/** Lo que se pinta de un archivo: texto, una URL `blob:` (PDF, imagen…) o una página (Office). */
type Loaded =
  | { kind: "text"; text: string; truncated: boolean; binary: boolean; size: number; mtime: number }
  | { kind: "blob"; url: string; size: number; mtime: number }
  | { kind: "page"; html: string };

/** La lista de archivos escondida (para leer a todo el ancho), recordado entre sesiones. */
const HIDE_KEY = "lienzo.viewer.hideList";

const TEXTY: ViewKind[] = ["html", "svg", "md", "csv", "json", "text"];
const BLOBBY: ViewKind[] = ["pdf", "image", "video", "audio"];

/** Ruta corta para la lista y la barra (las que vienen de fuera del proyecto, con su carpeta). */
function shortName(rel: string): string {
  const parts = rel.replace(/\\/g, "/").split("/");
  return parts.length > 3 && /^[A-Za-z]:/.test(rel) ? `…/${parts.slice(-2).join("/")}` : rel;
}

/**
 * Ver archivos dentro de Prometeo: páginas web, Markdown, tablas, PDF, imágenes, vídeo, audio y
 * documentos de Word, Excel y PowerPoint. Lo que no se puede ver aquí, se abre con su programa.
 * Se recarga solo cuando un agente guarda el archivo abierto.
 */
export function PreviewTab({
  project,
  events,
  openRel,
  onChooseProject,
}: {
  project: string | null;
  events: TeamEvent[];
  /** Archivo a abrir desde fuera (un enlace del chat o del historial). */
  openRel?: string | null;
  onChooseProject: () => void;
}) {
  const [files, setFiles] = useState<RecentFile[]>([]);
  const [group, setGroup] = useState<Group>("todo");
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [data, setData] = useState<Loaded | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const lastSeq = useRef(0);
  const urlRef = useRef<string | null>(null);
  const reqIdRef = useRef(0);
  // Ampliado: el archivo ocupa toda la ventana (por encima del chat). Se sale con Esc.
  const [full, setFull] = useState(false);
  const [hideList, setHideList] = useState(() => {
    try {
      return localStorage.getItem(HIDE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleList = () =>
    setHideList((v) => {
      try {
        localStorage.setItem(HIDE_KEY, v ? "0" : "1");
      } catch {
        /* sin almacenamiento: no se recuerda */
      }
      return !v;
    });
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFull(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);

  const loadList = useCallback(() => {
    if (!project) return;
    projectRecent(project, LIST_EXTS, 200)
      .then(setFiles)
      .catch(() => setFiles([]));
  }, [project]);

  // Las URL `blob:` ocupan memoria hasta que se sueltan.
  const setLoaded = (d: Loaded | null) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = d?.kind === "blob" ? d.url : null;
    setData(d);
  };
  useEffect(() => () => void (urlRef.current && URL.revokeObjectURL(urlRef.current)), []);

  const open = useCallback(
    (rel: string) => {
      const id = ++reqIdRef.current;
      setSel(rel);
      setErr(null);
      setLoading(true);
      const k = viewKind(rel);
      const job: Promise<Loaded | null> = TEXTY.includes(k)
        ? fileText(project, rel).then((t) => ({ kind: "text", text: t.text, truncated: t.truncated, binary: t.binary, size: t.size, mtime: t.mtime_ms }))
        : BLOBBY.includes(k)
          ? fileBlob(project, rel).then((b) => {
              if (reqIdRef.current !== id) return null;
              return { kind: "blob" as const, url: blobUrl(b), size: b.size, mtime: b.mtime_ms };
            })
          : k === "office"
            ? fileOffice(project, rel).then((html) => ({ kind: "page", html }))
            : Promise.reject(new Error(""));
      job
        .then((data) => {
          if (reqIdRef.current !== id || !data) {
            if (data?.kind === "blob") URL.revokeObjectURL(data.url);
            return;
          }
          setLoaded(data);
        })
        .catch((e) => {
          if (reqIdRef.current !== id) return;
          setLoaded(null);
          setErr(k === "other" ? "" : errMsg(e));
        })
        .finally(() => {
          if (reqIdRef.current === id) setLoading(false);
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project],
  );

  useEffect(() => {
    reqIdRef.current++;
    setSel(null);
    setLoaded(null);
    setErr(null);
    setLoading(false);
    loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadList]);

  useEffect(() => {
    if (openRel) open(openRel);
  }, [openRel, open]);

  // Si un evento nuevo del equipo toca el archivo abierto (o aparecen archivos), se recarga solo.
  useEffect(() => {
    const top = events[0]?.seq ?? 0;
    if (top <= lastSeq.current) return;
    const fresh = events.filter((e) => e.seq > lastSeq.current);
    lastSeq.current = top;
    if (fresh.some((e) => e.files.length > 0)) loadList();
    if (sel && fresh.some((e) => e.files.some((f) => f.replace(/\\/g, "/").endsWith(sel.replace(/\\/g, "/"))))) open(sel);
  }, [events, sel, open, loadList]);

  const pickFile = async () => {
    const path = await openDialog({ multiple: false, directory: false, defaultPath: project ?? undefined, title: "Abrir un archivo" }).catch(() => null);
    if (typeof path !== "string") return;
    // Dentro del proyecto se guarda relativo (así lo encuentran los avisos de los agentes).
    const root = (project ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    const norm = path.replace(/\\/g, "/");
    open(root && norm.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? norm.slice(root.length + 1) : path);
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return files.filter((f) => (group === "todo" || groupOf(f.rel) === group) && (!q || f.rel.toLowerCase().includes(q)));
  }, [files, group, query]);

  if (!project) {
    return (
      <div className="cc-empty">
        <div>Los archivos se buscan en la carpeta del proyecto.</div>
        <button className="agent-btn" onClick={onChooseProject}>
          📂 Elegir carpeta
        </button>
      </div>
    );
  }

  const k = sel ? viewKind(sel) : "other";
  const external = (what: "open" | "reveal") => {
    if (!sel) return;
    (what === "open" ? fileOpenExternal(project, sel) : fileReveal(project, sel)).catch((e) => setErr(errMsg(e)));
  };

  let body;
  if (!sel) {
    body = (
      <div className="cc-empty vw-empty">
        <Icon name="file" size={26} />
        <div>
          {isRemote() ? (
            "Elige un archivo de la izquierda. "
          ) : (
            <>
              Elige un archivo de la izquierda o ábrelo con <b>Abrir…</b>.{" "}
            </>
          )}
          Se ven páginas web, Markdown, tablas, PDF, imágenes, vídeo, audio y documentos de Word, Excel y PowerPoint.
        </div>
      </div>
    );
  } else if (loading && !data) {
    body = <div className="cc-empty">Abriendo…</div>;
  } else if (err !== null || !data) {
    body = (
      <div className="cc-empty vw-empty">
        <div>{err || `Los archivos ${kindLabel(sel)} no se pueden ver aquí.`}</div>
        {!isRemote() && (
          <button className="hs-btn hs-btn-go" onClick={() => external("open")}>
            <Icon name="external" size={13} />
            Abrir con su programa
          </button>
        )}
      </div>
    );
  } else if (data.kind === "blob") {
    body =
      k === "pdf" ? (
        <iframe className="cc-frame vw-pdf" src={data.url} title={sel} />
      ) : k === "image" ? (
        <div className="vw-media">
          <img src={data.url} alt={sel} />
        </div>
      ) : k === "video" ? (
        <div className="vw-media">
          <video src={data.url} controls />
        </div>
      ) : (
        <div className="vw-media">
          <audio src={data.url} controls />
        </div>
      );
  } else if (data.kind === "page") {
    // Sin scripts: es un documento para leer.
    body = <iframe className="cc-frame" sandbox="" srcDoc={data.html} title={sel} />;
  } else if (data.binary) {
    body = (
      <div className="cc-empty vw-empty">
        <div>Es un archivo binario; no hay vista previa.</div>
        {!isRemote() && (
          <button className="hs-btn hs-btn-go" onClick={() => external("open")}>
            <Icon name="external" size={13} />
            Abrir con su programa
          </button>
        )}
      </div>
    );
  } else if (k === "html" || k === "svg") {
    body = <iframe className="cc-frame" sandbox="allow-scripts" srcDoc={data.text} key={`${data.mtime}-${data.size}`} title={sel} />;
  } else if (k === "md") {
    body = (
      <div className="vw-doc">
        <Markdown text={data.text} />
      </div>
    );
  } else if (k === "csv") {
    const rows = parseCsv(data.text);
    const MAX_CSV_ROWS = 200;
    const trimmed = rows.length > MAX_CSV_ROWS;
    const displayRows = trimmed ? rows.slice(0, MAX_CSV_ROWS) : rows;
    body = (
      <div className="vw-table">
        {trimmed && (
          <div
            className="vw-trimmed"
            style={{
              padding: "6px 12px",
              background: "var(--dim)",
              color: "var(--muted)",
              fontSize: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <span>
              Mostrando {MAX_CSV_ROWS} de {rows.length} filas (archivo grande).
            </span>
            {!isRemote() && (
              <button className="hs-btn hs-btn-go" onClick={() => external("open")}>
                <Icon name="external" size={12} />
                Abrir completo con su programa
              </button>
            )}
          </div>
        )}
        <table>
          <tbody>
            {displayRows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (i === 0 ? <th key={j}>{c}</th> : <td key={j}>{c}</td>))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  } else {
    body = <pre className="cc-pre">{k === "json" ? prettyJson(data.text) : data.text}</pre>;
  }

  const meta = data && data.kind !== "page" ? data : null;

  // Ampliado se dibuja sobre la ventana (portal): ninguna capa de encima puede recortarlo.
  const main = (
    <div className="cc-art-main" data-full={full ? "1" : "0"}>
      {(sel || hideList) && (
        <div className="cc-art-bar">
          {!full && (
            <button
              className="ap-icon"
              data-on={hideList ? "1" : "0"}
              onClick={toggleList}
              title={hideList ? "Mostrar la lista de archivos" : "Ocultar la lista de archivos"}
              aria-label={hideList ? "Mostrar la lista de archivos" : "Ocultar la lista de archivos"}
            >
              <Icon name="panel" size={14} />
            </button>
          )}
          {!sel && <span className="cc-art-path">Ningún archivo abierto</span>}
          {sel && (
            <>
              <span className="vw-tag" data-g={groupOf(sel)}>
                {kindLabel(sel)}
              </span>
              <span className="cc-art-path" title={sel}>
                {shortName(sel)}
              </span>
              {meta && (
                <span className="cc-art-meta">
                  {friendlySize(meta.size)}
                  {meta.kind === "text" && meta.truncated ? " · recortado" : ""} · guardado hace {ago(meta.mtime)}
                </span>
              )}
              <button className="cc-mini-btn" onClick={() => open(sel)} disabled={loading} title="Recargar" aria-label="Recargar">
                {loading ? "…" : <Icon name="refresh" size={12} />}
              </button>
              {!isRemote() && (
                <>
                  <button className="ap-icon" onClick={() => external("reveal")} title="Mostrar en la carpeta" aria-label="Mostrar en la carpeta">
                    <Icon name="folder" size={14} />
                  </button>
                  <button className="ap-icon" onClick={() => external("open")} title="Abrir con su programa" aria-label="Abrir con su programa">
                    <Icon name="external" size={14} />
                  </button>
                </>
              )}
              <button
                className="ap-icon"
                data-on={full ? "1" : "0"}
                onClick={() => setFull((v) => !v)}
                title={full ? "Volver (Esc)" : "Ampliar a toda la ventana"}
                aria-label={full ? "Volver" : "Ampliar"}
              >
                <Icon name={full ? "shrink" : "expand"} size={14} />
              </button>
            </>
          )}
        </div>
      )}
      {body}
    </div>
  );

  return (
    <div className="cc-art">
      <div className="cc-art-side vw-side" hidden={hideList}>
        <div className="vw-tools">
          {!isRemote() && (
            <button className="hs-btn vw-open" onClick={() => void pickFile()} title="Abrir cualquier archivo">
              <Icon name="folder" size={13} />
              Abrir…
            </button>
          )}
          <button className="cc-mini-btn" onClick={loadList} title="Volver a buscar archivos en el proyecto" aria-label="Volver a buscar">
            <Icon name="refresh" size={12} />
          </button>
        </div>
        <input className="vw-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar archivo…" aria-label="Buscar archivo" />
        <div className="vw-groups" role="radiogroup" aria-label="Tipo de archivo">
          {GROUPS.map((g) => (
            <button key={g.v} role="radio" aria-checked={group === g.v} data-on={group === g.v ? "1" : "0"} onClick={() => setGroup(g.v)}>
              {g.l}
            </button>
          ))}
        </div>
        {shown.length === 0 ? (
          <div className="cc-side-empty">{files.length === 0 ? "Aún no hay archivos que ver en el proyecto." : "Ninguno coincide."}</div>
        ) : (
          shown.map((f) => (
            <button className="cc-art-file" data-active={sel === f.rel ? "1" : "0"} key={f.rel} onClick={() => open(f.rel)} title={f.rel}>
              <span className="vw-tag" data-g={groupOf(f.rel)} title={kindLabel(f.rel)}>
                {shortTag(f.rel)}
              </span>
              <span className="cc-art-file-name">{f.rel}</span>
              <span className="cc-art-file-ago">{ago(f.mtime_ms)}</span>
            </button>
          ))
        )}
      </div>
      {full ? createPortal(main, document.body) : main}
    </div>
  );
}
