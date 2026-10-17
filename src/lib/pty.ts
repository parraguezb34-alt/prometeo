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

export const termSpawn = (cwd: string | null, cols: number, rows: number) =>
  invoke<SessionInfo>("term_spawn", { cwd, cols, rows });

export const termWrite = (id: string, data: string) =>
  invoke<void>("term_write", { id, data });

export const termResize = (id: string, cols: number, rows: number) =>
  invoke<void>("term_resize", { id, cols, rows });

export const termKill = (id: string) => invoke<void>("term_kill", { id });

export const termList = () => invoke<SessionInfo[]>("term_list");

export const termScrollback = (id: string) =>
  invoke<string>("term_scrollback", { id });
