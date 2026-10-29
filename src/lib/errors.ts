import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// Registro de errores (Ajustes → Errores). Los de Rust se anotan allí mismo; los de la interfaz
// llegan por `reportError`. Todos se guardan en %APPDATA%/lienzo/errores.jsonl.

export type ErrEntry = { ts_ms: number; source: string; message: string; detail: string };

export const errorsList = () => invoke<ErrEntry[]>("errors_list");
export const errorsClear = () => invoke<void>("errors_clear");
export const errorsFile = () => invoke<string>("errors_file");

/** Nombre para mostrar de cada origen. */
export const SOURCE_ES: Record<string, string> = {
  interfaz: "Interfaz",
  accion: "Acción",
  hub: "Hub",
  historial: "Historial",
  app: "App en vivo",
  agente: "Agente",
  interno: "Interno",
};

// Avisos que no son fallos de verdad (los navegadores los lanzan solos).
const NOISE = [/ResizeObserver loop/i, /^Script error\.?$/i, /unregisterListener/];

const recent = new Map<string, number>();

/** Anota un error de la interfaz. Repetidos en menos de 10 s cuentan una vez. */
export function reportError(source: string, message: string, detail = ""): void {
  const msg = message.trim();
  if (!msg || NOISE.some((re) => re.test(msg))) return;
  const key = `${source}|${msg}`;
  const now = Date.now();
  if (now - (recent.get(key) ?? 0) < 10_000) return;
  recent.set(key, now);
  if (recent.size > 200) {
    for (const [k, t] of recent) {
      if (now - t > 10_000) recent.delete(k);
    }
    while (recent.size > 200) {
      const oldest = recent.keys().next().value;
      if (oldest !== undefined) recent.delete(oldest);
      else break;
    }
  }
  if (!("__TAURI_INTERNALS__" in window)) return;
  void invoke("errors_report", { source, message: msg, detail }).catch(() => {});
}

function describe(reason: unknown): { message: string; detail: string } {
  if (reason instanceof Error) return { message: reason.message || reason.name, detail: reason.stack ?? "" };
  if (typeof reason === "string") return { message: reason, detail: "" };
  try {
    return { message: JSON.stringify(reason), detail: "" };
  } catch {
    return { message: String(reason), detail: "" };
  }
}

let installed = false;

/** Recoge los fallos de la interfaz que nadie captura. */
export function installErrorCapture(): void {
  if (installed) return;
  installed = true;
  window.addEventListener("error", (e) => {
    const { message, detail } = e.error ? describe(e.error) : { message: e.message, detail: "" };
    const where = e.filename ? `${e.filename.replace(/^.*\/src\//, "src/")}:${e.lineno}` : "";
    reportError("interfaz", message, [where, detail].filter(Boolean).join("\n"));
  });
  window.addEventListener("unhandledrejection", (e) => {
    const { message, detail } = describe(e.reason);
    reportError("interfaz", message, detail);
  });
}

const SEEN_KEY = "lienzo.errors.seen";

function loadSeen(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

/** Marca los errores como vistos (al abrir Ajustes → Errores). */
export function markErrorsSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, String(Date.now()));
  } catch {
    /* sin almacenamiento: el punto volverá a salir */
  }
  window.dispatchEvent(new Event("lienzo-errors-seen"));
}

/** Cuántos errores hay sin ver (para el punto rojo de Ajustes). */
export function useUnseenErrors(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let live = true;
    const count = () =>
      errorsList()
        .then((all) => {
          const seen = loadSeen();
          if (live) setN(all.filter((e) => e.ts_ms > seen).length);
        })
        .catch(() => {});
    count();
    const un = listen("lienzo://error", () => count());
    const onSeen = () => setN(0);
    window.addEventListener("lienzo-errors-seen", onSeen);
    return () => {
      live = false;
      void un.then((f) => f()).catch(() => {});
      window.removeEventListener("lienzo-errors-seen", onSeen);
    };
  }, []);
  return n;
}
