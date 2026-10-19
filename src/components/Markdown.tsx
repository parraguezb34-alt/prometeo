import { openUrl } from "@tauri-apps/plugin-opener";
import { memo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

/**
 * Markdown ligero para los mensajes de los agentes: párrafos, títulos, listas (también
 * anidadas y con bloques de código dentro), citas, tablas, separadores, bloques de código
 * y, en línea, `código`, **negrita**, *cursiva*, ~~tachado~~, enlaces y rutas de archivo
 * (que se abren en el preview al pulsarlas). Sin HTML crudo: todo se pinta como texto.
 */

const FILE_EXT =
  "js|mjs|cjs|ts|tsx|jsx|json|html?|css|scss|md|markdown|py|rs|toml|ya?ml|txt|png|jpe?g|gif|webp|svg|bat|cmd|ps1|sh|csv|glsl|wgsl|vue|svelte|go|java|kt|c|cpp|h";
const INLINE = new RegExp(
  [
    "(`[^`\\n]+`)", // 1 código
    "(\\*\\*[^*\\n]+\\*\\*)", // 2 negrita
    "(\\[[^\\]\\n]+\\]\\((?:https?:\\/\\/|file:\\/\\/\\/)[^)\\s]+\\))", // 3 enlace (web o archivo)
    '(https?:\\/\\/[^\\s)<>"]+[^\\s)<>".,;:!?])', // 4 url suelta
    `((?:[A-Za-z]:[\\\\/]|\\.{0,2}[\\\\/])?(?:[\\w@.-]+[\\\\/])*[\\w@-][\\w@.-]*\\.(?:${FILE_EXT})(?![\\w/\\\\]))`, // 5 ruta
    "((?:^|(?<=[\\s(]))\\*[^*\\s][^*\\n]*\\*(?=[\\s).,;:!?]|$))", // 6 cursiva
    "(~~[^~\\n]+~~)", // 7 tachado
  ].join("|"),
  "g",
);
const PATH_ONLY = new RegExp(`^[^\\s]+\\.(?:${FILE_EXT})(?::\\d+(?:-\\d+)?)?$`, "i");

type OnPath = ((p: string) => void) | undefined;

/** «fecha.js#L11-L16» → ruta «fecha.js» y líneas «11-16». */
function splitAnchor(p: string): { path: string; lines: string } {
  const m = /^(.*?)(?:#L(\d+)(?:-L?(\d+))?)$/.exec(p);
  if (!m) return { path: p, lines: "" };
  return { path: m[1], lines: m[3] ? `${m[2]}-${m[3]}` : m[2] };
}

function pathButton(key: string, path: string, label: ReactNode, onPath: OnPath, lines = "") {
  const title = `Abrir ${path}${lines ? ` (líneas ${lines})` : ""}`;
  if (!onPath) {
    return (
      <code key={key} className="md-code" title={title}>
        {label}
      </code>
    );
  }
  return (
    <button key={key} className="md-path" onClick={() => onPath(path)} title={title}>
      {label}
      {lines && <span className="md-path-lines">:{lines}</span>}
    </button>
  );
}

// Escapes de markdown («\_», «\*»): el carácter va tal cual y no cuenta como formato. Mientras
// se busca el formato se cambia por un carácter de uso privado, y se recupera al pintar.
const hideEscapes = (s: string) =>
  s.replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, (_, c: string) => String.fromCharCode(0xe000 + c.charCodeAt(0)));
const showEscapes = (s: string) => s.replace(/[-]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xe000));

function inline(text: string, onPath: OnPath, keyBase: string): ReactNode[] {
  return inlineRaw(hideEscapes(text), onPath, keyBase).map((n) => (typeof n === "string" ? showEscapes(n) : n));
}

