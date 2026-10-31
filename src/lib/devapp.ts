import { invoke } from "./bridge";

// «App en vivo»: el proyecto arrancado (npm run dev, o sus .html servidos) para verlo en Prometeo.

export type AppDetect = { kind: "npm" | "static" | "none"; cmd: string; install: boolean };

export type AppStatus = {
  project: string;
  kind: string;
  cmd: string;
  running: boolean;
  url: string | null;
  log: string[];
  exit: number | null;
  started_ms: number;
};

export const appDetect = (path: string) => invoke<AppDetect>("app_detect", { path });
export const appStart = (path: string) => invoke<AppStatus>("app_start", { path });
export const appStop = () => invoke<void>("app_stop");
export const appStatus = () => invoke<AppStatus>("app_status");

/** Las últimas líneas de la consola, para pedir un arreglo al equipo. */
export function logTail(log: string[], n = 40): string {
  return log.slice(-n).join("\n").slice(-4000);
}

/** El mensaje para el equipo cuando la app no arranca. */
export function fixRequest(cmd: string, log: string[]): string {
  return [
    `La app del proyecto no arranca con «${cmd}». Esto dice la consola:`,
    "",
    "```",
    logTail(log),
    "```",
    "",
    `Arréglalo para que «${cmd}» arranque sin errores y comprueba que la página carga.`,
  ].join("\n");
}
