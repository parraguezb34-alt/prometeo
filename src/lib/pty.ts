import { invoke } from "@tauri-apps/api/core";

export type SessionInfo = {
  id: string;
  title: string;
  running: boolean;
};

export type PtyDataEvent = { id: string; data: string };
export type PtyExitEvent = { id: string };

/** Decode base64 (came from the Rust PTY reader) into raw bytes for xterm. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export const termSpawn = (
  cwd: string | null,
  cols: number,
  rows: number,
  command: string | null = null,
) => invoke<SessionInfo>("term_spawn", { cwd, cols, rows, command });

export const termWrite = (id: string, data: string) =>
  invoke<void>("term_write", { id, data });

export const termResize = (id: string, cols: number, rows: number) =>
  invoke<void>("term_resize", { id, cols, rows });

export const termKill = (id: string) => invoke<void>("term_kill", { id });

export const termList = () => invoke<SessionInfo[]>("term_list");

export const termScrollback = (id: string) =>
  invoke<string>("term_scrollback", { id });

/** Las últimas líneas legibles de una terminal (sin colores ni cajas), para saber qué está pidiendo. */
export function tailText(b64: string, maxLines = 4): string {
  let text = "";
  try {
    text = new TextDecoder().decode(base64ToBytes(b64).slice(-6000));
  } catch {
    return "";
  }
  const clean = text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[()][A-Z0-9]/g, "")
    .replace(/\r/g, "\n");
  const lines = clean
    .split("\n")
    .map((l) => l.replace(/[\u2500-\u257f]+/g, "").trim())
    .filter((l) => l.length > 1);
  return lines.slice(-maxLines).join("\n");
}

/**
 * Si la terminal muestra un selector con una opción marcada (❯ …) que es claramente un «sí»,
 * devuelve su texto: solo entonces es seguro ofrecer «aceptar con Enter». Si la marcada es un
 * «no», «salir» o no se reconoce, devuelve null y la decisión es del usuario.
 */
export function confirmChoice(tail: string): string | null {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^[❯›▸>]\s*(?:\d+[.)]\s*)?(.+)$/.exec(lines[i].trim());
    if (!m) continue;
    const option = m[1].trim();
    if (/^(no\b|exit|cancel|deny|reject|salir|cancelar)/i.test(option)) return null;
    if (/^(yes|sí|si\b|allow|trust|use\b|continue|accept|proceed|ok\b)/i.test(option)) return option;
    return null;
  }
  return null;
}
