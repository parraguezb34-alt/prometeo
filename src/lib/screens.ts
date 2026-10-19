import type { Terminal } from "@xterm/xterm";

// Lo que se ve ahora mismo en la terminal de cada sesión (la pantalla ya pintada por xterm, no el
// flujo crudo con códigos de control): de aquí se leen las preguntas de permiso de los agentes.

const screens = new Map<string, Terminal>();

export function registerScreen(sessionId: string, term: Terminal): () => void {
  screens.set(sessionId, term);
  return () => {
    if (screens.get(sessionId) === term) screens.delete(sessionId);
  };
}

/** Las líneas visibles de la terminal de una sesión (sin espacios al final). */
export function readScreen(sessionId: string): string[] | null {
  const term = screens.get(sessionId);
  if (!term) return null;
  const buf = term.buffer.active;
  const out: string[] = [];
  const top = buf.baseY;
  for (let y = top; y < top + term.rows; y++) {
    out.push(buf.getLine(y)?.translateToString(true) ?? "");
  }
  return out;
}
