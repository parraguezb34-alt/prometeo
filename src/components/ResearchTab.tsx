import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { agentColor, agentLabel, ago, errMsg } from "../lib/team";
import type { TeamTask } from "../lib/team";
import {
  bestFile,
  coverage,
  kindCount,
  fileLabel,
  overall,
  phasesOf,
  researchDir,
  researchList,
  researchRead,
  researchRemove,
  researchStart,
} from "../lib/research";
import type { Research, ResearchMode } from "../lib/research";
import { Markdown } from "./Markdown";
import { Icon } from "./Icon";
import "../research.css";

const MODES: { v: ResearchMode; l: string; d: string }[] = [
  { v: "rapida", l: "Rápida", d: "Un agente, por rondas: busca, lee, anota y no para hasta tener evidencia." },
  { v: "profunda", l: "Profunda", d: "El equipo divide la pregunta, investiga en paralelo, verifica las fuentes y escribe el informe." },
];

/** Último agente elegido para la investigación rápida. */
const WHO_KEY = "lienzo.research.who";

const STATE_ES = { lista: "Lista", "en-curso": "En curso", parada: "Sin tareas" } as const;

/**
 * Investigación con el equipo: una pregunta se convierte en tareas encadenadas para los agentes
 * (cada uno busca con sus herramientas web) y el resultado queda en
 * `.lienzo/investigaciones/<id>/`: plan, hallazgos, verificación e informe.
 */
