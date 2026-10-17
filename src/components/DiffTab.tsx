import { useCallback, useEffect, useMemo, useState } from "react";
import { errMsg } from "../lib/team";
import type { TeamClaim, TeamEvent, TeamTask } from "../lib/team";
import {
  friendlySize,
  projectCommitPaths,
  projectDiffPaths,
  projectRevertPaths,
  projectStatus,
} from "../lib/project";
import type { GitFile, GitStatus, TaskDiff } from "../lib/project";

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

/** Archivos asociados a una tarea: reclamos y avisos de su dueño desde que nació. */
function taskPaths(task: TeamTask, events: TeamEvent[], claims: TeamClaim[]): string[] {
  const set = new Set<string>();
  if (task.owner) {
    for (const c of claims) {
      if (c.agent === task.owner && c.ts_ms >= task.created_ms) set.add(c.path);
    }
    for (const e of events) {
      if (e.agent !== task.owner || e.ts_ms < task.created_ms) continue;
      for (const f of e.files) set.add(f);
    }
  }
  return [...set].sort();
}

/** Cambios del proyecto (o de una tarea): archivos + diff contra HEAD. */
export function DiffTab({
  project,
  onChooseProject,
  onCount,
  tasks,
  events,
  claims,
  taskId,
  onTaskChange,
  onSay,
}: {
  project: string | null;
  onChooseProject: () => void;
  onCount: (n: number) => void;
  tasks: TeamTask[];
  events: TeamEvent[];
  claims: TeamClaim[];
  taskId: number | null;
  onTaskChange: (id: number | null) => void;
  onSay: (text: string, err?: boolean) => void;
}) {
  const [git, setGit] = useState<GitStatus | null>(null);
  const [tdiff, setTdiff] = useState<TaskDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "commit" | "revert">(null);
  const [busy, setBusy] = useState<null | "commit" | "revert">(null);

  const task = useMemo(
    () => (taskId != null ? (tasks.find((t) => t.id === taskId) ?? null) : null),
    [tasks, taskId],
  );
  const paths = useMemo(
    () => (task ? taskPaths(task, events, claims) : []),
    [task, events, claims],
  );

  const load = useCallback(() => {
    if (!project) return;
    setLoading(true);
    setErr(null);
    if (task) {
      projectDiffPaths(project, paths)
        .then((t) => {
          setTdiff(t);
          onCount(t.files.length);
        })
        .catch((e) => setErr(errMsg(e)))
        .finally(() => setLoading(false));
    } else {
      projectStatus(project)
        .then((g) => {
          setGit(g);
          setTdiff(null);
          onCount(g.files.length);
        })
        .catch((e) => setErr(errMsg(e)))
        .finally(() => setLoading(false));
    }
  }, [project, task, paths, onCount]);

  useEffect(() => {
    setGit(null);
    setTdiff(null);
    setConfirm(null);
    load();
  }, [load]);

  const doCommit = () => {
    if (!project || !task) return;
    setBusy("commit");
    projectCommitPaths(project, paths, `Tarea #${task.id}: ${task.title}`)
      .then((out) => {
        onSay(out || "commit hecho");
        setConfirm(null);
        load();
      })
      .catch((e) => onSay(errMsg(e), true))
      .finally(() => setBusy(null));
  };

  const doRevert = () => {
    if (!project || !task) return;
    setBusy("revert");
    projectRevertPaths(project, paths)
      .then((out) => {
        onSay(`Revertido (#${task.id}): ${out}`);
        setConfirm(null);
        load();
      })
      .catch((e) => onSay(errMsg(e), true))
      .finally(() => setBusy(null));
  };

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

  if (!task && git && !git.repo) {
    return (
      <div className="cc-empty">
        <div>La carpeta del proyecto no es un repositorio git, así que no hay diffs.</div>
        <div>Inicia un repo ahí (git init) o cambia la carpeta del equipo.</div>
      </div>
    );
  }

  if (task ? !tdiff : !git) {
    return <div className="cc-empty">{loading ? "Leyendo cambios…" : "—"}</div>;
  }

  const files: GitFile[] = task ? (tdiff?.files ?? []) : (git?.files ?? []);
  const diff = task ? (tdiff?.diff ?? "") : (git?.diff ?? "");
  const truncated = task ? (tdiff?.truncated ?? false) : (git?.truncated ?? false);
  const lines = diff.split(/\r?\n/);
  const shown = lines.slice(0, MAX_LINES);

  return (
    <div className="cc-artcol">
      <div className="cc-art-bar">
        <select
          className="cc-task-select"
          value={task ? String(task.id) : ""}
          onChange={(e) => onTaskChange(e.target.value ? Number(e.target.value) : null)}
          title="Revisar solo los cambios de una tarea"
        >
          <option value="">Todo el proyecto</option>
          {tasks.map((t) => (
            <option key={t.id} value={t.id}>
              #{t.id} {t.title}
              {t.status === "done" ? " · hecha" : t.owner ? ` · ${t.owner}` : ""}
            </option>
          ))}
        </select>
        {!task && <span className="cc-branch-chip">🌿 {git?.branch || "sin rama"}</span>}
        <span className="cc-art-meta">
          {task
            ? files.length === 0
              ? "sin cambios en sus archivos"
              : `${files.length} archivo${files.length === 1 ? "" : "s"} con cambios`
            : files.length === 0
              ? "sin cambios"
              : `${files.length} archivo${files.length === 1 ? "" : "s"} tocado${files.length === 1 ? "" : "s"}`}
        </span>
        <button
          className="cc-mini-btn"
          onClick={load}
          disabled={loading}
          title="Volver a leer los cambios"
        >
          {loading ? "…" : "⟳"}
        </button>
      </div>
      {task && (
        <div className="cc-review-bar">
          {paths.length === 0 ? (
            <span className="cc-art-note">
              Esta tarea aún no tiene archivos asociados (salen de los reclamos y avisos del equipo
              sobre ella).
            </span>
          ) : confirm === "commit" ? (
            <>
              <span className="cc-review-q">¿Confirmar esos archivos en git?</span>
              <button className="cc-mini-btn" onClick={doCommit} disabled={busy !== null}>
                {busy === "commit" ? "…" : "✓ Sí, commit"}
              </button>
              <button
                className="cc-mini-btn"
                onClick={() => setConfirm(null)}
                disabled={busy !== null}
              >
                Cancelar
              </button>
            </>
          ) : confirm === "revert" ? (
            <>
              <span className="cc-review-q cc-danger-text">
                Se restauran al último commit y se borran los nuevos. ¿Seguro?
              </span>
              <button className="cc-mini-btn cc-danger" onClick={doRevert} disabled={busy !== null}>
                {busy === "revert" ? "…" : "↺ Sí, revertir"}
              </button>
              <button
                className="cc-mini-btn"
                onClick={() => setConfirm(null)}
                disabled={busy !== null}
              >
                Cancelar
              </button>
            </>
          ) : (
            <>
              <span className="cc-art-meta">
                Revisión de #{task.id}: {paths.length} archivo{paths.length === 1 ? "" : "s"} de la
                tarea
              </span>
              <span className="cc-review-spacer" />
              <button
                className="cc-mini-btn"
                onClick={() => setConfirm("commit")}
                disabled={files.length === 0}
                title={`git commit solo de los archivos de #${task.id}`}
              >
                ✓ Aceptar (commit)
              </button>
              <button
                className="cc-mini-btn cc-danger"
                onClick={() => setConfirm("revert")}
                disabled={files.length === 0}
                title="Devolver esos archivos al último commit"
              >
                ↺ Revertir…
              </button>
            </>
          )}
        </div>
      )}
      <div className="cc-files-row">
        {files.map((f) => (
          <span className="cc-file-chip" key={f.path} title={`${f.status} · ${f.path}`}>
            <b style={{ color: STATUS_COLOR[f.status[0]] ?? "#8b98b8" }}>{f.status}</b>
            {f.path}
          </span>
        ))}
      </div>
      {files.length === 0 ? (
        <div className="cc-empty">
          <div>
            {task
              ? "Sin archivos con cambios para esta tarea."
              : "Todo igual que en el último commit. Cuando los agentes editen algo, lo verás aquí."}
          </div>
        </div>
      ) : diff.trim() === "" ? (
        <div className="cc-empty">
          <div>
            {task
              ? "Los archivos de esta tarea no tienen diff contra HEAD: están iguales o son nuevos y git aún no los ve (sin añadir)."
              : "Los archivos tocados son nuevos y aún no están en git: por eso no hay diff todavía."}
          </div>
          {!task && (
            <div>Con `git add` (o cuando los agentes guarden y commiteen) aparecerán aquí como líneas añadidas.</div>
          )}
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
      {truncated && (
        <div className="cc-art-note">El diff es enorme y viene recortado a {friendlySize(400 * 1024)}.</div>
      )}
      <div className="cc-art-note">
        Vista de solo lectura (git diff HEAD). «Aceptar» confirma solo los archivos de la tarea;
        «Revertir» los devuelve al último commit. Con F3 llegarán los worktrees por tarea y la
        fusión con aceptar/rechazar por bloque.
      </div>
    </div>
  );
}
