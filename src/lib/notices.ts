// Avisos del modo director (los escribe el hub para los agentes): en el chat se pintan como
// una tarjeta corta en vez del mensaje entero, que lleva instrucciones pensadas para el agente.

export type Notice =
  /** Lienzo pide al líder que revise una entrega. */
  | { kind: "review"; task: number; title: string; by: string; round: number; summary: string; files: string[]; evidence: string }
  /** Lienzo recuerda al líder las entregas pendientes. */
  | { kind: "remind"; count: number; tasks: string }
  /** Lienzo pide al líder el encargo de una tarea que creaste tú. */
  | { kind: "brief"; task: number; title: string }
  /** El líder devuelve una entrega con órdenes de corrección. */
  | { kind: "fix"; task: number; title: string; round: number; limit: number; notes: string; last: boolean };

const REVIEW =
  /^🔎 Revisa la entrega de #(\d+) «([\s\S]*?)» de (\S+?)(?: \(tras la ronda (\d+) de correcciones\))?: ([\s\S]*?) · Archivos: ([\s\S]*?) · Evidencia: ([\s\S]*?)\. Decide con team_task_review/;
const REMIND = /^🔎 Tienes (\d+) entrega\(s\) esperando tu revisión: ([\s\S]*?)\. Míralas/;
const BRIEF = /^📝 Nueva tarea #(\d+) «([\s\S]*?)» del usuario/;
const FIX = /^🔧 Corrige #(\d+) «([\s\S]*?)» \(ronda (\d+) de (\d+)\): ([\s\S]*?)\s*Al terminar, ciérrala otra vez/;
const LAST = /\s*Es la última ronda: si no queda bien, la asumirá el líder\.\s*$/;

export function parseNotice(text: string): Notice | null {
  const t = text.trim();
  let m = REVIEW.exec(t);
  if (m) {
    return {
      kind: "review",
      task: Number(m[1]),
      title: m[2],
      by: m[3],
      round: m[4] ? Number(m[4]) : 0,
      summary: m[5].trim(),
      files: m[6].trim() === "—" ? [] : m[6].split(/,\s*/).filter(Boolean),
      evidence: m[7].trim() === "sin evidencia" ? "" : m[7].trim(),
    };
  }
  m = REMIND.exec(t);
  if (m) return { kind: "remind", count: Number(m[1]), tasks: m[2] };
  m = BRIEF.exec(t);
  if (m) return { kind: "brief", task: Number(m[1]), title: m[2] };
  m = FIX.exec(t);
  if (m) {
    return {
      kind: "fix",
      task: Number(m[1]),
      title: m[2],
      round: Number(m[3]),
      limit: Number(m[4]),
      notes: m[5].replace(LAST, "").trim(),
      last: LAST.test(m[5]),
    };
  }
  return null;
}

/**
 * Las órdenes de corrección suelen venir en una línea («1. … 2. …»): una por línea, para que
 * se lean como lista.
 */
export function splitOrders(notes: string): string {
  if (notes.includes("\n")) return notes;
  // Solo tras un final de frase: «=== 2. 2. Ejecuta» tiene un 2 que no es una orden.
  const parts = notes.split(/(?<=[.;:!?)])\s+(?=\d{1,2}[.)]\s)/);
  return parts.length > 1 ? parts.join("\n") : notes;
}
