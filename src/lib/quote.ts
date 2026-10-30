/** Longitud máxima de un texto citado (~600 caracteres). */
export const MAX_QUOTE_CHARS = 600;

export interface Quote {
  text: string;
  agent: string;
}

/** Recorta el texto de la cita a un máximo de ~600 caracteres. */
export function truncateQuote(text: string, max = MAX_QUOTE_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max).trimEnd();
}

/**
 * Antepone cada línea de la cita con "> " seguido de una línea en blanco y el mensaje propio.
 * Si no hay cita o el texto de la cita está vacío, devuelve únicamente el texto propio.
 */
export function formatQuote(quoteText: string | null | undefined, ownText: string): string {
  const cleanOwn = ownText.trim();
  const cleanQuote = quoteText?.trim();
  if (!cleanQuote) return cleanOwn;
  const quotedLines = cleanQuote
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
  if (!cleanOwn) return quotedLines;
  return `${quotedLines}\n\n${cleanOwn}`;
}
