import { invoke } from "@tauri-apps/api/core";

// Qué vista toca a cada archivo en la pestaña App, y las llamadas al backend para leerlo.
// Lógica pura (salvo las llamadas) para poder probarla.

export type ViewKind =
  | "html"
  | "svg"
  | "md"
  | "csv"
  | "json"
  | "pdf"
  | "image"
  | "video"
  | "audio"
  | "office"
  | "text"
  | "other";

const KIND: Record<string, ViewKind> = {
  html: "html",
  htm: "html",
  svg: "svg",
  md: "md",
  markdown: "md",
  csv: "csv",
  tsv: "csv",
  json: "json",
  pdf: "pdf",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  ico: "image",
  avif: "image",
  mp4: "video",
  m4v: "video",
  webm: "video",
  mov: "video",
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  oga: "audio",
  m4a: "audio",
  flac: "audio",
  docx: "office",
  docm: "office",
  dotx: "office",
  xlsx: "office",
  xlsm: "office",
  pptx: "office",
  pptm: "office",
};

/** Texto que se lee tal cual (código, notas, registros…). */
const TEXT = new Set(
  "txt log ini cfg conf toml yaml yml xml env gitignore ts tsx js jsx mjs cjs py rs go java kt c h cpp hpp cs rb php sh ps1 bat cmd sql css scss vue svelte lua r dart swift".split(
    " ",
  ),
);

export function extOf(path: string): string {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const i = name.lastIndexOf(".");
  return i <= 0 ? "" : name.slice(i + 1).toLowerCase();
}

export function viewKind(path: string): ViewKind {
  const e = extOf(path);
  return KIND[e] ?? (TEXT.has(e) ? "text" : "other");
}

/** Lo que sale en la lista de recientes de la pestaña (lo que se puede ver bien aquí). */
export const LIST_EXTS = [
  ...Object.keys(KIND),
  "txt",
  "log",
];

/** Los grupos del filtro de la lista. */
export type Group = "todo" | "docs" | "web" | "media" | "datos";
export function groupOf(path: string): Exclude<Group, "todo"> {
  const k = viewKind(path);
  if (k === "pdf" || k === "office" || k === "md" || k === "text") return "docs";
  if (k === "image" || k === "video" || k === "audio") return "media";
  if (k === "csv" || k === "json") return "datos";
  return "web";
}

/** «Word», «Excel», «PDF»… para la barra. */
export function kindLabel(path: string): string {
  const e = extOf(path);
  if (e.startsWith("doc") || e === "dotx") return "Word";
  if (e.startsWith("xls")) return "Excel";
  if (e.startsWith("ppt")) return "PowerPoint";
  const k = viewKind(path);
  return (
    {
      html: "Página web",
      svg: "SVG",
      md: "Markdown",
      csv: "Tabla",
      json: "JSON",
      pdf: "PDF",
      image: "Imagen",
      video: "Vídeo",
      audio: "Audio",
      office: "Office",
      text: "Texto",
      other: e ? e.toUpperCase() : "Archivo",
    } as const
  )[k];
}

/** Etiqueta corta para la lista («MD», «PDF», «DOCX»…): la larga va en la barra del archivo. */
export function shortTag(path: string): string {
  const e = extOf(path);
  if (e === "markdown") return "MD";
  if (e === "htm") return "HTML";
  if (e === "jpeg") return "JPG";
  return (e || "?").slice(0, 4).toUpperCase();
}

/** Un CSV (o TSV) a filas: comillas dobles, comas dentro de comillas y saltos de línea en celdas. */
export function parseCsv(text: string, maxRows = 2000): string[][] {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const sep = first.includes("\t") ? "\t" : first.split(";").length > first.split(",").length ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
      if (rows.length >= maxRows) return rows;
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** JSON con sangría (o el texto tal cual si no es JSON válido). */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export type Blob64 = { mime: string; data: string; size: number; mtime_ms: number };

export const fileBlob = (project: string | null, rel: string) => invoke<Blob64>("file_blob", { project, rel });
export const fileOffice = (project: string | null, rel: string) => invoke<string>("file_office", { project, rel });
export const fileOpenExternal = (project: string | null, rel: string) =>
  invoke<void>("file_open_external", { project, rel });
export const fileReveal = (project: string | null, rel: string) => invoke<void>("file_reveal", { project, rel });

/** Del base64 del backend a una URL `blob:` que el visor del navegador sabe pintar (PDF, vídeo…). */
export function blobUrl(b: Blob64): string {
  const bin = atob(b.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: b.mime }));
}

export type TextData = { text: string; truncated: boolean; binary: boolean; size: number; mtime_ms: number };
export const fileText = (project: string | null, rel: string) => invoke<TextData>("file_text", { project, rel });

/** Guarda un chat exportado donde se eligió en el diálogo. */
export const exportSave = (path: string, text: string) => invoke<void>("export_save", { path, text });
