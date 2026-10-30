import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { askQueue, changeQuestionOther, chooseQuestionOption, emptyQuestionPicks, nextQuestionStep, questionAnswers, questionPickReady } from "../lib/askDock";
import type { QuestionPick } from "../lib/askDock";
import type { TermPrompt } from "../lib/prompts";
import { agentLabel } from "../lib/team";
import type { QAnswer, TeamQuestion } from "../lib/team";
import { PromptCard, QuestionOptions } from "./AskCards";
import { Icon } from "./Icon";

function QuestionStep({ q, onAnswer }: {
  q: TeamQuestion;
  onAnswer: (id: number, answers: QAnswer[] | null) => Promise<void>;
}) {
  const [picks, setPicks] = useState<QuestionPick[]>(() => emptyQuestionPicks(q));
  const [step, setStep] = useState(0);
  const [activeOption, setActiveOption] = useState(0);
  const [busy, setBusy] = useState(false);
  const item = q.items[step];
  const pick = picks[step];
  const ready = questionPickReady(pick);

  const send = async (answers: QAnswer[] | null) => {
    if (busy) return;
    setBusy(true);
    try { await onAnswer(q.id, answers); }
    finally { setBusy(false); }
  };
  const advance = (next: QuestionPick[]) => {
    const following = nextQuestionStep(q, next, step);
    if (following === null) return;
    if (following < q.items.length) {
      setStep(following);
      setActiveOption(0);
    } else {
      void send(questionAnswers(q, next));
    }
  };
  const choose = (label: string) => {
    if (busy) return;
    const next = chooseQuestionOption(q, picks, step, label);
    setPicks(next);
    if (!item.multi) advance(next);
  };
  const other = (patch: Partial<QuestionPick>) =>
    setPicks((current) => changeQuestionOther(q, current, step, patch));
  const onKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (busy || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target instanceof HTMLInputElement) return;
    const number = Number(e.key);
    if (/^[1-4]$/.test(e.key) && number <= item.options.length) {
      e.preventDefault();
      choose(item.options[number - 1].label);
    } else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      setActiveOption((i) => Math.min(i + 1, item.options.length - 1));
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      setActiveOption((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      if (item.multi && ready) advance(picks);
      else if (item.options[activeOption]) choose(item.options[activeOption].label);
    }
  };

  return (
    <div className="qa ad-question" onKeyDown={onKeys}>
      <div className="qa-head">
        <span className="qa-ic"><Icon name="msg" size={13} /></span>
        <b>{agentLabel(q.agent)} te pregunta</b>
        <span className="ad-step">{step + 1} de {q.items.length}</span>
        <span className="cv-grow" />
        <button type="button" className="cv-ghost" disabled={busy} onClick={() => void send(null)}>
          Que decida {agentLabel(q.agent)}
        </button>
      </div>
      {q.context && <p className="qa-ctx">{q.context}</p>}
      <QuestionOptions item={item} pick={pick} index={step} busy={busy} activeOption={activeOption}
        onChoose={choose} onOther={other} onEnter={() => advance(picks)} />
      <div className="qa-foot">
        <button type="button" className="cv-ghost" disabled={busy || step === 0}
          onClick={() => { setStep(step - 1); setActiveOption(0); }}>Atrás</button>
        <span className="qa-hint">{ready ? "Listo" : "Elige una respuesta"}</span>
        <button type="button" className="qa-send" disabled={!ready || busy} onClick={() => advance(picks)}>
          {busy ? "Enviando…" : step + 1 === q.items.length ? "Enviar respuestas" : "Continuar"}
          <Icon name="send" size={13} />
        </button>
      </div>
      <span className="ad-kbd" aria-hidden="true">
        {item.options.map((option, i) => <span key={option.label} data-active={activeOption === i ? "1" : "0"}>{i + 1}</span>)}
        <small>1–4 · flechas · Enter</small>
      </span>
    </div>
  );
}

export function AskDock({ questions, prompts, onAnswer, onPick, onTerminal }: {
  questions: TeamQuestion[];
  prompts: Record<string, TermPrompt>;
  onAnswer: (id: number, answers: QAnswer[] | null) => Promise<void>;
  onPick: (agent: string, keys: string) => void;
  onTerminal: (agent: string) => void;
}) {
  const seen = useRef(new Map<string, number>());
  const promptItems = Object.entries(prompts).map(([agent, prompt]) => {
    const key = `${agent}:${prompt.key}`;
    if (!seen.current.has(key)) seen.current.set(key, Date.now());
    return { agent, prompt, since: seen.current.get(key)! };
  });
  const activeKeys = new Set(promptItems.map(({ agent, prompt }) => `${agent}:${prompt.key}`));
  for (const key of seen.current.keys()) if (!activeKeys.has(key)) seen.current.delete(key);
  const queue = askQueue(questions, promptItems);
  const current = queue[0];
  const dock = useRef<HTMLDivElement>(null);
  const [promptCursor, setPromptCursor] = useState(0);
  useEffect(() => {
    if (!current) return;
    setPromptCursor(0);
    const active = document.activeElement;
    if (active?.tagName !== "TEXTAREA" && active?.tagName !== "INPUT") dock.current?.focus();
  }, [current?.key]);
  if (!current) return null;

  const onPromptKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (current.kind !== "prompt" || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target instanceof HTMLInputElement) return;
    const buttons = [...(dock.current?.querySelectorAll<HTMLButtonElement>(".tp-opt:not(:disabled)") ?? [])];
    const number = Number(e.key);
    if (/^[1-4]$/.test(e.key) && buttons[number - 1]) {
      e.preventDefault(); buttons[number - 1].click();
    } else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault(); setPromptCursor((i) => Math.min(i + 1, buttons.length - 1));
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault(); setPromptCursor((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement) && buttons[promptCursor]) {
      e.preventDefault(); buttons[promptCursor].click();
    }
  };

  return (
    <div className="ad-dock" ref={dock} tabIndex={-1} onKeyDown={onPromptKeys}
      aria-label="Respuestas pendientes" data-kind={current.kind}>
      <div className="ad-queue">
        <strong>{current.kind === "question" ? "Pregunta pendiente" : "Permiso pendiente"}</strong>
        {queue.length > 1 && <span>+{queue.length - 1} en cola</span>}
      </div>
      {current.kind === "question" ? (
        <QuestionStep key={current.key} q={current.question} onAnswer={onAnswer} />
      ) : (
        <PromptCard key={current.key} agent={current.agent} prompt={current.prompt}
          activeOption={promptCursor}
          onPick={(keys) => onPick(current.agent, keys)}
          onTerminal={() => onTerminal(current.agent)} />
      )}
    </div>
  );
}