export function ResearchTab({
  project,
  tasks,
  online,
  leader,
  dispatchOn,
  onDispatchOn,
  onSay,
  onAsk,
}: {
  project: string | null;
  tasks: TeamTask[];
  /** Agentes en línea con terminal (los que pueden investigar ahora). */
  online: string[];
  leader: string;
  dispatchOn: boolean;
  onDispatchOn: () => void;
  onSay: (text: string, error?: boolean) => void;
  /** Lleva un texto al compositor del chat. */
  onAsk: (text: string) => void;
}) {
  const [list, setList] = useState<Research[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [text, setText] = useState<string>("");
  const [question, setQuestion] = useState("");
  const [mode, setMode] = useState<ResearchMode>("rapida");
  const [who, setWho] = useState(() => {
    try {
      return localStorage.getItem(WHO_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const pickWho = (a: string) => {
    setWho(a);
    try {
      localStorage.setItem(WHO_KEY, a);
    } catch {
      /* sin almacenamiento: se elige cada vez */
    }
  };
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  const load = useCallback(() => {
    if (!project) return;
    researchList(project)
      .then(setList)
      .catch(() => {});
  }, [project]);
  useEffect(() => {
    load();
    const id = window.setInterval(load, 4000);
    return () => window.clearInterval(id);
  }, [load]);

  const cur = list.find((r) => r.id === sel) ?? null;
  // Al elegir una investigación se abre su mejor archivo (el informe si ya está).
  useEffect(() => {
    setConfirmDel(false);
    setFile(cur ? bestFile(cur) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);
  const shown = file ?? (cur ? bestFile(cur) : null);
  const mtime = cur?.files.find((f) => f.name === shown)?.mtime_ms ?? 0;
  useEffect(() => {
    if (!project || !cur || !shown) {
      setText("");
      return;
    }
    researchRead(project, cur.id, shown)
      .then(setText)
      .catch((e) => setText(`_${errMsg(e)}_`));
  }, [project, cur?.id, shown, mtime]);

  // Quién hará cada cosa (lo mismo que decidirá el backend).
  const lead = online.includes(leader) ? leader : (online[0] ?? "");
  const workers = online.filter((a) => a !== lead);
  const quick = online.includes(who) ? who : (workers[0] ?? lead);
  const plan =
    mode === "rapida"
      ? quick
        ? `Investiga ${agentLabel(quick)}.`
        : ""
      : lead
        ? `Planea y escribe el informe ${agentLabel(lead)}; ${
            workers.length ? `investigan ${workers.map(agentLabel).join(", ")}; verifica ${agentLabel(workers[0])}.` : "hace también las partes y la verificación."
          }`
        : "";

  const start = async () => {
    if (!project || busy) return;
    const q = question.trim();
    if (q.length < 4) return;
    setBusy(true);
    try {
      const r =
        mode === "rapida"
          ? await researchStart(project, q, "rapida", lead, [quick])
          : await researchStart(project, q, "profunda", lead, online);
      setQuestion("");
      setSel(r.id);
      load();
      onSay(
        mode === "rapida"
          ? `🔎 Investigación en marcha con ${agentLabel(quick)}.`
          : `🔎 Investigación profunda en marcha: ${r.tasks.length} tareas encadenadas.`,
      );
    } catch (e) {
      onSay(errMsg(e), true);
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (!project || !cur) return;
    try {
      await researchRemove(project, cur.id);
      setSel(null);
      load();
    } catch (e) {
      onSay(errMsg(e), true);
    }
  };

  const cov = useMemo(() => {
    if (!cur) return null;
    // Cuenta sobre la lista de fuentes final (la verificación o el informe), o lo que haya.
    return text ? coverage(text) : null;
  }, [cur, text]);

  if (!project) return <div className="rs-empty">Elige un proyecto para investigar.</div>;

  return (
    <div className="rs">
      <aside className="rs-side">
        <form
          className="rs-new"
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void start();
            }}
            placeholder="¿Qué quieres investigar? Sé concreto: qué, para qué y con qué límites (país, fecha, presupuesto…)."
            rows={4}
            aria-label="Pregunta a investigar"
          />
          <div className="rs-seg" role="radiogroup" aria-label="Tipo de investigación">
            {MODES.map((m) => (
              <button
                key={m.v}
                type="button"
                role="radio"
                aria-checked={mode === m.v}
                data-on={mode === m.v ? "1" : "0"}
                onClick={() => setMode(m.v)}
                title={m.d}
              >
                {m.l}
              </button>
            ))}
          </div>
          <small className="rs-hint">{MODES.find((m) => m.v === mode)?.d}</small>
          {mode === "rapida" && online.length > 1 && (
            <label className="rs-who">
              <span>Quién</span>
              <select className="cc-mini-select" value={quick} onChange={(e) => pickWho(e.target.value)}>
                {online.map((a) => (
                  <option key={a} value={a}>
                    {agentLabel(a)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {online.length === 0 ? (
            <small className="rs-warn">No hay agentes en línea: abre al menos uno para investigar.</small>
          ) : (
            <small className="rs-plan">{plan}</small>
          )}
          {!dispatchOn && (
            <small className="rs-warn">
              El reparto automático está apagado y las tareas no empezarán solas.{" "}
              <button type="button" className="rs-link" onClick={onDispatchOn}>
                Encenderlo
              </button>
            </small>
          )}
          <button className="cc-btn rs-go" type="submit" disabled={busy || question.trim().length < 4 || online.length === 0}>
            <Icon name="search" size={14} />
            {busy ? "Preparando…" : "Investigar"}
          </button>
        </form>

        <div className="rs-list">
          {list.length === 0 && <div className="rs-none">Aún no hay investigaciones en este proyecto.</div>}
          {list.map((r) => {
            const st = overall(r, tasks);
            const ph = phasesOf(r, tasks);
            const now = ph.find((p) => p.state !== "done");
            return (
              <button key={r.id} className="rs-item" data-active={r.id === sel ? "1" : "0"} onClick={() => setSel(r.id)}>
                <span className="rs-item-q">{r.question}</span>
                <span className="rs-item-m">
                  <span className="rs-chip" data-mode={r.mode}>
                    {r.mode === "profunda" ? "Profunda" : "Rápida"}
                  </span>
                  <span className="rs-state" data-st={st}>
                    {st === "en-curso" && now ? now.label : STATE_ES[st]}
                  </span>
                  <time>hace {ago(r.created_ms)}</time>
                </span>
                <span className="rs-dots" aria-hidden="true">
                  {ph.map((p) => (
                    <i key={p.key} data-st={p.state} />
                  ))}
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      <section className="rs-main">
        {!cur ? (
          <div className="rs-intro">
            <Icon name="search" size={28} />
            <h3>Investigar con el equipo</h3>
            <p>
              Escribe una pregunta y el equipo la investiga en la web con sus propias herramientas. Cada dato lleva su fuente, y
              no se da por terminada hasta tener al menos dos fuentes y una oficial o primaria.
            </p>
            <ol>
              <li>
                <b>Rápida</b>: un agente hace rondas de buscar → leer → anotar, hasta que hay evidencia suficiente.
              </li>
              <li>
                <b>Profunda</b>: el líder divide la pregunta, cada agente investiga su parte en paralelo, otro verifica las
                fuentes y el líder escribe el informe.
              </li>
            </ol>
            <p className="rs-muted">Todo queda en la carpeta del proyecto: .lienzo/investigaciones/</p>
          </div>
        ) : (
          <>
            <header className="rs-head">
              <div className="rs-head-q">
                <h3>{cur.question}</h3>
                <small>
                  {cur.mode === "profunda" ? "Profunda" : "Rápida"} · {researchDir(cur.id)}
                </small>
              </div>
              <div className="rs-actions">
                <button
                  className="hs-btn"
                  onClick={() => onAsk(`Sobre la investigación ${researchDir(cur.id)}/informe.md: `)}
                  title="Escribe en el chat sobre este informe"
                >
                  <Icon name="msg" size={13} />
                  Comentar en el chat
                </button>
                {confirmDel ? (
                  <>
                    <button className="hs-btn rs-danger" onClick={() => void del()}>
                      Borrar de verdad
                    </button>
                    <button className="hs-btn" onClick={() => setConfirmDel(false)}>
                      No
                    </button>
                  </>
                ) : (
                  <button className="hs-btn" onClick={() => setConfirmDel(true)} title="Borra su carpeta (las tareas quedan)">
                    <Icon name="trash" size={13} />
                  </button>
                )}
              </div>
            </header>

            <ol className="rs-steps">
              {phasesOf(cur, tasks).map((p) => (
                <li key={p.key} data-st={p.state}>
                  <i />
                  <span>
                    <b>{p.label}</b>
                    {p.who && (
                      <small>
                        {p.who.split(", ").map((a) => (
                          <span key={a} style={{ "--ac": agentColor(a) } as CSSProperties}>
                            {agentLabel(a)}
                          </span>
                        ))}
                      </small>
                    )}
                  </span>
                </li>
              ))}
            </ol>

            {cur.files.length > 0 && (
              <div className="rs-files" role="tablist">
                {cur.files.map((f) => (
                  <button
                    key={f.name}
                    role="tab"
                    aria-selected={f.name === shown}
                    data-on={f.name === shown ? "1" : "0"}
                    onClick={() => setFile(f.name)}
                  >
                    {fileLabel(f.name)}
                  </button>
                ))}
              </div>
            )}

            {cov && shown && shown !== "plan.md" && (
              <div className="rs-cov" data-ok={cov.ok ? "1" : "0"}>
                <b>
                  {cov.total} {cov.total === 1 ? "fuente" : "fuentes"}
                </b>
                {(["oficial", "primaria", "secundaria", "comunidad", "comercial"] as const)
                  .filter((k) => cov.byKind[k] > 0)
                  .map((k) => (
                    <span key={k} data-k={k}>
                      {kindCount(k, cov.byKind[k])}
                    </span>
                  ))}
                {cov.why && <em>{cov.why}</em>}
              </div>
            )}

            <div className="rs-doc">
              {shown ? (
                <Markdown text={text} />
              ) : (
                <p className="rs-muted">
                  Aún no hay nada escrito. {overall(cur, tasks) === "parada" ? "Sus tareas ya no están en el equipo." : "Los agentes empezarán en cuanto estén libres."}
                </p>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
