import assert from "node:assert/strict";
import { extOf, groupOf, kindLabel, parseCsv, prettyJson, viewKind } from "./lib/viewer.js";
import { chatHtml, chatMarkdown, fileSlug, longDate } from "./lib/exportChat.js";

let n = 0;
function test(name, fn) {
  fn();
  n++;
  console.log("ok -", name);
}

test("cada archivo con su vista", () => {
  assert.equal(viewKind("docs/Informe.PDF"), "pdf");
  assert.equal(viewKind("a/b/plan.docx"), "office");
  assert.equal(viewKind("ventas.xlsx"), "office");
  assert.equal(viewKind("x.pptx"), "office");
  assert.equal(viewKind("foto.JPG"), "image");
  assert.equal(viewKind("clip.mp4"), "video");
  assert.equal(viewKind("voz.mp3"), "audio");
  assert.equal(viewKind("index.html"), "html");
  assert.equal(viewKind("notas.md"), "md");
  assert.equal(viewKind("main.rs"), "text");
  assert.equal(viewKind("viejo.doc"), "other");
  assert.equal(viewKind(".gitignore"), "other");
  assert.equal(extOf("C:\\Users\\x\\Nueva carpeta\\a.tar.gz"), "gz");
  assert.equal(groupOf("a.pdf"), "docs");
  assert.equal(groupOf("a.png"), "media");
  assert.equal(groupOf("a.csv"), "datos");
  assert.equal(groupOf("a.html"), "web");
  assert.equal(kindLabel("a.docx"), "Word");
  assert.equal(kindLabel("a.xlsm"), "Excel");
  assert.equal(kindLabel("a.pptx"), "PowerPoint");
  assert.equal(kindLabel("a.pdf"), "PDF");
  assert.equal(kindLabel("a.doc"), "Word");
});

test("csv con comillas, separadores y saltos dentro", () => {
  assert.deepEqual(parseCsv('a,b,c\n1,"dos, tres","di ""hola"""\n'), [
    ["a", "b", "c"],
    ["1", "dos, tres", 'di "hola"'],
  ]);
  assert.deepEqual(parseCsv("x;y\r\n1;2"), [
    ["x", "y"],
    ["1", "2"],
  ]);
  assert.deepEqual(parseCsv('n\t"l1\nl2"'), [["n", "l1\nl2"]]);
  assert.equal(parseCsv("a\nb\nc\nd", 2).length, 2);
  assert.equal(prettyJson('{"a":1}'), '{\n  "a": 1\n}');
  assert.equal(prettyJson("no json"), "no json");
});

const ev = (seq, ts, agent, kind, text, extra = {}) => ({ seq, ts_ms: ts, agent, session_id: "", kind, text, files: [], ...extra });
const t0 = new Date(2026, 9, 22, 17, 2).getTime();
const rows = [
  { k: "day", key: "d", label: "Hoy" },
  { k: "user", key: "1", e: ev(1, t0, "tú", "message", "Arregla el **login**") },
  {
    k: "turn",
    key: "t2",
    agent: "claude",
    ts: t0 + 60_000,
    lastTs: t0 + 120_000,
    parts: [
      { k: "work", key: "w", events: [ev(2, t0, "claude", "tool", "Edit"), ev(3, t0, "claude", "tool", "Bash")] },
      { k: "text", key: "4", e: ev(4, t0, "claude", "message", "Hecho: <ya> funciona", { to: "opencode" }) },
      { k: "task", key: "5", e: ev(5, t0, "claude", "task", "#7 hecha"), task: { id: 7, op: "hecha", detail: "login arreglado" } },
    ],
  },
  { k: "sys", key: "6", e: ev(6, t0 + 3_600_000 * 24, "tú", "task", "📌 Despacho: #8 «tests»\nmás") },
];
const info = {
  title: "Arreglo del login",
  scope: "Chat del equipo",
  project: "C:/p",
  fromMs: t0,
  toMs: null,
  nowMs: t0 + 86_400_000,
  label: (a) => a.charAt(0).toUpperCase() + a.slice(1),
};

test("exportar a markdown", () => {
  const md = chatMarkdown(rows, info);
  assert.ok(md.startsWith("# Arreglo del login\n"));
  assert.ok(md.includes("> Chat del equipo · Proyecto: C:/p"));
  assert.ok(md.includes("sigue abierto"));
  assert.ok(md.includes("## Jueves, 22 de octubre de 2026"), md);
  assert.ok(md.includes("### 🧑 Tú · 17:02\n\nArregla el **login**"));
  assert.ok(md.includes("### Claude · 17:03\n\n*(a Opencode)*\n\nHecho: <ya> funciona"), md);
  assert.ok(md.includes("- ✅ Tarea #7 hecha: login arreglado"));
  assert.ok(!md.includes("Trabajó"), "las acciones van fuera por defecto");
  assert.ok(chatMarkdown(rows, info, true).includes("- ⚙️ Trabajó: 2 acciones"));
  assert.ok(md.includes("## Viernes, 23 de octubre de 2026"));
  assert.ok(md.includes("> 17:02 · 📌 Despacho: #8 «tests»\n"), "solo la primera línea de los avisos");
  assert.equal(longDate(t0), "jueves, 22 de octubre de 2026");
});

test("exportar a html, sin colar etiquetas", () => {
  const html = chatHtml(rows, info);
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes("<title>Arreglo del login</title>"));
  assert.ok(html.includes("Hecho: &lt;ya&gt; funciona"));
  assert.ok(!html.includes("<ya>"));
  assert.ok(html.includes('<article class="msg me">'));
  const custom = chatHtml(rows, info, (t) => `<div>MD:${t.length}</div>`);
  assert.ok(custom.includes("<div>MD:20</div>"));
  assert.equal(fileSlug("¿Arreglo el login? (v2)"), "arreglo-el-login-v2");
  assert.equal(fileSlug("¿?"), "chat");
});

console.log(`${n} pruebas de visor y exportación OK`);
