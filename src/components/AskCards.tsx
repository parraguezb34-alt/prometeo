import { useState } from "react";
import type { Skill } from "../lib/skills";
import { findSkill } from "../lib/skills";
import type { TermPrompt } from "../lib/prompts";
import { agentLabel } from "../lib/team";
import type { QAnswer, QItem, TeamQuestion } from "../lib/team";
import { changeQuestionOther, chooseQuestionOption, emptyQuestionPicks, questionAnswers, questionPickReady, questionSummary } from "../lib/askDock";
import type { QuestionPick } from "../lib/askDock";
import { Icon } from "./Icon";

/**
 * Tarjetas del chat que esperan algo de ti: las preguntas de un agente (team_ask_user), con
 * sus opciones para elegir o escribir otra, y las skills que propone instalar.
 */

/** Opciones de un paso, compartidas por la tarjeta y el panel sobre el compositor. */
export function QuestionOptions({
  item, pick, index, busy, activeOption, onChoose, onOther, onEnter,
}: {
  item: QItem;
  pick: QuestionPick;
  index: number;
  busy: boolean;
  activeOption?: number;
  onChoose: (label: string) => void;
  onOther: (patch: Partial<QuestionPick>) => void;
  onEnter: () => void;
}) {
  return (
    <fieldset className="qa-q">
      <legend>
        {item.header && <span className="qa-tag">{item.header}</span>}
        {item.question}
        {item.multi && <small>Puedes elegir varias</small>}
      </legend>
      <div className="qa-opts" role={item.multi ? "group" : "radiogroup"}>
        {item.options.map((option, k) => {
          const on = pick.choices.includes(option.label);
          return (
            <button key={option.label} type="button" className="qa-opt"
              role={item.multi ? "checkbox" : "radio"} aria-checked={on}
              data-on={on ? "1" : "0"} data-kbd={activeOption === k ? "1" : undefined} disabled={busy}
              onClick={() => onChoose(option.label)}
              style={{ animationDelay: `${index * 60 + k * 40}ms` }}
            >
              <span className="qa-mark" data-multi={item.multi ? "1" : "0"}>
                {on && <Icon name="check" size={11} />}
              </span>
              <span className="qa-opt-t">
                <b>{option.label}</b>
                {option.description && <small>{option.description}</small>}
              </span>
            </button>
          );
        })}
        <div className="qa-other" data-on={pick.otherOn ? "1" : "0"}>
          {pick.otherOn ? (
            <input autoFocus value={pick.other} placeholder="Escribe tu respuesta…"
              onChange={(e) => onOther({ other: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); onEnter(); }
                if (e.key === "Escape") onOther({ otherOn: false, other: "" });
              }}
              disabled={busy}
            />
          ) : (
            <button type="button" className="qa-other-btn" onClick={() => onOther({ otherOn: true })} disabled={busy}>
              <Icon name="pencil" size={12} />
              Otra respuesta…
            </button>
          )}
        </div>
      </div>
    </fieldset>
  );
}

export function QuestionCard({
  q,
  onAnswer,
}: {
  q: TeamQuestion;
  onAnswer: (id: number, answers: QAnswer[] | null) => Promise<void>;
}) {
  const [picks, setPicks] = useState(() => emptyQuestionPicks(q));
  const [busy, setBusy] = useState(false);
  const [warnMissing, setWarnMissing] = useState(false);
  const done = q.answers != null || q.dismissed;
  const who = agentLabel(q.agent);

  const toggle = (i: number, label: string) => setPicks((cur) => chooseQuestionOption(q, cur, i, label));
  const setOther = (i: number, patch: Partial<(typeof picks)[number]>) =>
    setPicks((cur) => changeQuestionOther(q, cur, i, patch));

  const ready = picks.every(questionPickReady);
  const send = async (answers: QAnswer[] | null) => {
    setBusy(true);
    try {
      await onAnswer(q.id, answers);
    } finally {
      setBusy(false);
    }
  };
  const submit = () => void send(questionAnswers(q, picks));

  if (done) {
    return (
      <div className="qa-brief" title={questionSummary(q)}>
        <Icon name={q.dismissed ? "x" : "check"} size={12} />
        <span>{q.dismissed ? `Preferiste no contestar a ${who}` : `Contestaste a ${who}: ${questionSummary(q)}`}</span>
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
        <QuestionOptions key={i} item={it} pick={picks[i]} index={i} busy={busy}
          onChoose={(label) => toggle(i, label)}
          onOther={(patch) => setOther(i, patch)}
          onEnter={() => {
            if (ready) submit();
            else { setWarnMissing(true); window.setTimeout(() => setWarnMissing(false), 2500); }
          }}
        />
      ))}
      <div className="qa-foot">
        <span
          className="qa-hint"
          style={warnMissing ? { color: "var(--warn)", fontWeight: 600 } : undefined}
        >
          {warnMissing
            ? `Faltan respuestas antes de enviar`
            : ready
              ? "Listo para enviar"
              : `Falta${picks.filter((p) => !p.choices.length && !(p.otherOn && p.other.trim())).length > 1 ? "n respuestas" : " una respuesta"}`}
        </span>
        <button className="qa-send" disabled={!ready || busy} onClick={submit}>
          {busy ? "Enviando…" : "Enviar respuestas"}
          <Icon name="send" size={13} />
        </button>
      </div>
    </div>
  );
}

/** Un agente espera en su terminal que le des permiso (o elijas una opción): botones aquí mismo. */
export function PromptCard({
  agent,
  prompt,
  onPick,
  onTerminal,
  activeOption,
}: {
  agent: string;
  prompt: TermPrompt;
  onPick: (keys: string) => void;
  onTerminal?: () => void;
  activeOption?: number;
}) {
  const [sent, setSent] = useState<string | null>(null);
  return (
    <div className="tp" data-new="1">
      <div className="tp-head">
        <span className="tp-ic">
          <Icon name="shield" size={14} />
        </span>
        <div className="tp-t">
          <b>
            {agentLabel(agent)} {prompt.title === "Pide permiso" ? "pide permiso" : "te pregunta"}
          </b>
          {prompt.title !== "Pide permiso" && <span>{prompt.title}</span>}
        </div>
        {onTerminal && (
          <button className="cv-ghost" onClick={onTerminal} title="Ver su terminal">
            <Icon name="term" size={12} />
            Terminal
          </button>
        )}
      </div>
      {prompt.detail.length > 0 && (
        <pre
          className="tp-detail"
          style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", overflowWrap: "anywhere" }}
        >
          {prompt.detail.join("\n")}
        </pre>
      )}
      <div className="tp-opts">
        {prompt.options.map((o, index) => (
          <button
            key={o.label}
            className="tp-opt"
            data-tone={o.tone}
            data-kbd={activeOption === index ? "1" : undefined}
            disabled={sent !== null}
            onClick={() => {
              setSent(o.label);
              onPick(o.keys);
            }}
          >
            {sent === o.label ? "Enviado…" : o.label}
          </button>
        ))}
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
