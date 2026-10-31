import { useEffect, useRef, useState } from "react";
import { isPrimary, remoteToken } from "./bridge";
import { onPtyData } from "./pty";
import { DIALOG, SUBMIT_CHECK_MS, bracketedAfter, cleanTerm, needsResubmit } from "./submit";
import { useVisibleInterval } from "./useVisibleInterval";

/**
 * Qué está haciendo cada agente ahora mismo, leído de su terminal. Al ponerse
 * a trabajar, todos los CLIs pintan un aviso para interrumpir (Claude Code y
 * Codex «esc to interrupt», Antigravity «esc to cancel», OpenCode «esc
 * interrupt») y animan un spinner. Algunos solo repintan el spinner y no el
 * aviso, así que la regla es: visto el aviso, el agente trabaja mientras su
 * terminal siga moviéndose; cuando la salida se para, terminó.
 */
export type Activity = {
  busy: boolean;
  /** Desde cuándo trabaja sin parar (ms), solo si busy. */
  since: number;
  /** Frase de estado del CLI («Pondering…», «Reading file...»), o "" si no hay. */
  status: string;
};

const TAIL = 3000;
/** Sin salida nueva en este tiempo, el spinner paró: ya no trabaja. */
const QUIET_MS = 4000;
const MARKER = /esc\W{0,3}(?:to\s+)?(?:interrupt|cancel)|again to interrupt/i;
/** Frase de estado: «Pondering…», «Reading file...», «Managing tasks...». */
const PHRASE = /[A-Z][A-Za-z']+(?: [a-z][A-Za-z']*){0,4}(?:…|\.\.\.)/g;

/** La última frase de estado entera que se pintó (los repintados dejan restos sueltos). */
function lastPhrase(tail: string): string {
  const found = [...cleanTerm(tail).matchAll(PHRASE)].map((m) => m[0]);
  return found.length > 0 ? found[found.length - 1].slice(0, 60) : "";
}

/** Última vez que cada terminal se vio trabajando (salida con el aviso de interrumpir puesto). */
const lastBusy = new Map<string, number>();

/** Cuándo se vio trabajando por última vez la terminal `sid` (ms epoch; 0 si nunca). */
export function termLastBusyMs(sid: string): number {
  return lastBusy.get(sid) ?? 0;
}

/** Lo último que pintó cada terminal (en crudo), para saber si un mensaje se quedó sin enviar. */
const lastTail = new Map<string, string>();

/** Terminales que pintaron un aviso de los que se cierran con Esc (ver `DIALOG`). */
const dialogOpen = new Set<string>();

/** Terminales cuyo programa encendió el pegado «bracketed» (ver `bracketedAfter`). */
const bracketed = new Set<string>();

/** ¿Acepta la terminal `sid` un pegado entre marcas? */
export function termBracketed(sid: string): boolean {
  return bracketed.has(sid);
}

/** Cuándo pintó algo cada terminal por última vez (ms epoch). */
const lastOut = new Map<string, number>();

/**
 * Espera a que la terminal `sid` deje de pintar (`quiet` ms sin salida): el CLI terminó de recibir
 * y mostrar lo tecleado. Codex trata lo que llega muy seguido como un pegado y un Enter dentro de
 * esa ráfaga no envía: medido con Codex 0.164 (26/10/2026), a 350 ms se queda en el cuadro y a
 * 700 ms ya envía. Por eso no vale un tiempo fijo corto. Sin vigilancia de terminales espera
 * `fallback`; nunca más de `max`.
 */
export async function waitQuiet(sid: string, o: { quiet?: number; min?: number; max?: number; fallback?: number } = {}) {
  const { quiet = 600, min = 800, max = 3000, fallback = 900 } = o;
  const start = Date.now();
  const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
  if (!lastOut.has(sid)) return sleep(fallback);
  for (;;) {
    const now = Date.now();
    if (now - start >= max) return;
    if (now - start >= min && now - (lastOut.get(sid) ?? 0) >= quiet) return;
    await sleep(40);
  }
}

