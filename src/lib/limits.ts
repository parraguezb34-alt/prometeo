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

/** Nombre para mostrar de una ventana: si no trae palabras (p. ej. «[ ]»), «Límite N». */
export function windowLabel(w: LimitWindow, i: number): string {
  return /[a-záéíóúñ]{2,}/i.test(w.label) ? w.label : `Límite ${i + 1}`;
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
const PCT = /(\d{1,3}(?:[.,]\d+)?)\s*%/;
const REMAIN = /remaining|left|restante|disponible|available|quota remaining|cuota restante/i;
const USED = /\bused\b|usado|consumed|consumido/i;
const hasWords = (s: string) => /[a-záéíóúñ]{2,}/i.test(s);
const tidy = (s: string) =>
  s
    .replace(/[[\]()]/g, " ")
    .replace(/(used|usado|remaining|left|restante|quota|cuota)\s*:?\s*$/i, "")
    .replace(/[:\-–·•]+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();

/** «GEMINI MODELS», «CLAUDE AND GPT MODELS»: el encabezado de un grupo de modelos (todo en mayúsculas). */
const isGroup = (s: string) => !PCT.test(s) && !/[a-z]/.test(s) && /[A-Z]{3,}.*\s[A-Z]{2,}/.test(s);
const groupName = (s: string) =>
  s
    .replace(/\b(MODELS?|MODELOS?)\b/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) => (w === "AND" || w === "Y" ? "y" : w.length <= 3 ? w : w[0] + w.slice(1).toLowerCase()))
    .join(" ");
/** «Weekly Limit» → «semana», «Five Hour Limit» → «5 h». */
const windowName = (s: string) =>
  /week|seman/i.test(s) ? "semana" : /five.?hour|5.?h|cinco/i.test(s) ? "5 h" : /month|mes/i.test(s) ? "mes" : /daily|day|día|diari/i.test(s) ? "día" : s;

export function parseUsagePanel(lines: string[] | null, now = Date.now()): LimitWindow[] {
  if (!lines) return [];
  const rows = lines.map(clean).filter(Boolean);
  // Si el panel habla de lo que queda (y no de lo usado), todos sus números son «lo que queda».
  const panelRemains = rows.some((r) => REMAIN.test(r)) && !rows.some((r) => USED.test(r));
  const out: LimitWindow[] = [];
  let group = "";
  rows.forEach((row, i) => {
    if (isGroup(row)) {
      group = groupName(row);
      return;
    }
    const m = PCT.exec(row);
    if (!m) return;
    let pct = Number(m[1].replace(",", "."));
    if (!(pct >= 0 && pct <= 100)) return;
    // El nombre va delante del número o, si ahí solo hay la barra, en la línea de arriba.
    let title = row.slice(0, m.index);
    let label = tidy(title);
    if (!hasWords(label)) {
      for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
        if (PCT.test(rows[j]) || isGroup(rows[j]) || /@|account|cuenta/i.test(rows[j])) break;
        if (hasWords(rows[j]) && !/reset|restabl|refresh|available|disponible/i.test(rows[j])) {
          title = rows[j];
          label = tidy(title);
          break;
        }
      }
    }
    // «Weekly Limit Remaining»: lo dice su propio título (o la línea); si no, lo que diga el panel.
    const remains =
      REMAIN.test(row) || REMAIN.test(title) || (!USED.test(row) && !USED.test(title) && panelRemains);
    if (remains) pct = 100 - pct;
    if (!hasWords(label)) label = "";
    // Con grupos de modelos (Antigravity): «Gemini · semana».
    if (group) label = label ? `${group} · ${windowName(label)}` : group;
    label = label.slice(0, 40) || `Límite ${out.length + 1}`;
    let key = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || `w${out.length}`;
    // Claves únicas: dos ventanas con el mismo nombre no se pisan.
    if (out.some((o) => o.key === key)) key = `${key}-${out.length}`;
    out.push({
      key,
      label,
      used_pct: Math.round(pct * 10) / 10,
      // El reinicio suele ir en la misma línea o justo debajo.
      resets_at: parseIn(row, now) ?? parseIn(rows[i + 1] ?? "", now) ?? parseIn(rows[i - 1] ?? "", now),
    });
  });
  return out.slice(0, 6);
}
