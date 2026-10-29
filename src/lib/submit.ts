/**
 * ¿Llegó el mensaje que Prometeo tecleó en la terminal de un agente? A veces el Enter se pierde
 * (la TUI estaba repintando, o lo tomó por parte de un pegado) y el texto se queda en el cuadro sin
 * enviar: el agente nunca empieza. La idea es de Orca (`terminal send --wait-submit`): tras enviar,
 * comprobar que el agente arrancó y, si no, volver a pulsar Enter una vez.
 *
 * Lógica pura (sin Tauri) para poder probarla.
 */

/** Cuánto se espera a que el agente se ponga a trabajar antes de mirar si el texto sigue en el cuadro. */
export const SUBMIT_CHECK_MS = 6_000;

/** Quita los escapes de la terminal y los spinners: deja el texto que se ve. */
export function cleanTerm(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // Los saltos de cursor separan palabras en pantalla: se dejan como espacio.
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, " ")
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[()][A-Z0-9]/g, "")
      // Spinners (braille, estrellas) fuera.
      .replace(/[⠀-⣿✻✶✳✢✽·•●◐◓◑◒]/g, " ")
  );
}

/**
 * Avisos que se quedan con el teclado hasta cerrarlos con Esc. Codex abre uno al arrancar si falla
 * algún servidor MCP («Warnings · 1 of 1 … esc dismiss & close»): lo que se teclee mientras tanto se
 * pierde y el mensaje nunca llega. Igual con sus buscadores: el del historial («Find: … No matches ·
 * full transcript · esc cancel») y el de mensajes anteriores («reverse-i-search:»), que se quedan
 * con todo lo tecleado (visto con Codex 0.164, 26/10/2026). Solo los de Codex: en Claude Code «esc
 * to cancel» es rechazar un permiso.
 */
export const DIALOG = /esc\s*dismiss|full\s+transcript\s+esc\s*cancel|reverse-i-search/i;

/**
 * ¿Hay que volver a pulsar Enter? Solo si el agente estaba libre al enviarlo, no se puso a trabajar
 * después y el principio del mensaje sigue en lo último que pintó su terminal. Los comandos con «/»
 * abren paneles en algunos CLIs, y un Enter de más elegiría una opción: con esos no se insiste.
 */
export function needsResubmit(input: {
  text: string;
  /** Lo último que pintó la terminal (en crudo). */
  tail: string;
  /** El agente ya trabajaba al enviarlo: el mensaje queda en cola y no hay nada que comprobar. */
  busyBefore: boolean;
  sentMs: number;
  /** Última vez que su terminal se vio trabajando (0 si nunca). */
  lastBusyMs: number;
}): boolean {
  const text = input.text.trim();
  if (input.busyBefore || !isMessage(text)) return false;
  if (input.lastBusyMs >= input.sentMs) return false;
  const key = text.replace(/\s+/g, "").slice(0, 24);
  const seen = cleanTerm(input.tail);
  // Un texto largo no se ve: Codex lo resume en «[Pasted Content 812 chars]» y Claude Code en
  // «[Pasted text #1 +3 lines]». Si eso sigue en el cuadro, tampoco se envió.
  if (PASTED.test(seen)) return true;
  return seen.replace(/\s+/g, "").includes(key);
}

const PASTED = /\[Pasted (?:Content \d+ chars|text #\d+[^\]]*)\]/i;

/**
 * ¿Dejó el programa de la terminal el modo de pegado «bracketed» encendido? Lo encienden con
 * `ESC[?2004h` y lo apagan con `ESC[?2004l`; manda el último que aparezca en `chunk`.
 */
export function bracketedAfter(before: boolean, chunk: string): boolean {
  const on = chunk.lastIndexOf("\x1b[?2004h");
  const off = chunk.lastIndexOf("\x1b[?2004l");
  if (on < 0 && off < 0) return before;
  return on > off;
}

/**
 * Lo que se teclea en una terminal con el pegado «bracketed» encendido: el texto entre sus marcas,
 * para que el CLI lo tome por un pegado entero. Sin ellas, Codex lo detecta como pegado por la
 * velocidad («paste burst») y el Enter que llega justo después se queda como salto de línea.
 */
/** ¿Es un mensaje para el agente (y no un comando «/…» o una respuesta corta como «y»)? */
export function isMessage(text: string): boolean {
  const t = text.trim();
  return t.length >= 8 && !t.startsWith("/");
}

export function asPaste(text: string, bracketed: boolean): string {
  return bracketed ? `\x1b[200~${text}\x1b[201~` : text;
}
