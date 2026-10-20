import { invoke } from "@tauri-apps/api/core";

// Límites de uso de cada agente (sesión de 5 h, semana, mes). Claude los da exactos por su
// «status line»; OpenCode Go se estima con su gasto local; Antigravity se lee de su /usage.

export type LimitWindow = { key: string; label: string; used_pct: number; resets_at: number | null };
export type AgentLimits = { windows: LimitWindow[]; exact: boolean; note: string; ts_ms: number };

export type GoWindow = LimitWindow & { used_usd: number; cap_usd: number };
export type GoUsage = { active: boolean; windows: GoWindow[] };

export const opencodeGoUsage = () => invoke<GoUsage>("opencode_go_usage");

export const teamLimitsSet = (agent: string, windows: LimitWindow[], exact: boolean, note = "") =>
  invoke<void>("team_limits_set", { agent, windows, exact, note });

/** ok < 70 % · warn < 90 % · crit. */
export function level(pct: number): "ok" | "warn" | "crit" {
  return pct >= 90 ? "crit" : pct >= 70 ? "warn" : "ok";
}

/** «en 2 h 13 min», «en 3 días», «ya». */
export function fmtReset(at: number | null | undefined, now = Date.now()): string {
  if (!at) return "";
  const s = Math.round((at - now) / 1000);
  if (s <= 0) return "ya";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d >= 2) return `en ${d} días`;
  if (d === 1) return `en 1 día${h ? ` y ${h} h` : ""}`;
  if (h > 0) return `en ${h} h${m ? ` ${m} min` : ""}`;
  return `en ${Math.max(1, m)} min`;
}

/** La ventana más llena de un agente (la que marca cuánto le queda). */
export function worst(l: AgentLimits | undefined): LimitWindow | null {
  if (!l || l.windows.length === 0) return null;
  return l.windows.reduce((a, b) => (b.used_pct > a.used_pct ? b : a));
}

const clean = (s: string) =>
  s
    .replace(/[│┃║|╭╮╰╯─━═┌┐└┘├┤▕▏]/g, " ")
    .replace(/[█▓▒░■□▰▱⣿⣀]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** «resets in 3h 12m», «se restablece en 45 min», «reset 2d 4h» → ms desde ahora. */
function parseIn(text: string, now: number): number | null {
  const m = /(reset|restabl|renew|renuev|refresh)[^0-9]{0,24}((\d+\s*(d|days?|días?|h|hours?|horas?|m|min|mins|minutes?|minutos?)\s*){1,3})/i.exec(text);
  if (!m) return null;
  let ms = 0;
  for (const p of m[2].matchAll(/(\d+)\s*(d|days?|días?|h|hours?|horas?|m|min|mins|minutes?|minutos?)/gi)) {
    const n = Number(p[1]);
    const u = p[2].toLowerCase();
    ms += u.startsWith("d") ? n * 86400e3 : u.startsWith("h") ? n * 3600e3 : n * 60e3;
  }
  return ms > 0 ? now + ms : null;
}

/**
 * Lee el panel de `/usage` de un CLI (Antigravity) de su pantalla: cada línea con un «NN%» es
 * una ventana. Si dice «remaining/left/restante», el número es lo que queda.
 */
export function parseUsagePanel(lines: string[] | null, now = Date.now()): LimitWindow[] {
  if (!lines) return [];
  const rows = lines.map(clean).filter(Boolean);
  const out: LimitWindow[] = [];
  rows.forEach((row, i) => {
    const m = /(\d{1,3}(?:[.,]\d+)?)\s*%/.exec(row);
    if (!m) return;
    let pct = Number(m[1].replace(",", "."));
    if (!(pct >= 0 && pct <= 100)) return;
    if (/remaining|left|restante|disponible|available/i.test(row)) pct = 100 - pct;
    let label = row
      .slice(0, m.index)
      .replace(/(used|usado|remaining|left|restante|quota|cuota)\s*:?\s*$/i, "")
      .replace(/[:\-–·•]+\s*$/, "")
      .trim();
    if (!label) label = (rows[i - 1] ?? "").replace(/[:\-–·•]+\s*$/, "").trim();
    label = label.slice(0, 40) || `Límite ${out.length + 1}`;
    out.push({
      key: label.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24) || `w${out.length}`,
      label,
      used_pct: Math.round(pct * 10) / 10,
      // El reinicio suele ir en la misma línea o justo debajo.
      resets_at: parseIn(row, now) ?? parseIn(rows[i + 1] ?? "", now) ?? parseIn(rows[i - 1] ?? "", now),
    });
  });
  return out.slice(0, 6);
}
