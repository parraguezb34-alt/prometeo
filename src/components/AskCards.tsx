import { useState } from "react";
import type { Skill } from "../lib/skills";
import { findSkill } from "../lib/skills";
import { agentLabel } from "../lib/team";
import type { QAnswer, TeamQuestion } from "../lib/team";
import { Icon } from "./Icon";

/**
 * Tarjetas del chat que esperan algo de ti: las preguntas de un agente (team_ask_user), con
 * sus opciones para elegir o escribir otra, y las skills que propone instalar.
 */

type Pick = { choices: string[]; other: string; otherOn: boolean };

export function QuestionCard({
  q,
  onAnswer,
}: {
  q: TeamQuestion;
  onAnswer: (id: number, answers: QAnswer[] | null) => Promise<void>;
}) {
  const [picks, setPicks] = useState<Pick[]>(() => q.items.map(() => ({ choices: [], other: "", otherOn: false })));
  const [busy, setBusy] = useState(false);
  const done = q.answers != null || q.dismissed;
  const who = agentLabel(q.agent);

  const toggle = (i: number, label: string) =>
    setPicks((cur) =>
      cur.map((p, j) => {
        if (j !== i) return p;
        if (q.items[i].multi) {
          const has = p.choices.includes(label);
          return { ...p, choices: has ? p.choices.filter((c) => c !== label) : [...p.choices, label] };
        }
        return { ...p, choices: [label], otherOn: false, other: "" };
      }),
    );
  const setOther = (i: number, patch: Partial<Pick>) =>
    setPicks((cur) =>
      cur.map((p, j) =>
        j !== i ? p : { ...p, ...patch, choices: !q.items[i].multi && patch.otherOn ? [] : p.choices },
      ),
    );

  const ready = picks.every((p) => p.choices.length > 0 || (p.otherOn && p.other.trim()));
  const send = async (answers: QAnswer[] | null) => {
    setBusy(true);
    try {
      await onAnswer(q.id, answers);
    } finally {
      setBusy(false);
    }
  };
  const submit = () =>
    void send(
      q.items.map((it, i) => ({
        question: it.question,
        choices: picks[i].choices,
        other: picks[i].otherOn ? picks[i].other.trim() : "",
      })),
    );

  if (done) {
    return (
      <div className="qa" data-done="1">
        <div className="qa-head">
          <span className="qa-ic" data-done="1">
            <Icon name={q.dismissed ? "x" : "check"} size={12} />
          </span>
          <b>{q.dismissed ? `Preferiste no contestar a ${who}` : `Contestaste a ${who}`}</b>
        </div>
        {!q.dismissed && (
          <ul className="qa-sum">
            {q.items.map((it, i) => {
              const a = q.answers?.find((x) => x.question === it.question) ?? q.answers?.[i];
              const picked = [...(a?.choices ?? []), ...(a?.other ? [a.other] : [])];
              return (
                <li key={i}>
                  <span>{it.header || it.question}</span>
                  <span className="qa-chips">
                    {picked.length ? picked.map((p) => <i key={p}>{p}</i>) : <em>sin respuesta</em>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="qa" data-new="1">
      <div className="qa-head">
        <span className="qa-ic">
          <Icon name="msg" size={13} />
        </span>
        <b>
          {who} te pregunta{q.items.length > 1 ? ` · ${q.items.length} preguntas` : ""}
        </b>
        <span className="cv-grow" />
        <button className="cv-ghost" disabled={busy} onClick={() => void send(null)} title="Que decida el agente">
          Que decida {who}
        </button>
      </div>
      {q.context && <p className="qa-ctx">{q.context}</p>}
      {q.items.map((it, i) => (
        <fieldset className="qa-q" key={i}>
          <legend>
            {it.header && <span className="qa-tag">{it.header}</span>}
            {it.question}
            {it.multi && <small>Puedes elegir varias</small>}
          </legend>
          <div className="qa-opts" role={it.multi ? "group" : "radiogroup"}>
            {it.options.map((o, k) => {
              const on = picks[i].choices.includes(o.label);
              return (
                <button
                  key={o.label}
                  className="qa-opt"
                  role={it.multi ? "checkbox" : "radio"}
                  aria-checked={on}
                  data-on={on ? "1" : "0"}
                  disabled={busy}
                  onClick={() => toggle(i, o.label)}
                  style={{ animationDelay: `${i * 60 + k * 40}ms` }}
                >
                  <span className="qa-mark" data-multi={it.multi ? "1" : "0"}>
                    {on && <Icon name="check" size={11} />}
                  </span>
                  <span className="qa-opt-t">
                    <b>{o.label}</b>
                    {o.description && <small>{o.description}</small>}
                  </span>
                </button>
              );
            })}
            <div className="qa-other" data-on={picks[i].otherOn ? "1" : "0"}>
              {picks[i].otherOn ? (
                <input
                  autoFocus
                  value={picks[i].other}
                  placeholder="Escribe tu respuesta…"
                  onChange={(e) => setOther(i, { other: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && ready) submit();
                    if (e.key === "Escape") setOther(i, { otherOn: false, other: "" });
                  }}
                  disabled={busy}
                />
              ) : (
                <button className="qa-other-btn" onClick={() => setOther(i, { otherOn: true })} disabled={busy}>
                  <Icon name="pencil" size={12} />
                  Otra respuesta…
                </button>
              )}
            </div>
          </div>
        </fieldset>
      ))}
      <div className="qa-foot">
        <span className="qa-hint">
          {ready ? "Listo para enviar" : `Falta${picks.filter((p) => !p.choices.length && !(p.otherOn && p.other.trim())).length > 1 ? "n respuestas" : " una respuesta"}`}
        </span>
        <button className="qa-send" disabled={!ready || busy} onClick={submit}>
          {busy ? "Enviando…" : "Enviar respuestas"}
          <Icon name="send" size={13} />
        </button>
      </div>
    </div>
  );
}

const DISMISS_KEY = "lienzo.skillDismiss.v1";
function dismissed(): number[] {
  try {
    return JSON.parse(localStorage.getItem(DISMISS_KEY) ?? "[]") as number[];
  } catch {
    return [];
  }
}

export function SkillCard({
  seq,
  agent,
  source,
  reason,
  skills,
  onSkill,
}: {
  seq: number;
  agent: string;
  source: string;
  reason: string;
  skills: Skill[];
  onSkill: (source: string, agent: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(() => dismissed().includes(seq));
  const have = findSkill(skills, source);
  const name = have?.name ?? source.replace(/\/+$/, "").split("/").pop() ?? source;
  const isUrl = /^https?:|github\.com/.test(source);

  const go = async () => {
    setBusy(true);
    try {
      await onSkill(source, agent);
    } finally {
      setBusy(false);
    }
  };
  const drop = () => {
    try {
      localStorage.setItem(DISMISS_KEY, JSON.stringify([...dismissed(), seq].slice(-200)));
    } catch {
      /* sin almacenamiento: se oculta solo ahora */
    }
    setGone(true);
  };

  if (gone && !have?.enabled) {
    return (
      <div className="cv-line" data-tone="muted">
        <Icon name="x" size={13} />
        <span>
          Propuso la skill <b>{name}</b> · descartada
        </span>
      </div>
    );
  }
  return (
    <div className="sk-prop" data-on={have?.enabled ? "1" : "0"} data-new="1">
      <span className="sk-prop-ic">
        <Icon name={have?.enabled ? "check" : "book"} size={14} />
      </span>
      <div className="sk-prop-main">
        <b>
          {have?.enabled ? "Skill activa" : "Propone una skill"}: <code>{name}</code>
        </b>
        {reason && <p>{reason}</p>}
        {isUrl && (
          <span className="sk-prop-src" title={source}>
            {source}
          </span>
        )}
      </div>
      {!have?.enabled && (
        <div className="sk-prop-btns">
          <button className="cv-btn" data-tone="accent" disabled={busy} onClick={() => void go()}>
            {busy ? "Instalando…" : have ? "Encender" : "Instalar"}
          </button>
          <button className="cv-ghost" disabled={busy} onClick={drop}>
            Descartar
          </button>
        </div>
      )}
    </div>
  );
}
