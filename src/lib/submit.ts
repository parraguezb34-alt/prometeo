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
 * pierde y el mensaje nunca llega.
 */
export const DIALOG = /esc\s*dismiss/i;

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
  if (input.busyBefore || text.startsWith("/") || text.length < 8) return false;
  if (input.lastBusyMs >= input.sentMs) return false;
  const key = text.replace(/\s+/g, "").slice(0, 24);
  return cleanTerm(input.tail).replace(/\s+/g, "").includes(key);
}
