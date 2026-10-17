import { useCallback, useEffect, useState } from "react";
import { ago, errMsg, shortPath } from "../lib/team";
import { friendlySize, projectList, projectRead } from "../lib/project";
import type { DirEntry, FileData } from "../lib/project";

const PREVIEWABLE = ["html", "htm", "svg", "md", "markdown", "csv"];

function isPreviewable(rel: string): boolean {
  const i = rel.lastIndexOf(".");
  return i >= 0 && PREVIEWABLE.includes(rel.slice(i + 1).toLowerCase());
}

/** Explorador del proyecto + atajos de normas y skills. */
export function FilesTab({
  project,
  onChooseProject,
  onCharter,
  onPreview,
}: {
  project: string | null;
  onChooseProject: () => void;
  onCharter: () => void;
  onPreview: (rel: string) => void;
}) {
  const [rel, setRel] = useState("");
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<{ rel: string; data: FileData } | null>(null);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    (r: string) => {
      if (!project) return;
      setErr(null);
      setLoading(true);
      projectList(project, r)
        .then((list) => {
          setEntries(list);
          setRel(r);
          setOpen(null);
          setFileErr(null);
        })
        .catch((e) => setErr(errMsg(e)))
        .finally(() => setLoading(false));
    },
    [project],
  );

  useEffect(() => {
    setEntries(null);
    load("");
  }, [load]);

  const openFile = (path: string) => {
    if (!project) return;
    setFileErr(null);
    projectRead(project, path)
      .then((d) => setOpen({ rel: path, data: d }))
      .catch((e) => setFileErr(errMsg(e)));
  };

  if (!project) {
    return (
      <div className="cc-empty">
        <div>Elige la carpeta del proyecto para explorarla.</div>
        <button className="agent-btn" onClick={onChooseProject}>
          📂 Elegir carpeta
        </button>
      </div>
    );
  }

  const crumbs = rel ? rel.split("/") : [];

  return (
    <div className="cc-artcol">
      <div className="cc-art-bar">
        <span className="cc-crumbs">
          <button className="cc-crumb" onClick={() => load("")} title={project}>
            {shortPath(project)}
          </button>
          {crumbs.map((c, i) => (
            <span key={i}>
              <span className="cc-crumb-sep">/</span>
              <button
                className="cc-crumb"
                onClick={() => load(crumbs.slice(0, i + 1).join("/"))}
              >
                {c}
              </button>
            </span>
          ))}
        </span>
        <button className="cc-mini-btn" onClick={onCharter} title="Abrir las normas del equipo (Charter)">
          📜 Normas
        </button>
        <button
          className="cc-mini-btn"
          onClick={() => load(".agents/skills")}
          title="Lo que el equipo ha ido aprendiendo (.agents/skills)"
        >
          🌱 Skills
        </button>
        <button className="cc-mini-btn" onClick={() => load(rel)} title="Recargar" disabled={loading}>
          {loading ? "…" : "⟳"}
        </button>
      </div>
      <div className="cc-art">
        <div className="cc-art-side">
          {err ? (
            <div className="cc-side-empty">{err}</div>
          ) : !entries ? (
            <div className="cc-side-empty">{loading ? "Leyendo…" : "—"}</div>
          ) : entries.length === 0 ? (
            <div className="cc-side-empty">Carpeta vacía.</div>
          ) : (
            entries.map((e) => (
              <button
                className="cc-art-file"
                data-active={open?.rel === e.rel ? "1" : "0"}
                key={e.rel}
                onClick={() => (e.dir ? load(e.rel) : openFile(e.rel))}
                title={e.rel}
              >
                <span className="cc-art-file-name">
                  {e.dir ? "📁 " : "📄 "}
                  {e.name}
                </span>
                <span className="cc-art-file-ago">
                  {e.dir ? "" : friendlySize(e.size)} · {ago(e.mtime_ms)}
                </span>
              </button>
            ))
          )}
        </div>
        <div className="cc-art-main">
          {fileErr ? (
            <div className="cc-empty">{fileErr}</div>
          ) : !open ? (
            <div className="cc-empty">
              Un explorador rápido del proyecto: entra en carpetas, abre archivos, y edita las normas
              del equipo desde aquí.
            </div>
          ) : (
            <>
              <div className="cc-art-bar">
                <span className="cc-art-path" title={open.rel}>
                  {open.rel}
                </span>
                <span className="cc-art-meta">
                  {friendlySize(open.data.size)}
                  {open.data.truncated ? " · recortado" : ""}
                </span>
                {isPreviewable(open.rel) && (
                  <button
                    className="cc-mini-btn"
                    onClick={() => onPreview(open.rel)}
                    title="Abrir en la pestaña Preview (se refresca solo)"
                  >
                    👁 Ver render
                  </button>
                )}
              </div>
              {open.data.binary ? (
                <div className="cc-empty">Archivo binario: sin vista de texto.</div>
              ) : (
                <pre className="cc-pre">{open.data.text}</pre>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
