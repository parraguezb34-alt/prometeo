import type { TermPrompt } from "./prompts";
import type { QAnswer, TeamQuestion } from "./team";

export type QuestionPick = { choices: string[]; other: string; otherOn: boolean };
export type PromptWaiting = { agent: string; prompt: TermPrompt; since: number };
export type AskQueueItem =
  | { kind: "question"; key: string; since: number; question: TeamQuestion }
  | { kind: "prompt"; key: string; since: number; agent: string; prompt: TermPrompt };

/** Una sola cola para preguntas del hub y permisos vistos en las terminales. */
export function askQueue(questions: TeamQuestion[], prompts: PromptWaiting[]): AskQueueItem[] {
  return [
    ...questions.filter((q) => !q.answers && !q.dismissed).map((question) => ({
      kind: "question" as const, key: `q${question.id}`, since: question.ts_ms, question,
    })),
    ...prompts.map(({ agent, prompt, since }) => ({
      kind: "prompt" as const, key: `p${agent}:${prompt.key}`, since, agent, prompt,
    })),
  ].sort((a, b) => a.since - b.since || a.key.localeCompare(b.key));
}

export function emptyQuestionPicks(q: TeamQuestion): QuestionPick[] {
  return q.items.map(() => ({ choices: [], other: "", otherOn: false }));
}

export function chooseQuestionOption(
  q: TeamQuestion, picks: QuestionPick[], index: number, label: string,
): QuestionPick[] {
  return picks.map((pick, i) => {
    if (i !== index) return pick;
    if (!q.items[index]?.multi) return { choices: [label], other: "", otherOn: false };
    const choices = pick.choices.includes(label)
      ? pick.choices.filter((choice) => choice !== label)
      : [...pick.choices, label];
    return { ...pick, choices };
  });
}

export function changeQuestionOther(
  q: TeamQuestion, picks: QuestionPick[], index: number, patch: Partial<QuestionPick>,
): QuestionPick[] {
  return picks.map((pick, i) => i !== index ? pick : {
    ...pick, ...patch,
    choices: !q.items[index]?.multi && patch.otherOn ? [] : pick.choices,
  });
}

export function questionPickReady(pick: QuestionPick): boolean {
  return pick.choices.length > 0 || (pick.otherOn && pick.other.trim().length > 0);
}

/** Siguiente paso; el índice igual al largo indica que toca enviar todo junto. */
export function nextQuestionStep(q: TeamQuestion, picks: QuestionPick[], index: number): number | null {
  return questionPickReady(picks[index]) ? Math.min(index + 1, q.items.length) : null;
}

export function questionAnswers(q: TeamQuestion, picks: QuestionPick[]): QAnswer[] {
  return q.items.map((item, i) => ({
    question: item.question,
    choices: picks[i]?.choices ?? [],
    other: picks[i]?.otherOn ? picks[i].other.trim() : "",
  }));
}

export function questionSummary(q: TeamQuestion): string {
  if (q.dismissed) return "Preferiste no contestar";
  return q.items.map((item, i) => {
    const answer = q.answers?.find((a) => a.question === item.question) ?? q.answers?.[i];
    const value = [...(answer?.choices ?? []), ...(answer?.other ? [answer.other] : [])].join(", ");
    return `${item.header || item.question} → ${value || "sin respuesta"}`;
  }).join(" · ");
}
