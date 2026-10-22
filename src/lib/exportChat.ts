import type { Part, Row } from "./timeline";

// Exportar un chat a Markdown o a una página HTML que se abre en cualquier navegador.
// Lógica pura: recibe la conversación ya en turnos (buildTimeline) y devuelve el texto.

export type ExportInfo = {
  title: string;
  /** «Chat del equipo» o «Chat privado con Claude». */
  scope: string;
  project: string;
  fromMs: number;
  toMs: number | null;
  nowMs: number;
  /** Nombre visible de un agente («claude» → «Claude»). */
  label: (agent: string) => string;
};

const pad = (n: number) => String(n).padStart(2, "0");
export const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const DAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

/** «miércoles, 22 de octubre de 2026» (fija: el archivo se lee otro día). */
export function longDate(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]}, ${d.getDate()} de ${MONTHS[d.getMonth()]} de ${d.getFullYear()}`;
}

const stamp = (ms: number) => `${longDate(ms)}, ${hhmm(ms)}`;

/** Nombre de archivo a partir del título («¿Arreglo el login?» → «arreglo-el-login»). */
export function fileSlug(title: string): string {
  const s = title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return s || "chat";
}

/** Un bloque de la conversación, igual para los dos formatos. */
type Block =
  | { k: "day"; label: string }
  | { k: "msg"; who: string; mine: boolean; ts: number; texts: string[]; items: string[] }
  | { k: "sys"; ts: number; text: string };

const TASK_ICON: Record<string, string> = {
  creada: "🆕",
  tomada: "▶️",
  liberada: "↩️",
  hecha: "✅",
  entregada: "📤",
  aprobada: "👍",
  borrada: "🗑️",
};

function partItem(p: Part): string | null {
  switch (p.k) {
    case "task":
      return `${TASK_ICON[p.task.op] ?? "•"} Tarea #${p.task.id} ${p.task.op}${p.task.detail ? `: ${p.task.detail}` : ""}`;
    case "work":
      return `⚙️ Trabajó: ${p.events.length} ${p.events.length === 1 ? "acción" : "acciones"}`;
    case "ask":
      return `❓ Pidió en su terminal: ${p.e.text}`;
    case "images":
      return `🖼️ ${p.paths.length === 1 ? "Imagen" : "Imágenes"}: ${p.paths.join(", ")}`;
    case "note":
      return `📝 ${p.e.text}`;
    default:
      return null;
  }
}

export function blocks(rows: Row[], info: ExportInfo, withWork: boolean): Block[] {
  const out: Block[] = [];
  let day = "";
  const dayOf = (ts: number) => {
    const d = longDate(ts);
    if (d !== day) {
      day = d;
      out.push({ k: "day", label: d.charAt(0).toUpperCase() + d.slice(1) });
    }
  };
  for (const r of rows) {
    if (r.k === "day") continue;
    if (r.k === "user") {
      dayOf(r.e.ts_ms);
      out.push({ k: "msg", who: "Tú", mine: true, ts: r.e.ts_ms, texts: [r.e.text], items: [] });
    } else if (r.k === "turn") {
      dayOf(r.ts);
      const texts: string[] = [];
      const items: string[] = [];
      for (const p of r.parts) {
        if (p.k === "text") {
          const to = p.e.kind === "broadcast" ? " (a todo el equipo)" : p.e.to && p.e.to !== "tú" ? ` (a ${info.label(p.e.to)})` : "";
          texts.push(to ? `*${to.trim()}*\n\n${p.e.text}` : p.e.text);
        } else if (p.k !== "work" || withWork) {
          const it = partItem(p);
          if (it) items.push(it);
        }
      }
      if (texts.length || items.length) out.push({ k: "msg", who: info.label(r.agent), mine: false, ts: r.ts, texts, items });
    } else {
      dayOf(r.e.ts_ms);
      out.push({ k: "sys", ts: r.e.ts_ms, text: r.e.text });
    }
  }
  return out;
}

const firstLine = (s: string) => s.split(/\r?\n/)[0];