function inlineRaw(text: string, onPath: OnPath, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const k = `${keyBase}-${i++}`;
    const [all, code, bold, link, url, path, em, strike] = m;
    if (code) {
      // Dentro del código las barras invertidas son literales.
      const inner = code.slice(1, -1).replace(/[-]/g, (c) => `\\${String.fromCharCode(c.charCodeAt(0) - 0xe000)}`);
      // Una ruta entre comillas de código también se puede abrir.
      if (onPath && PATH_ONLY.test(inner)) {
        const [p, ln] = inner.split(/:(?=\d)/);
        out.push(pathButton(k, p, p, onPath, ln ?? ""));
      } else {
        out.push(
          <code key={k} className="md-code">
            {inner}
          </code>,
        );
      }
    } else if (bold) {
      out.push(<strong key={k}>{inline(bold.slice(2, -2), onPath, k)}</strong>);
    } else if (link) {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(link);
      const label = lm?.[1] ?? link;
      const href = lm?.[2] ?? "";
      // Enlace a un archivo local («[`fecha.js`](file:///C:/…/fecha.js#L11-L16)»): se abre
      // como cualquier ruta y enseña la etiqueta sin las comillas de código.
      if (href.startsWith("file:///")) {
        const { path: local, lines } = splitAnchor(safeDecode(href.slice("file:///".length)));
        out.push(pathButton(k, local, label.replace(/^`(.*)`$/, "$1"), onPath, lines));
      } else {
        out.push(
          <a key={k} className="md-link" href={href} onClick={(ev) => openLink(ev, href)}>
            {inline(label, undefined, k)}
          </a>,
        );
      }
    } else if (url) {
      out.push(
        <a key={k} className="md-link" href={url} onClick={(ev) => openLink(ev, url)}>
          {url}
        </a>,
      );
    } else if (path && !/[\\/]/.test(path) && /^[A-Z]\w*\.js$/.test(path)) {
      // «Three.js», «Node.js»: nombres de librerías, no archivos.
      out.push(all);
    } else if (path) {
      out.push(pathButton(k, showEscapes(path), showEscapes(path), onPath));
    } else if (em) {
      out.push(<em key={k}>{inline(em.slice(1, -1), onPath, k)}</em>);
    } else if (strike) {
      out.push(<s key={k}>{showEscapes(strike.slice(2, -2))}</s>);
    } else {
      out.push(all);
    }
    last = at + all.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function safeDecode(s: string): string {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

function openLink(ev: { preventDefault: () => void }, href: string) {
  ev.preventDefault();
  openUrl(href).catch(() => {});
}

/** Líneas de un párrafo con sus saltos de línea. */
function lines(text: string, onPath: OnPath, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  text.split("\n").forEach((l, i) => {
    if (i > 0) out.push(<br key={`${key}-br${i}`} />);
    out.push(...inline(l.trim(), onPath, `${key}-${i}`));
  });
  return out;
}

// ---- bloques ---------------------------------------------------------------------------

const BULLET = /^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/;
const FENCE = /^(\s*)(```+|~~~+)\s*([\w+-]*)/;
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const HEADING = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const indentOf = (l: string) => (/^\s*/.exec(l)?.[0] ?? "").replace(/\t/g, "    ").length;

/** Quita `n` espacios de sangría a cada línea (sin pasar del texto). */
function dedent(ls: string[], n: number): string[] {
  return ls.map((l) => {
    let cut = 0;
    while (cut < n && cut < l.length && (l[cut] === " " || l[cut] === "\t")) cut++;
    return l.slice(cut);
  });
}

function isTableRow(l: string) {
  return /\|/.test(l) && l.trim().length > 1;
}

function cells(l: string): string[] {
  return l
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
}

/** ¿Empieza aquí otro tipo de bloque? (corta un párrafo) */
function startsBlock(all: string[], i: number): boolean {
  const l = all[i];
  return (
    FENCE.test(l) ||
    HEADING.test(l) ||
    /^\s*>/.test(l) ||
    BULLET.test(l) ||
    HR.test(l) ||
    (isTableRow(l) && i + 1 < all.length && TABLE_SEP.test(all[i + 1]))
  );
}

type Ctx = { onPath: OnPath; reveal: boolean };

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [done, setDone] = useState(false);
  const copy = () =>
    navigator.clipboard
      .writeText(code)
      .then(() => {
        setDone(true);
        window.setTimeout(() => setDone(false), 1400);
      })
      .catch(() => {});
  return (
    <div className="md-pre" data-bare={lang ? undefined : "1"}>
      <div className="md-pre-bar">
        {lang && <span>{lang}</span>}
        <button onClick={copy} data-done={done ? "1" : "0"}>
          {done ? "Copiado" : "Copiar"}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** Pinta una lista de líneas como bloques. `tight`: un párrafo suelto va sin <p> (ítems de lista). */
function blocks(all: string[], ctx: Ctx, keyBase: string, tight = false): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  let n = 0;
  const push = (node: ReactNode) => out.push(node);
  while (i < all.length) {
    const line = all[i];
    const key = `${keyBase}.${n++}`;

    const fence = FENCE.exec(line);
    if (fence) {
      const ind = fence[1].length;
      const mark = fence[2][0];
      const body: string[] = [];
      i++;
      while (i < all.length && !new RegExp(`^\\s*${mark === "`" ? "`" : "~"}{3,}\\s*$`).test(all[i])) body.push(all[i++]);
      i++;
      push(<CodeBlock key={key} code={dedent(body, ind).join("\n").replace(/\n+$/, "")} lang={fence[3]} />);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    if (HR.test(line)) {
      push(<hr key={key} className="md-hr" />);
      i++;
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      push(
        <div key={key} className="md-h" data-level={Math.min(h[1].length, 4)}>
          {inline(h[2], ctx.onPath, key)}
        </div>,
      );
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < all.length && /^\s*>/.test(all[i])) body.push(all[i++].replace(/^\s*>\s?/, ""));
      push(
        <blockquote key={key} className="md-quote">
          {blocks(body, ctx, key, true)}
        </blockquote>,
      );
      continue;
    }
    if (isTableRow(line) && i + 1 < all.length && TABLE_SEP.test(all[i + 1])) {
      const head = cells(line);
      const align = cells(all[i + 1]).map((c) =>
        c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : undefined,
      );
      i += 2;
      const rows: string[][] = [];
      while (i < all.length && isTableRow(all[i]) && all[i].trim()) rows.push(cells(all[i++]));
      push(
        <div key={key} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j} style={{ textAlign: align[j] }}>
                    {inline(c, ctx.onPath, `${key}h${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {head.map((_, j) => (
                    <td key={j} style={{ textAlign: align[j] }}>
                      {inline(r[j] ?? "", ctx.onPath, `${key}r${ri}c${j}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const b = BULLET.exec(line);
    if (b) {
      const ind = indentOf(line);
      const ordered = /\d/.test(b[2]);
      const start = ordered ? parseInt(b[2], 10) : 1;
      const items: string[][] = [];
      while (i < all.length) {
        const l = all[i];
        const m = BULLET.exec(l);
        if (m && indentOf(l) <= ind + 1 && /\d/.test(m[2]) === ordered) {
          // Un ítem: su primera línea y todo lo que cuelgue con más sangría (o líneas en blanco
          // seguidas de más sangría).
          const width = indentOf(l) + m[2].length + 1;
          const item = [m[3]];
          i++;
          while (i < all.length) {
            const c = all[i];
            if (!c.trim()) {
              let j = i;
              while (j < all.length && !all[j].trim()) j++;
              if (j < all.length && indentOf(all[j]) > ind) {
                while (i < j) item.push(all[i++]);
                continue;
              }
              break;
            }
            if (indentOf(c) > ind) {
              item.push(c);
              i++;
              continue;
            }
            // Continuación perezosa de un párrafo sin sangría (no empieza otro bloque).
            if (!startsBlock(all, i) && item.length === 1) {
              item.push(c);
              i++;
              continue;
            }
            break;
          }
          const rest = item.slice(1);
          const minInd = Math.min(width, ...rest.filter((r) => r.trim()).map(indentOf));
          items.push([item[0], ...dedent(rest, Number.isFinite(minInd) ? minInd : width)]);
          continue;
        }
        if (!l.trim()) {
          // Una línea en blanco entre ítems de la misma lista no la corta.
          let j = i;
          while (j < all.length && !all[j].trim()) j++;
          const nx = j < all.length ? BULLET.exec(all[j]) : null;
          if (nx && indentOf(all[j]) <= ind + 1 && /\d/.test(nx[2]) === ordered) {
            i = j;
            continue;
          }
        }
        break;
      }
      const Tag = ordered ? "ol" : "ul";
      push(
        <Tag key={key} className="md-list" start={ordered && start !== 1 ? start : undefined}>
          {items.map((it, j) => (
            <li key={j}>{blocks(it, { ...ctx, reveal: false }, `${key}-${j}`, true)}</li>
          ))}
        </Tag>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < all.length && all[i].trim() && (para.length === 0 || !startsBlock(all, i))) para.push(all[i++]);
    if (tight && out.length === 0 && (i >= all.length || !all.slice(i).some((l) => l.trim()))) {
      push(<span key={key}>{lines(para.join("\n"), ctx.onPath, key)}</span>);
    } else {
      push(
        <p key={key} className="md-p">
          {lines(para.join("\n"), ctx.onPath, key)}
        </p>,
      );
    }
  }
  return out;
}

function MarkdownView({
  text,
  onPath,
  reveal = false,
}: {
  text: string;
  onPath?: (p: string) => void;
  /** Mensaje recién llegado: los bloques aparecen uno tras otro, como si se escribieran. */
  reveal?: boolean;
}) {
  const src = text.replace(/\r\n/g, "\n").replace(/^\s*\n/, "").trimEnd();
  const out = blocks(src.split("\n"), { onPath, reveal }, "b");
  return (
    <div className="md" data-reveal={reveal ? "1" : undefined}>
      {reveal
        ? out.map((node, i) => (
            <div className="md-r" key={i} style={{ "--i": Math.min(i, 12) } as CSSProperties}>
              {node}
            </div>
          ))
        : out}
    </div>
  );
}

/**
 * El chat se repinta cada segundo (relojes, acuses): un mensaje solo se vuelve a analizar si
 * cambia su texto. `onPath` se ignora al comparar: hace lo mismo aunque sea otra función.
 */
export const Markdown = memo(MarkdownView, (a, b) => a.text === b.text && a.reveal === b.reveal);
