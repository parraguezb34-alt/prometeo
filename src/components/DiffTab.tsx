import { useCallback, useEffect, useState } from "react";
import { errMsg } from "../lib/team";
import { friendlySize, projectStatus } from "../lib/project";
import type { GitStatus } from "../lib/project";

const MAX_LINES = 2500;

function lineKind(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "h";
  if (line.startsWith("@@")) return "m";
  if (line.startsWith("+")) return "a";
  if (line.startsWith("-")) return "d";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "h";
  return "c";
}

const STATUS_COLOR: Record<string, string> = {
  "?": "#7dcfff",
  A: "#9ece6a",
  M: "#e0af68",
  R: "#7dcfff",
  C: "#7dcfff",
  D: "#f7768e",
  U: "#f7768e",
};

/** Cambios del proyecto: archivos tocados + diff unificado contra HEAD. */
export function DiffTab({
  project,
  onChooseProject,
  onCount,
}: {
  project: string | null;
  onChooseProject: () => void;
  onCount: (n: number) => void;
}) {
  const [git, setGit] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!project) return;
    setLoading(true);
    projectStatus(project)
      .then((g) => {
        setGit(g);
        setErr(null);
        onCount(g.files.length);
      })
      .catch((e) => setErr(errMsg(e)))
      .finally(() => setLoading(false));
  }, [project, onCount]);

  useEffect(() => {
    setGit(null);
    load();
  }, [load]);

  if (!project) {
    return (
      <div className="cc-empty">
        <div>Aún no hay carpeta de proyecto: los cambios viven en ella.</div>
        <button className="agent-btn" onClick={onChooseProject}>
          📂 Elegir carpeta
        </button>
      </div>
    );
  }

  if (err) {
    return (
      <div className="cc-empty">
        <div>{err}</div>
        <button className="agent-btn" onClick={load}>
          Reintentar
        </button>
      </div>
    );
  }

  if (git && !git.repo) {
    return (
      <div className="cc-empty">
        <div>La carpeta del proyecto no es un repositorio git, así que no hay diffs.</div>
        <div>Inicia un repo ahí (git init) o cambia la carpeta del equipo.</div>
      </div>
    );
  }

  if (!git) return <div className="cc-empty">{loading ? "Leyendo cambios…" : "—"}</div>;

  const lines = git.diff.split(/\r?\n/);
  const shown = lines.slice(0, MAX_LINES);

  return (
    <div className="cc-artcol">
      <div className="cc-art-bar">
        <span className="cc-branch-chip">🌿 {git.branch || "sin rama"}</span>
        <span className="cc-art-meta">
          {git.files.length === 0
            ? "sin cambios"
            : `${git.files.length} archivo${git.files.length === 1 ? "" : "s"} tocado${git.files.length === 1 ? "" : "s"}`}
        </span>
        <button className="cc-mini-btn" onClick={load} disabled={loading} title="Volver a leer los cambios">
          {loading ? "…" : "⟳"}
        </button>
      </div>
      <div className="cc-files-row">
        {git.files.map((f) => (
          <span className="cc-file-chip" key={f.path} title={`${f.status} · ${f.path}`}>
            <b style={{ color: STATUS_COLOR[f.status[0]] ?? "#8b98b8" }}>{f.status}</b>
            {f.path}
          </span>
        ))}
      </div>
      {git.files.length === 0 ? (
        <div className="cc-empty">
          <div>Todo igual que en el último commit. Cuando los agentes editen algo, lo verás aquí.</div>
        </div>
      ) : git.diff.trim() === "" ? (
        <div className="cc-empty">
          <div>Los archivos tocados son nuevos y aún no están en git: por eso no hay diff todavía.</div>
          <div>Con `git add` (o cuando los agentes guarden y commiteen) aparecerán aquí como líneas añadidas.</div>
        </div>
      ) : (
        <div className="cc-diff">
          {shown.map((line, i) => (
            <div className="cc-diff-line" data-k={lineKind(line)} key={i}>
              {line || " "}
            </div>
          ))}
          {lines.length > shown.length && (
            <div className="cc-diff-line" data-k="m">
              … {lines.length - shown.length} líneas más (diff recortado en la vista)
            </div>
          )}
        </div>
      )}
      {git.truncated && (
        <div className="cc-art-note">El diff es enorme y viene recortado a {friendlySize(400 * 1024)}.</div>
      )}
      <div className="cc-art-note">
        Vista de solo lectura del árbol de trabajo (git diff HEAD). Con F3 llegan los worktrees por
        tarea y la fusión con aceptar/revertir por bloque.
      </div>
    </div>
  );
}