export function chatMarkdown(rows: Row[], info: ExportInfo, withWork = false): string {
  const span = `${stamp(info.fromMs)} → ${info.toMs ? stamp(info.toMs) : "sigue abierto"}`;
  const lines = [
    `# ${info.title}`,
    "",
    `> ${info.scope} · Proyecto: ${info.project}`,
    `> ${span}`,
    `> Exportado desde Prometeo el ${stamp(info.nowMs)}`,
    "",
  ];
  for (const b of blocks(rows, info, withWork)) {
    if (b.k === "day") lines.push("---", "", `## ${b.label}`, "");
    else if (b.k === "sys") lines.push(`> ${hhmm(b.ts)} · ${firstLine(b.text)}`, "");
    else {
      lines.push(`### ${b.mine ? "🧑 " : ""}${b.who} · ${hhmm(b.ts)}`, "");
      for (const t of b.texts) lines.push(t.trim(), "");
      for (const it of b.items) lines.push(`- ${it.replace(/\r?\n/g, " ")}`);
      if (b.items.length) lines.push("");
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Página HTML con todo dentro (sin nada que cargar de fuera). `md` pasa el texto de un mensaje a
 * HTML (en la app, el mismo Markdown del chat); sin él, va como texto.
 */
export function chatHtml(rows: Row[], info: ExportInfo, md?: (text: string) => string, withWork = false): string {
  const toHtml = md ?? ((t: string) => `<p>${escHtml(t).replace(/\n/g, "<br>")}</p>`);
  const body: string[] = [];
  for (const b of blocks(rows, info, withWork)) {
    if (b.k === "day") body.push(`<h2 class="day">${escHtml(b.label)}</h2>`);
    else if (b.k === "sys") body.push(`<p class="sys"><time>${hhmm(b.ts)}</time> ${escHtml(firstLine(b.text))}</p>`);
    else {
      body.push(
        `<article class="msg${b.mine ? " me" : ""}"><header><b>${escHtml(b.who)}</b><time>${hhmm(b.ts)}</time></header>` +
          b.texts.map((t) => `<div class="txt">${toHtml(t)}</div>`).join("") +
          (b.items.length ? `<ul>${b.items.map((i) => `<li>${escHtml(i)}</li>`).join("")}</ul>` : "") +
          `</article>`,
      );
    }
  }
  const span = `${stamp(info.fromMs)} → ${info.toMs ? stamp(info.toMs) : "sigue abierto"}`;
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(info.title)}</title>
<style>
:root{--bg:#fafaf9;--card:#fff;--me:#eef2ff;--fg:#1c1917;--muted:#78716c;--line:#e7e5e4;--accent:#c2410c}
@media (prefers-color-scheme:dark){:root{--bg:#161618;--card:#1f1f22;--me:#24243a;--fg:#f5f5f4;--muted:#a8a29e;--line:#34343a;--accent:#fb923c;color-scheme:dark}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 "Segoe UI",system-ui,sans-serif}
main{max-width:820px;margin:0 auto;padding:32px max(16px,env(safe-area-inset-left,0px)) 64px}
h1{font-size:1.7em;line-height:1.2;margin:0 0 6px;text-wrap:balance}
.meta{color:var(--muted);font-size:13px;margin:0 0 24px}
.day{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);border-top:1px solid var(--line);padding-top:18px;margin:28px 0 12px}
.msg{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin:10px 0}
.msg.me{background:var(--me)}
.msg header{display:flex;gap:10px;align-items:baseline;margin-bottom:4px}
.msg header b{color:var(--accent)}
.msg.me header b{color:inherit}
time{color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
.txt p{margin:.4em 0}
.txt pre{overflow:auto;background:var(--bg);padding:10px;border-radius:8px;font-size:13px}
.txt code{font-family:Consolas,"Cascadia Mono",monospace;font-size:.92em}
.txt table{border-collapse:collapse}.txt td,.txt th{border:1px solid var(--line);padding:3px 8px}
.msg ul{margin:6px 0 0;padding-left:20px;color:var(--muted);font-size:13.5px}
.sys{color:var(--muted);font-size:13px;margin:6px 4px}
img{max-width:100%}
</style></head><body><main>
<h1>${escHtml(info.title)}</h1>
<p class="meta">${escHtml(info.scope)} · Proyecto: ${escHtml(info.project)}<br>${escHtml(span)}<br>Exportado desde Prometeo el ${escHtml(stamp(info.nowMs))}</p>
${body.join("\n")}
</main></body></html>
`;
}
