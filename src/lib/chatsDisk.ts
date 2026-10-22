import { invoke } from "@tauri-apps/api/core";
import type { Chat } from "./chats";
import type { TeamEvent } from "./team";

// Los chats en disco (ver chatstore.rs) y el historial de un chat que ya salió del feed vivo.
// Lógica pura (salvo las llamadas) para poder probarla.

export const chatsRead = (project: string) => invoke<Chat[] | null>("chats_read", { project });
export const chatsWrite = (project: string, chats: Chat[]) => invoke<void>("chats_write", { project, chats });

/**
 * Junta la lista de la interfaz con la del disco sin perder ninguna: si un chat está en las dos,
 * vale la de la interfaz (es la que se acaba de tocar); los que solo están en disco se añaden.
 * Del más nuevo al más viejo, como la barra.
 */
export function mergeChats(mine: Chat[], disk: Chat[]): Chat[] {
  const byId = new Map<string, Chat>();
  for (const c of disk) if (c && typeof c.id === "string") byId.set(c.id, c);
  for (const c of mine) byId.set(c.id, c);
  return [...byId.values()].sort((a, b) => b.createdMs - a.createdMs);
}

/** ¿Hay algo en disco que la interfaz no tenga? (para no repintar en balde). */
export function sameChats(a: Chat[], b: Chat[]): boolean {
  return a.length === b.length && a.every((c, i) => JSON.stringify(c) === JSON.stringify(b[i]));
}

/**
 * Los eventos que se acaban de caer del feed vivo (estaban en `prev` y son más viejos que lo más
 * viejo de `next`) y que son del chat (desde `fromMs`): se guardan para que el chat no pierda su
 * principio mientras está abierto. Los feeds van del más nuevo al más viejo.
 */
export function droppedEvents(prev: TeamEvent[], next: TeamEvent[], fromMs: number): TeamEvent[] {
  if (prev.length === 0) return [];
  const oldest = next.length ? next[next.length - 1].seq : Number.MAX_SAFE_INTEGER;
  return prev.filter((e) => e.seq < oldest && e.ts_ms >= fromMs).reverse();
}

/** Lo viejo (del archivo) y lo vivo, del más viejo al más nuevo y sin repetir. */
export function withOlder(older: TeamEvent[], liveOldestFirst: TeamEvent[]): TeamEvent[] {
  if (older.length === 0) return liveOldestFirst;
  const first = liveOldestFirst[0]?.seq ?? Number.MAX_SAFE_INTEGER;
  const seen = new Set<number>();
  const before = older
    .filter((e) => e.seq < first && !seen.has(e.seq) && (seen.add(e.seq), true))
    .sort((a, b) => a.seq - b.seq);
  return [...before, ...liveOldestFirst];
}
