// Preguntas que un agente hace en su terminal (permisos, confirmaciones) leídas de su pantalla,
// para contestarlas desde el chat con botones. Cada opción lleva las teclas que la eligen.

export type PromptOption = { label: string; keys: string; tone?: "yes" | "always" | "no" };
export type TermPrompt = { title: string; detail: string[]; options: PromptOption[]; key: string };

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";

function tone(label: string): PromptOption["tone"] {
  const l = label.toLowerCase();
  if (/^(no\b|reject|deny|cancel|rechaz)/.test(l)) return "no";
  if (/\b(always|siempre|all|session|todos)\b|don.t ask again/.test(l)) return "always";
  if (/^(yes|allow|s[ií]\b|ok|proceed|approve|accept|continu)/.test(l)) return "yes";
  return undefined;
}

/** «Allow once» → «Permitir una vez»: las opciones típicas, en castellano. */
export function labelEs(label: string): string {
  const l = label.trim();
  const map: [RegExp, string][] = [
    [/^allow once$/i, "Permitir una vez"],
    [/^always allow$/i, "Permitir siempre"],
    [/^reject$/i, "Rechazar"],
    [/^yes$/i, "Sí"],
    [/^no$/i, "No"],
    [/^yes, allow once$/i, "Sí, esta vez"],
    [/^yes, allow always/i, "Sí, siempre"],
    [/^yes, and don.t ask again (for|this)/i, "Sí, y no volver a preguntar"],
    [/^yes, allow all edits during this session/i, "Sí, todas las ediciones de esta sesión"],
    [/^no, and tell (claude|codex) what to do differently/i, "No, y explicar qué hacer"],
    [/^yes, proceed$/i, "Sí, adelante"],
    [/^yes, just this once$/i, "Sí, solo esta vez"],
    [/^no \(esc\)$/i, "No"],
  ];
  // Codex añade su atajo al final: «Yes, proceed (y)».
  const bare = l.replace(/\s*\((esc|shift\+tab|[a-z])\)\s*$/i, "");
  for (const [re, es] of map) if (re.test(l) || re.test(bare)) return es;
  return bare;
}

const clean = (s: string) => s.replace(/[│┃║|]/g, " ").replace(/\s+/g, " ").trim();

/**
 * OpenCode: «Permission required» con «Allow once  Always allow  Reject» en horizontal. Su selector
 * da la vuelta (← desde «Allow once» va a «Reject») y cada pregunta nueva empieza en «Allow once»,
 * así que las teclas se cuentan desde ahí. «Always allow» y «Reject» abren un segundo paso
 * (confirmar / escribir el motivo) que se acepta con otro Enter.
 */
function opencode(lines: string[]): TermPrompt | null {
  const at = lines.findIndex((l) => /permission required/i.test(l));
  if (at < 0) return opencodeAlways(lines);
  const optLine = lines.slice(at).findIndex((l) => /allow once/i.test(l) && /reject/i.test(l));
  if (optLine < 0) return null;
  const between = lines
    .slice(at + 1, at + optLine)
    .map(clean)
    .filter((l) => l && !/^patterns$/i.test(l));
  const options: PromptOption[] = [
    { label: labelEs("Allow once"), keys: "\r", tone: "yes" },
    { label: labelEs("Always allow"), keys: RIGHT + "\r\r", tone: "always" },
    { label: labelEs("Reject"), keys: LEFT + "\r\r", tone: "no" },
  ];
  const detail = between.map((l) => l.replace(/^[←→↳•\-*]\s*/, "")).slice(0, 4);
  return { title: "Pide permiso", detail, options, key: `oc|${detail.join("|")}` };
}

/** El segundo paso de OpenCode tras «Always allow»: «Confirm  Cancel» (empieza en «Confirm»). */
function opencodeAlways(lines: string[]): TermPrompt | null {
  const rows = lines.map(clean);
  const at = rows.findIndex((l) => /^\W*always allow$/i.test(l));
  if (at < 0) return null;
  const optLine = rows.slice(at).findIndex((l) => /^confirm\s+cancel\b/i.test(l));
  if (optLine < 0) return null;
  const detail = rows
    .slice(at + 1, at + optLine)
    .filter(Boolean)
    .map((l) => l.replace(/^[-•*]\s*/, ""))
    .slice(0, 4);
  return {
    title: "¿Permitir siempre?",
    detail,
    options: [
      { label: "Confirmar", keys: "\r", tone: "always" },
      { label: "Cancelar", keys: RIGHT + "\r", tone: "no" },
    ],
    key: `oca|${detail.join("|")}`,
  };
}

const QUESTION = /\?\s*$|permission|permiso|allow|proceed|confirm|approve/i;
/** Una pregunta de permiso clara («Would you like to run…?»), para buscarla lejos del menú. */
const ASK = /^(would you like|do you want|allow|permission|¿)|\?\s*$/i;

const NUM = /^\s*([❯›▸>●○◉]?)\s*(\d{1,2})[.)]\s+(.+?)\s*$/;

/**
 * Un menú numerado en vertical (Claude Code, Antigravity…): «❯ 1. Yes / 2. … / 3. No». Tiene que
 * estar al final de la pantalla, con la opción marcada y una pregunta encima; así no se confunde
 * con una lista normal de un mensaje.
 */
