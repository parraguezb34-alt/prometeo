import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentColor, agentLabel, ago, errMsg } from "../lib/team";
import type { TeamEvent, TeamTask } from "../lib/team";
import { diffOf, diffStats, historyDiff, historyList, historyRevert, historySave } from "../lib/history";
import type { HDiff, HEntry, HFile, HList, HOutcome } from "../lib/history";
import { Icon } from "./Icon";
import { ConfirmButton } from "./ConfirmButton";
import "../history.css";

const MAX_LINES = 800;
const PAGE = 100;

function lineKind(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "h";
  if (line.startsWith("@@")) return "m";
  if (line.startsWith("+")) return "a";
  if (line.startsWith("-")) return "d";
  if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file"))
    return "h";
  return "c";
}

const STATUS_ES: Record<string, string> = { A: "nuevo", M: "cambiado", D: "borrado" };

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Quién hizo una entrada, en palabras. */
function whoOf(e: HEntry): string {
  if (e.kind === "inicio") return "Cómo estaba al empezar";
  if (e.kind === "deshacer" || e.kind === "rehacer" || e.kind === "manual") return "Tú";
  return e.by ? agentLabel(e.by) : "—";
}

function DiffView({ diff, truncated }: { diff: string; truncated: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const prevDiff = useRef(diff);
  if (prevDiff.current !== diff) {
    prevDiff.current = diff;
    setShowAll(false);
  }
  const lines = diff.split(/\r?\n/);
  const hasMore = lines.length > MAX_LINES;
  const shown = showAll ? lines : lines.slice(0, MAX_LINES);
  return (
    <div className="cc-diff hs-diff">
      {shown.map((line, i) => (
        <div className="cc-diff-line" data-k={lineKind(line)} key={i}>
          {line || " "}
        </div>
      ))}
      {!showAll && hasMore && (
        <div
          className="cc-diff-line"
          data-k="m"
          style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 8px" }}
        >
          <span>… recortado para no frenar la vista</span>
          <button
            type="button"
            className="hs-link"
            style={{ fontWeight: 600, cursor: "pointer" }}
            onClick={() => setShowAll(true)}
          >
            Mostrar todo ({lines.length} líneas)
          </button>
        </div>
      )}
      {(showAll || !hasMore) && truncated && (
        <div className="cc-diff-line" data-k="m">
          … el diff sigue en disco (recortado para no frenar la vista)
        </div>
      )}
    </div>
  );
}

/**
 * Historial del proyecto: una entrada por cada entrega de tarea, con lo que cambió y botones
 * para deshacerla o rehacerla. Arriba, lo que hay cambiado en disco y aún no está en ninguna.
 */
export function HistoryTab({
  project,
  tasks,
  events,
  focusTask,
  onFocusTask,
  onCount,
  onSay,
  onTaskNote,
  onOpenFile,
}: {
  project: string | null;
  tasks: TeamTask[];
  events: TeamEvent[];
  /** Tarea a la que se llega desde el chat o la lista de tareas. */
  focusTask: number | null;
  onFocusTask: (id: number | null) => void;
  onCount: (n: number) => void;
  onSay: (text: string, err?: boolean) => void;
  /** Deja constancia en la tarea (para que el equipo sepa que se deshizo). */
  onTaskNote: (id: number, text: string) => void;
  onOpenFile: (rel: string) => void;
}) {
  const [list, setList] = useState<HList | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [diff, setDiff] = useState<HDiff | null>(null);
  const [diffErr, setDiffErr] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [ask, setAsk] = useState<{ id: string; redo: boolean; warnings: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!project) return;
    historyList(project)
      .then((l) => {
        setList(l);
        setErr(null);
        onCount(l.pending.length);
      })
      .catch((e) => setErr(errMsg(e)));
  }, [project, onCount]);

  // Se relee cuando el equipo hace algo (las entregas se guardan justo después de su aviso).
  const evKey = events.length ? `${events.length}:${events[0]?.seq ?? ""}` : "";
  useEffect(() => {
    load();
    const t = window.setTimeout(load, 1500);
    return () => window.clearTimeout(t);
  }, [load, evKey]);

  useEffect(() => {
    setSel(null);
    setList(null);
  }, [project]);

  const entries = useMemo(() => {
    const all = list?.entries ?? [];
    return focusTask == null ? all : all.filter((e) => e.task === focusTask);
  }, [list, focusTask]);

  // La lista se pinta por tandas de 100: con historiales largos no frena la vista.
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => {
    setLimit(PAGE);
  }, [project, focusTask]);

  // Elige algo que enseñar: lo de la tarea pedida, lo sin guardar o la última entrega.
  const focusRef = useRef<number | null>(null);
  useEffect(() => {
    if (!list) return;
    const changedFocus = focusRef.current !== focusTask;
    focusRef.current = focusTask;
    if (!changedFocus && sel && (sel === "pending" ? list.pending.length > 0 : list.entries.some((e) => e.id === sel)))
      return;
    if (focusTask == null && list.pending.length > 0) setSel("pending");
    else setSel(entries.find((e) => e.kind !== "inicio")?.id ?? entries[0]?.id ?? null);
  }, [list, entries, focusTask, sel]);

  useEffect(() => {
    setDiff(null);
    setDiffErr(null);
    setFile(null);
    setAsk(null);
    if (!project || !sel) return;
    let live = true;
    historyDiff(project, sel)
      .then((d) => live && setDiff(d))
      .catch((e) => live && setDiffErr(errMsg(e)));
    return () => {
      live = false;
    };
  }, [project, sel, list?.entries[0]?.id, list?.pending.length]);

  const entry = sel && sel !== "pending" ? list?.entries.find((e) => e.id === sel) : undefined;
  const task = entry?.task != null ? tasks.find((t) => t.id === entry.task) : undefined;
  const files: HFile[] = sel === "pending" ? (list?.pending ?? []) : (entry?.files ?? []);
  const stats = useMemo(() => diffStats(diff?.diff ?? ""), [diff]);
  const shownDiff = file ? diffOf(diff?.diff ?? "", file) : (diff?.diff ?? "");

  const revert = async (id: string, redo: boolean, force: boolean) => {
    if (!project) return;
    setBusy(true);
    try {
      const o: HOutcome = await historyRevert(project, id, redo, force);
      if (!o.done) {
        if (o.warnings.length > 0) setAsk({ id, redo, warnings: o.warnings });
        else onSay(o.message || "No había nada que cambiar.");
        return;
      }
      setAsk(null);
      onSay(`${redo ? "↪" : "↩"} ${o.message}`);
      const e = list?.entries.find((x) => x.id === id);
      if (e?.task != null) {
        onTaskNote(
          e.task,
          redo
            ? "↪️ Rehiciste esta entrega desde el Historial: sus cambios vuelven a estar."
            : "↩️ Deshiciste esta entrega desde el Historial: sus archivos volvieron a como estaban antes.",
        );
      }
      load();
    } catch (e) {
      onSay(errMsg(e), true);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!project) return;
    setBusy(true);
    try {
      await historySave(project, "");
      onSay("Guardado en el historial: ahora puedes deshacerlo como una entrega más.");
      load();
    } catch (e) {
      onSay(errMsg(e), true);
    } finally {
      setBusy(false);
    }
  };

  if (!project) {
    return <div className="cc-empty">Elige la carpeta del proyecto para ver su historial.</div>;
  }
  if (err) {
    return (
      <div className="cc-empty">
        <div>No pude leer el historial: {err}</div>
        <button className="agent-btn" onClick={load}>
          Reintentar
        </button>
      </div>
    );
  }
  if (!list) return <div className="cc-empty">Preparando el historial…</div>;

  const realEntries = list.entries.filter((e) => e.kind !== "inicio");

  return (
    <div className="hs">
      <aside className="hs-list" aria-label="Entradas del historial">
        {focusTask != null && (
          <div className="hs-filter">
            Solo la tarea #{focusTask}
            <button className="hs-link" onClick={() => onFocusTask(null)}>
              Ver todo
            </button>
          </div>
        )}
        {focusTask == null && list.pending.length > 0 && (
          <button className="hs-item hs-pending" data-sel={sel === "pending" ? "1" : "0"} onClick={() => setSel("pending")}>
            <span className="hs-dot" />
            <span className="hs-item-body">
              <b>Sin guardar</b>
              <small>{plural(list.pending.length, "archivo cambiado", "archivos cambiados")} fuera de una entrega</small>
            </span>
          </button>
        )}
        {entries.slice(0, limit).map((e) => (
          <button
            key={e.id}
            className="hs-item"
            data-kind={e.kind}
            data-undone={e.undone ? "1" : "0"}
            data-sel={sel === e.id ? "1" : "0"}
            onClick={() => setSel(e.id)}
            title={e.title}
          >
            <span
              className="hs-dot"
              style={e.kind === "entrega" && e.by ? { background: agentColor(e.by) } : undefined}
            />
            <span className="hs-item-body">
              <b>{e.kind === "inicio" ? "Punto de partida" : e.title}</b>
              <small>
                {whoOf(e)} · {ago(e.ts_ms)}
                {e.kind !== "inicio" && ` · ${plural(e.files_total, "archivo", "archivos")}`}
              </small>
            </span>
            {e.undone && <span className="hs-tag">deshecha</span>}
          </button>
        ))}
        {entries.length > limit && (
          <button type="button" className="hs-link hs-showmore" onClick={() => setLimit((n) => n + PAGE)}>
            Ver más ({entries.length - limit})
          </button>
        )}
        {realEntries.length === 0 && focusTask == null && (
          <div className="hs-hint">
            Cada vez que un agente entregue una tarea, aquí quedará una copia de sus archivos para que
            puedas ver qué cambió y deshacerlo.
          </div>
        )}
        {focusTask != null && entries.length === 0 && (
          <div className="hs-hint">
            Esta tarea aún no tiene entregas en el historial (se guardan al cerrarla con sus archivos).
          </div>
        )}
      </aside>

      <section className="hs-detail">
        {!sel ? (
          <div className="cc-empty">Elige una entrada.</div>
        ) : (
          <>
            <header className="hs-head">
              <div className="hs-head-l">
                <h3>
                  {sel === "pending" ? "Cambios sin guardar" : entry?.kind === "inicio" ? "Punto de partida" : entry?.title}
                </h3>
                <small>
                  {sel === "pending"
                    ? "Están en disco pero no vinieron de una entrega. Guárdalos para poder deshacerlos."
                    : entry?.kind === "inicio"
                      ? "Cómo estaba el proyecto cuando Prometeo empezó a guardar el historial."
                      : entry?.kind === "deshacer" || entry?.kind === "rehacer"
                        ? `${entry ? new Date(entry.ts_ms).toLocaleString() : ""} · para ${
                            entry?.kind === "deshacer" ? "rehacerla" : "deshacerla"
                          }, ve a la entrega original`
                        : `${whoOf(entry!)} · ${entry ? new Date(entry.ts_ms).toLocaleString() : ""}${
                          task ? ` · tarea #${task.id}` : ""
                        }`}
                </small>
              </div>
              <div className="hs-actions">
                {sel === "pending" ? (
                  <button className="hs-btn" onClick={() => void save()} disabled={busy}>
                    <Icon name="check" size={14} />
                    Guardar
                  </button>
                ) : entry && (entry.kind === "entrega" || entry.kind === "manual") && entry.files_total > 0 ? (
                  entry.undone ? (
                    <button className="hs-btn" onClick={() => void revert(entry.id, true, false)} disabled={busy}>
                      <Icon name="redo" size={14} />
                      Rehacer
                    </button>
                  ) : (
                    <ConfirmButton
                      className="hs-btn hs-btn-warn"
                      onConfirm={() => void revert(entry.id, false, false)}
                      disabled={busy}
                      confirmText="¿Seguro? Pulsa otra vez"
                      title="Devuelve sus archivos a como estaban antes de esta entrega"
                    >
                      <Icon name="undo" size={14} />
                      Deshacer
                    </ConfirmButton>
                  )
                ) : null}
              </div>
            </header>

            {ask && ask.id === sel && (
              <div className="hs-ask" role="alert">
                <b>{ask.redo ? "¿Rehacer de todos modos?" : "¿Deshacer de todos modos?"}</b>
                <ul>
                  {ask.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
                <div className="hs-ask-row">
                  <button className="hs-btn hs-btn-warn" onClick={() => void revert(ask.id, ask.redo, true)} disabled={busy}>
                    Sí, {ask.redo ? "rehacer" : "deshacer"}
                  </button>
                  <button className="hs-btn" onClick={() => setAsk(null)} disabled={busy}>
                    Cancelar
                  </button>
                </div>
              </div>
            )}

            {entry?.kind === "inicio" ? (
              <div className="cc-empty">A partir de aquí, cada entrega queda guardada por separado.</div>
            ) : (
              <>
                {files.length > 0 && (
                  <div className="hs-files">
                    <button className="hs-file" data-sel={file == null ? "1" : "0"} onClick={() => setFile(null)}>
                      Todos
                    </button>
                    {files.map((f) => {
                      const st = stats.get(f.path);
                      return (
                        <button
                          key={f.path}
                          className="hs-file"
                          data-sel={file === f.path ? "1" : "0"}
                          data-st={f.status}
                          onClick={() => setFile(f.path)}
                          onDoubleClick={() => f.status !== "D" && onOpenFile(f.path)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && f.status !== "D") {
                              e.preventDefault();
                              onOpenFile(f.path);
                            }
                          }}
                          title={
                            f.status === "D"
                              ? `${STATUS_ES[f.status] ?? f.status}: ${f.path} (archivo borrado)`
                              : `${STATUS_ES[f.status] ?? f.status}: ${f.path} (doble clic o Enter para abrir en el visor)`
                          }
                          aria-label={
                            f.status === "D"
                              ? `${STATUS_ES[f.status] ?? f.status}: ${f.path}`
                              : `${STATUS_ES[f.status] ?? f.status}: ${f.path} (doble clic o Enter para abrir en el visor)`
                          }
                        >
                          <i>{f.status}</i>
                          {f.path}
                          {st && (st.a > 0 || st.d > 0) && (
                            <em>
                              {st.a > 0 && <span className="cc-add">+{st.a}</span>}
                              {st.d > 0 && <span className="cc-del">−{st.d}</span>}
                            </em>
                          )}
                        </button>
                      );
                    })}
                    {entry && entry.files_total > files.length && (
                      <span className="hs-more">y {entry.files_total - files.length} más</span>
                    )}
                  </div>
                )}
                {diffErr ? (
                  <div className="cc-empty">{diffErr}</div>
                ) : !diff ? (
                  <div className="cc-empty">Leyendo cambios…</div>
                ) : files.length === 0 ? (
                  <div className="cc-empty">Esta entrega no cambió archivos.</div>
                ) : shownDiff.trim() === "" ? (
                  <div className="cc-empty">Sin diferencias de texto (puede ser un archivo binario, como una imagen).</div>
                ) : (
                  <DiffView diff={shownDiff} truncated={diff.truncated} />
                )}
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