/**
 * ¿Hay que cerrar un aviso antes de teclear en `sid`? Sí si pintó uno y el agente está libre (con
 * él trabajando, Esc lo interrumpiría). Se da por cerrado al decirlo: quien llama pulsa Esc.
 */
export function takeDialog(sid: string): boolean {
  if (!dialogOpen.has(sid) || Date.now() - termLastBusyMs(sid) < 4_000) return false;
  dialogOpen.delete(sid);
  return true;
}

/**
 * Tras teclear un mensaje con su Enter: si el agente estaba libre y no arranca, y el texto sigue en
 * su cuadro, se vuelve a pulsar Enter (una sola vez). `enter` escribe el Enter en esa terminal.
 */
export function watchSubmit(sid: string, text: string, enter: () => Promise<void>) {
  // Sin la vigilancia de las terminales (fuera de la app) no se puede saber: no se hace nada.
  if (!lastTail.has(sid)) return;
  const sentMs = Date.now();
  const busyBefore = sentMs - termLastBusyMs(sid) < 4_000;
  if (busyBefore) return;
  window.setTimeout(() => {
    const again = needsResubmit({ text, tail: lastTail.get(sid) ?? "", busyBefore, sentMs, lastBusyMs: termLastBusyMs(sid) });
    if (again) void enter().catch(() => {});
  }, SUBMIT_CHECK_MS);
}

type Track = { tail: string; lastMs: number; since: number; armed: boolean; busy: boolean; status: string };

/**
 * Actividad en vivo por sesión de terminal (id de la PTY). Escucha la salida de
 * todas las terminales y se reevalúa cada segundo.
 */
export function useTermActivity(): Map<string, Activity> {
  const tracks = useRef(new Map<string, Track>());
  const [snap, setSnap] = useState<Map<string, Activity>>(new Map());
  const sizeRef = useRef(0);

  useEffect(() => {
    // Fuera de la app de escritorio solo hay terminales que escuchar con el acceso remoto (iPad).
    if (!isPrimary() && !remoteToken()) return;
    const decoder = new TextDecoder();
    const un = onPtyData((bytes, sid) => {
      let text = "";
      try {
        text = decoder.decode(bytes);
      } catch {
        return;
      }
      const t = tracks.current.get(sid) ?? {
        tail: "",
        lastMs: 0,
        since: 0,
        armed: false,
        busy: false,
        status: "",
      };
      // El aviso puede llegar partido entre dos trozos: se mira con un poco de lo anterior.
      const seen = cleanTerm(t.tail.slice(-120) + text);
      if (MARKER.test(seen)) t.armed = true;
      if (DIALOG.test(seen)) dialogOpen.add(sid);
      if (text.includes("\x1b[?2004")) {
        if (bracketedAfter(bracketed.has(sid), text)) bracketed.add(sid);
        else bracketed.delete(sid);
      }
      t.tail = (t.tail + text).slice(-TAIL);
      t.lastMs = Date.now();
      if (t.armed) lastBusy.set(sid, t.lastMs);
      lastTail.set(sid, t.tail);
      lastOut.set(sid, t.lastMs);
      tracks.current.set(sid, t);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  const tick = () => {
    const now = Date.now();
    const next = new Map<string, Activity>();
    let changed = false;
    for (const [sid, t] of tracks.current) {
      if (now - t.lastMs > QUIET_MS) t.armed = false;
      const busy = t.armed;
      if (busy && !t.busy) t.since = now;
      const status = busy ? lastPhrase(t.tail) : "";
      if (busy !== t.busy || status !== t.status) changed = true;
      t.busy = busy;
      t.status = status;
      next.set(sid, { busy, since: t.since, status });
    }
    if (changed || next.size !== sizeRef.current) {
      sizeRef.current = next.size;
      setSnap(next);
    }
  };
  // Oculta no se pausa: el reparto y el buzón dependen de saber quién quedó libre.
  useVisibleInterval(tick, 1000, 5000);

  return snap;
}