function numbered(lines: string[]): TermPrompt | null {
  const rows = lines.map(clean);
  let last = rows.length - 1;
  while (last >= 0 && !rows[last]) last--;
  // El menú debe estar entre las últimas líneas con texto (debajo puede haber una ayuda).
  for (let end = last; end >= Math.max(0, last - 6); end--) {
    const m = NUM.exec(rows[end]);
    if (!m) continue;
    const items: { n: number; label: string; marked: boolean }[] = [];
    let i = end;
    while (i >= 0) {
      const mm = NUM.exec(rows[i]);
      if (!mm) {
        // Una opción puede ocupar dos líneas: la de abajo sin número.
        if (rows[i] && items.length > 0 && i > 0 && NUM.test(rows[i - 1])) {
          i--;
          continue;
        }
        break;
      }
      // «○» es una opción sin marcar (radio vacío); las demás marcas señalan la elegida.
      items.unshift({ n: Number(mm[2]), label: mm[3], marked: !!mm[1] && mm[1] !== "○" });
      i--;
    }
    if (items.length < 2 || items[0].n !== 1 || items.some((it, k) => it.n !== k + 1)) return null;
    const cur = items.findIndex((it) => it.marked);
    if (cur < 0) return null;
    // La pregunta suele ir justo encima; Codex pone entre ella y el menú el comando (que puede
    // ocupar varias líneas), así que se busca más arriba si no está cerca.
    const near = rows.slice(Math.max(0, i - 6), i + 1).filter(Boolean);
    const far = rows.slice(Math.max(0, i - 24), i + 1).filter(Boolean);
    const qi = [...near].reverse().findIndex((l) => QUESTION.test(l));
    const fi = qi < 0 ? [...far].reverse().findIndex((l) => ASK.test(l)) : -1;
    if (qi < 0 && fi < 0) return null;
    const above = qi >= 0 ? near : far;
    const qIdx = above.length - 1 - (qi >= 0 ? qi : fi);
    const title = above[qIdx];
    // Lo que hay entre la pregunta y el menú (el comando de Codex) explica más que lo de encima.
    const below = above.slice(qIdx + 1).filter((l) => !/^(reason|motivo):?$/i.test(l));
    const detail = below.length > 0 ? below.slice(0, 4) : above.slice(Math.max(0, qIdx - 3), qIdx);
    const options = items.map((it, k) => {
      const d = k - cur;
      const move = d > 0 ? DOWN.repeat(d) : UP.repeat(-d);
      return { label: labelEs(it.label), keys: move + "\r", tone: tone(it.label) };
    });
    return { title, detail, options, key: `num|${title}|${items.map((it) => it.label).join("|")}` };
  }
  return null;
}

/** «… (y/n)» al final. */
function yesNo(lines: string[]): TermPrompt | null {
  const rows = lines.map(clean).filter(Boolean);
  const l = rows[rows.length - 1] ?? "";
  if (!/\((y\/n|s\/n|yes\/no)\)\s*:?\s*$/i.test(l)) return null;
  return {
    title: l.replace(/\s*\((y\/n|s\/n|yes\/no)\)\s*:?\s*$/i, ""),
    detail: rows.slice(-4, -1),
    options: [
      { label: "Sí", keys: "y\r", tone: "yes" },
      { label: "No", keys: "n\r", tone: "no" },
    ],
    key: `yn|${l}`,
  };
}

const MENU = /^\s*([❯›▸>●])?\s*(?:\d{1,2}[.)]\s+)?(.+?)\s*$/;
const flat = (s: string) => s.toLowerCase().replace(/\\/g, "/").replace(/\s+/g, "");

/**
 * «¿Confías en esta carpeta?» que Claude Code y Antigravity preguntan la primera vez que abren
 * una carpeta. Si la carpeta que nombra es `project` (la que elegiste en Prometeo), devuelve las
 * teclas que eligen «Sí, confío»; si no, null y la pregunta se queda para ti.
 */
export function detectTrust(lines: string[] | null, project: string | null): string | null {
  if (!lines || !project) return null;
  const rows = lines.map(clean).filter(Boolean);
  const text = rows.join(" ").toLowerCase();
  if (!/trust (this folder|the contents|the files)|one you trust|trust this (project|workspace)/.test(text)) return null;
  // La ruta puede venir partida en varias líneas: se compara sin espacios.
  const want = flat(project).replace(/\/+$/, "");
  if (!flat(rows.join("")).includes(want)) return null;
  // Las opciones: la marcada (❯ / > …) y la que dice que sí.
  const tail = rows.slice(-10);
  const opts: { label: string; marked: boolean }[] = [];
  tail.forEach((r) => {
    if (!/^\s*([❯›▸>●]\s*)?(\d{1,2}[.)]\s+)?(yes|no)\b/i.test(r)) return;
    const m = MENU.exec(r)!;
    opts.push({ label: m[2], marked: !!m[1] });
  });
  const cur = opts.findIndex((o) => o.marked);
  const yes = opts.findIndex((o) => /^yes\b/i.test(o.label) && !/\bno\b|exit/i.test(o.label));
  if (opts.length < 2 || cur < 0 || yes < 0) return null;
  const d = yes - cur;
  return (d > 0 ? DOWN.repeat(d) : UP.repeat(-d)) + "\r";
}

/** La pregunta que espera respuesta en la pantalla de un agente, si la hay. */
export function detectPrompt(lines: string[] | null): TermPrompt | null {
  if (!lines || lines.length === 0) return null;
  return opencode(lines) ?? numbered(lines) ?? yesNo(lines);
}
