import { useCallback, useEffect, useRef, useState } from "react";
import { ago, errMsg } from "../lib/team";
import type { TeamEvent } from "../lib/team";
import { friendlySize, projectRead, projectRecent } from "../lib/project";
import type { FileData, RecentFile } from "../lib/project";

const PREVIEW_EXTS = ["html", "htm", "svg", "md", "markdown", "csv"];

function extOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i < 0 ? "" : path.slice(i + 1).toLowerCase();
}

function isRenderable(rel: string): boolean {
  const e = extOf(rel);
  return e === "html" || e === "htm" || e === "svg";
}

/** Preview de los archivos que generan los agentes (HTML/SVG en iframe, el
 * resto como texto). Se recarga solo cuando un evento del equipo toca el
 * archivo abierto. */
export function PreviewTab({
  project,
  events,
  openRel,
  onChooseProject,
}: {
  project: string | null;
  events: TeamEvent[];
  /** Archivo a abrir desde fuera (pestaña Archivos). */
  openRel?: string | null;
  onChooseProject: () => void;
}) {
  const [files, setFiles] = useState<RecentFile[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [data, setData] = useState<FileData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const lastSeq = useRef(0);

  const loadList = useCallback(() => {
    if (!project) return;
    projectRecent(project, PREVIEW_EXTS, 60)
      .then(setFiles)
      .catch(() => setFiles([]));
  }, [project]);

  const open = useCallback(
    (rel: string) => {
      if (!project) return;
      setSel(rel);
      setErr(null);
      setLoading(true);
      projectRead(project, rel)
        .then(setData)
        .catch((e) => {
          setData(null);
          setErr(errMsg(e));
        })
        .finally(() => setLoading(false));
    },
    [project],
  );

  useEffect(() => {
    setSel(null);
    setData(null);
    loadList();
  }, [loadList]);

  // La pestaña Archivos puede pedir abrir un archivo concreto.
  useEffect(() => {
    if (openRel) open(openRel);
  }, [openRel, open]);

  // Auto-refresco: si un evento nuevo del equipo toca el archivo abierto (o
  // aparecen archivos nuevos), recargar sin que el usuario haga nada.
  useEffect(() => {
    const top = events[0]?.seq ?? 0;
    if (top <= lastSeq.current) return;
    const fresh = events.filter((e) => e.seq > lastSeq.current);
    lastSeq.current = top;
    if (fresh.some((e) => e.files.length > 0)) loadList();
    if (sel && fresh.some((e) => e.files.some((f) => f.replace(/\\/g, "/").endsWith(sel)))) {
      open(sel);
    }
  }, [events, sel, open, loadList]);

  if (!project) {
    return (
      <div className="cc-empty">
        <div>El preview vive en la carpeta del proyecto.</div>
        <button className="agent-btn" onClick={onChooseProject}>
          📂 Elegir carpeta
        </button>
      </div>
    );
  }

  const renderable = sel ? isRenderable(sel) : false;
  const previewKey = data ? `${data.mtime_ms}-${data.size}` : "none";

  return (
    <div className="cc-art">
      <div className="cc-art-side">
        <div className="cc-art-side-head">
          <span>Recientes</span>
          <button className="cc-mini-btn" onClick={loadList} title="Volver a escanear el proyecto">
            ⟳
          </button>
        </div>
        {files.length === 0 ? (
          <div className="cc-side-empty">
            Sin HTML, SVG, MD o CSV todavía. Cuando un agente genere uno, aparecerá aquí.
          </div>
        ) : (
          files.map((f) => (
            <button
              className="cc-art-file"
              data-active={sel === f.rel ? "1" : "0"}
              key={f.rel}
              onClick={() => open(f.rel)}
              title={f.rel}
            >
              <span className="cc-art-file-name">{f.rel}</span>
              <span className="cc-art-file-ago">{ago(f.mtime_ms)}</span>
            </button>
          ))
        )}
      </div>
      <div className="cc-art-main">
        {err ? (
          <div className="cc-empty">{err}</div>
        ) : !sel ? (
          <div className="cc-empty">
            Elige un archivo de la izquierda. Se actualiza solo cuando los agentes lo guardan.
          </div>
        ) : (
          <>
            <div className="cc-art-bar">
              <span className="cc-art-path" title={sel}>
                {sel}
              </span>
              {data && (
                <span className="cc-art-meta">
                  {friendlySize(data.size)}
                  {data.truncated ? " · recortado" : ""} · guardado hace {ago(data.mtime_ms)}
                </span>
              )}
              <button className="cc-mini-btn" onClick={() => open(sel)} disabled={loading} title="Recargar">
                {loading ? "…" : "⟳"}
              </button>
            </div>
            {!data ? (
              <div className="cc-empty">{loading ? "Leyendo…" : "—"}</div>
            ) : data.binary ? (
              <div className="cc-empty">Es un archivo binario; no hay vista previa.</div>
            ) : renderable ? (
              <iframe
                className="cc-frame"
                sandbox="allow-scripts"
                srcDoc={data.text}
                key={previewKey}
                title={sel}
              />
            ) : (
              <pre className="cc-pre">{data.text}</pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}
