// Adjuntos del compositor: imágenes, archivos y texto largo pegado. Viajan a los agentes
// como rutas en una línea «📎 …» al final del mensaje; el chat la cambia por miniaturas y fichas.

export type AttKind = "image" | "text" | "file" | "dir";

export type Attachment = {
  kind: AttKind;
  path: string;
  name: string;
  size: number;
  /** Líneas del texto pegado. */
  lines?: number;
  /** data: URL de la miniatura (imágenes) o el comienzo del texto pegado. */
  preview?: string;
  /** Texto pegado completo, mientras está en el compositor (para devolverlo al cuadro). */
  text?: string;
};

/** A partir de aquí, un texto pegado se adjunta como archivo en vez de llenar el cuadro. */
export const PASTE_LIMIT = { chars: 1500, lines: 25 };

/** Nombre del archivo donde se guarda un texto pegado. */
export const PASTED_NAME = "texto-pegado.txt";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const PASTED_RE = /(^|[\\/])\d+-(\d+-)?texto-pegado\.txt$/i;

export function countLines(text: string): number {
  if (!text) return 0;
  return text.replace(/\r?\n$/, "").split(/\r?\n/).length;
}

export function isLongPaste(text: string): boolean {
  return text.length > PASTE_LIMIT.chars || countLines(text) > PASTE_LIMIT.lines;
}

/** Qué es un adjunto, solo por su ruta (al leerlo de un mensaje ya enviado). */
export function kindOf(path: string): AttKind {
  const p = path.trim();
  if (IMAGE_EXT.test(p)) return "image";
  if (PASTED_RE.test(p)) return "text";
  if (/[\\/]$/.test(p)) return "dir";
  return "file";
}

/** Nombre a mostrar: sin carpeta y sin la marca de hora que pone Prometeo al guardarlo. */
export function displayName(path: string): string {
  const base = path.trim().replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
  if (PASTED_RE.test(path)) return "Texto pegado";
  return /[\\/]\.lienzo[\\/]adjuntos[\\/]/i.test(path) ? base.replace(/^\d+-(\d+-)?/, "") : base;
}

/** La línea que se añade al mensaje para que el agente abra los adjuntos. */
export function attachmentLine(atts: Attachment[]): string {
  if (atts.length === 0) return "";
  const one = atts.length === 1;
  const paths = atts.map((a) => (a.kind === "dir" && !/[\\/]$/.test(a.path) ? `${a.path}\\` : a.path));
  const pasted = atts.some((a) => a.kind === "text");
  const hint = pasted
    ? `${one ? "es" : "incluyen"} texto que pegó el usuario: léelo entero antes de responder`
    : `ábre${one ? "lo" : "los"} con tu herramienta de leer archivos`;
  return `📎 ${one ? "Adjunto" : "Adjuntos"}: ${paths.join(" · ")} (${hint})`;
}

/** Separa la línea «📎 …» de un mensaje: el texto que escribiste y las rutas adjuntas. */
export function splitAttachments(text: string): { said: string; paths: string[] } {
  const m = /\s*📎[^:\n]*:\s*([^\n]*)/.exec(text);
  if (!m) return { said: text, paths: [] };
  const list = m[1].replace(/\s*\([^()]*\)\s*$/, "");
  const paths = list
    .split(" · ")
    .map((p) => p.trim())
    .filter(Boolean);
  return { said: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim(), paths };
}

/** «12 líneas · 3.4 kB», «812 B»… */
export function attachMeta(a: Pick<Attachment, "kind" | "size" | "lines">): string {
  const size =
    a.size < 1024 ? `${a.size} B` : a.size < 1024 * 1024 ? `${(a.size / 1024).toFixed(1)} kB` : `${(a.size / 1048576).toFixed(1)} MB`;
  if (a.kind === "dir") return "carpeta";
  if (a.kind === "text" && a.lines) return `${a.lines} ${a.lines === 1 ? "línea" : "líneas"} · ${size}`;
  return size;
}

/** Texto a base64 respetando los acentos (btoa solo acepta latin-1). */
export function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Las fotos del iPad pueden llegar en HEIC, que los agentes no saben leer. Safari sí las
 * decodifica: se pasan a JPG antes de guardarlas. Si no se puede, se devuelve el original.
 */
export async function heicToJpeg(file: File): Promise<File> {
  const heic = /^image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
  if (!heic || typeof createImageBitmap !== "function") return file;
  try {
    const bmp = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext("2d")?.drawImage(bmp, 0, 0);
    bmp.close();
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", 0.9));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.hei[cf]$/i, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}
