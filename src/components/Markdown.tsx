import { openUrl } from "@tauri-apps/plugin-opener";
import type { ReactNode } from "react";

/**
 * Markdown ligero para los mensajes de los agentes: párrafos, listas, citas,
 * títulos, bloques de código y, en línea, `código`, **negrita**, *cursiva*,
 * enlaces y rutas de archivo (que se abren en el preview al pulsarlas).
 * Sin HTML crudo: todo se pinta como texto.
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
  ].join("|"),
  "g",
);

function inline(text: string, onPath: ((p: string) => void) | undefined, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const k = `${keyBase}-${i++}`;
    const [all, code, bold, link, url, path, em] = m;
    if (code) {
      const inner = code.slice(1, -1);
      // Una ruta entre comillas de código también se puede abrir.
      if (onPath && new RegExp(`^[^\\s]+\\.(?:${FILE_EXT})$`, "i").test(inner)) {
        out.push(
          <button key={k} className="md-path" onClick={() => onPath(inner)} title={`Abrir ${inner}`}>
            {inner}
          </button>,
        );
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
      const href = lm?.[2] ?? "";
      // Enlace a un archivo local («[juego3d](file:///C:/…)»): se abre como cualquier ruta.
      if (href.startsWith("file:///") && onPath) {
        const local = decodeURI(href.slice("file:///".length));
        out.push(
          <button key={k} className="md-path" onClick={() => onPath(local)} title={local}>
            {lm?.[1] ?? local}
          </button>,
        );
        last = at + all.length;
        continue;
      }
      out.push(
        <a key={k} className="md-link" href={href} onClick={(ev) => openLink(ev, href)}>
          {lm?.[1] ?? link}
        </a>,
      );
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
      out.push(
        onPath ? (
          <button key={k} className="md-path" onClick={() => onPath(path)} title={`Abrir ${path}`}>
            {path}
          </button>
        ) : (
          <code key={k} className="md-code">
            {path}
          </code>
        ),
      );
    } else if (em) {
      out.push(<em key={k}>{em.slice(1, -1)}</em>);
    } else {
      out.push(all);
    }
    last = at + all.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function openLink(ev: { preventDefault: () => void }, href: string) {
  ev.preventDefault();
  openUrl(href).catch(() => {});
}

/** Líneas de un párrafo con sus saltos de línea. */
function lines(text: string, onPath: ((p: string) => void) | undefined, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  text.split("\n").forEach((l, i) => {
    if (i > 0) out.push(<br key={`${key}-br${i}`} />);
    out.push(...inline(l, onPath, `${key}-${i}`));
  });
  return out;
}

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

export function Markdown({ text, onPath }: { text: string; onPath?: (p: string) => void }) {
  const blocks: ReactNode[] = [];
  const src = text.replace(/\r\n/g, "\n").trim();
  const all = src.split("\n");
  let i = 0;
  let n = 0;
  while (i < all.length) {
    const line = all[i];
    const key = `b${n++}`;
    // Bloque de código.
    const fence = /^\s*```(\w*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < all.length && !/^\s*```/.test(all[i])) body.push(all[i++]);
      i++;
      blocks.push(
        <pre key={key} className="md-pre" data-lang={fence[1] || undefined}>
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^\s*(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push(
        <div key={key} className="md-h" data-level={h[1].length}>
          {inline(h[2], onPath, key)}
        </div>,
      );
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < all.length && /^\s*>/.test(all[i])) body.push(all[i++].replace(/^\s*>\s?/, ""));
      blocks.push(
        <blockquote key={key} className="md-quote">
          {lines(body.join("\n"), onPath, key)}
        </blockquote>,
      );
      continue;
    }
    if (BULLET.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < all.length && (BULLET.test(all[i]) || (/^\s{2,}\S/.test(all[i]) && items.length > 0))) {
        if (BULLET.test(all[i])) items.push(all[i].replace(BULLET, ""));
        else items[items.length - 1] += `\n${all[i].trim()}`;
        i++;
      }
      const Tag = ordered ? "ol" : "ul";
      blocks.push(
        <Tag key={key} className="md-list">
          {items.map((it, j) => (
            <li key={j}>{lines(it, onPath, `${key}-${j}`)}</li>
          ))}
        </Tag>,
      );
      continue;
    }
    const para: string[] = [];
    while (
      i < all.length &&
      all[i].trim() &&
      !/^\s*```/.test(all[i]) &&
      !/^\s*#{1,4}\s/.test(all[i]) &&
      !/^\s*>/.test(all[i]) &&
      !BULLET.test(all[i])
    ) {
      para.push(all[i++]);
    }
    blocks.push(
      <p key={key} className="md-p">
        {lines(para.join("\n"), onPath, key)}
      </p>,
    );
  }
  return <div className="md">{blocks}</div>;
}
