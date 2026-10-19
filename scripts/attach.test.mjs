import assert from "node:assert/strict";
import { attachMeta, attachmentLine, countLines, displayName, isLongPaste, kindOf, splitAttachments, textToBase64 } from "./attach.js";

let n = 0;
function test(name, fn) {
  fn();
  n++;
  console.log("ok -", name);
}

const P = "C:\\Users\\parra\\Nueva carpeta\\.lienzo\\adjuntos\\";

test("un texto corto se pega en el cuadro; uno largo se adjunta", () => {
  assert.equal(isLongPaste("hola\nmundo"), false);
  assert.equal(isLongPaste("x".repeat(1501)), true);
  assert.equal(isLongPaste(Array(26).fill("l").join("\n")), true);
  assert.equal(countLines("a\nb\n"), 2);
  assert.equal(countLines(""), 0);
});

test("la línea 📎 se lee de vuelta con sus rutas, aunque lleven espacios", () => {
  const atts = [
    { kind: "image", path: `${P}captura.png`, name: "captura.png", size: 1 },
    { kind: "text", path: `${P}1700000000000-texto-pegado.txt`, name: "Texto pegado", size: 10, lines: 3 },
    { kind: "file", path: "C:\\x\\informe (v2).pdf", name: "informe (v2).pdf", size: 10 },
  ];
  const line = attachmentLine(atts);
  assert.match(line, /^📎 Adjuntos: /);
  assert.match(line, /léelo entero/);
  const { said, paths } = splitAttachments(`Revisa esto\n${line}`);
  assert.equal(said, "Revisa esto");
  assert.deepEqual(paths, atts.map((a) => a.path));
});

test("los mensajes viejos con «Captura adjunta» siguen funcionando", () => {
  const { said, paths } = splitAttachments("mira\n📎 Capturas adjuntas: C:\\a\\b.png · C:\\a\\c.png (ábrelas para verlas)");
  assert.equal(said, "mira");
  assert.deepEqual(paths, ["C:\\a\\b.png", "C:\\a\\c.png"]);
  assert.deepEqual(splitAttachments("sin adjuntos"), { said: "sin adjuntos", paths: [] });
});

test("cada adjunto se reconoce y se nombra por su ruta", () => {
  assert.equal(kindOf(`${P}1-texto-pegado.txt`), "text");
  assert.equal(kindOf(`${P}1-2-texto-pegado.txt`), "text");
  assert.equal(kindOf("src/main.rs"), "file");
  assert.equal(kindOf("C:\\x\\shot.PNG"), "image");
  assert.equal(kindOf("C:\\x\\carpeta\\"), "dir");
  assert.equal(displayName(`${P}1-texto-pegado.txt`), "Texto pegado");
  assert.equal(displayName(`${P}1700000000000-informe.pdf`), "informe.pdf");
  assert.equal(displayName("src/1700-notas.md"), "1700-notas.md");
  assert.equal(displayName("C:\\x\\carpeta\\"), "carpeta");
});

test("las carpetas viajan con barra final para reconocerlas", () => {
  const line = attachmentLine([{ kind: "dir", path: "C:\\x\\docs", name: "docs", size: 0 }]);
  assert.deepEqual(splitAttachments(line).paths, ["C:\\x\\docs\\"]);
  assert.match(line, /^📎 Adjunto: .*ábrelo/);
});

test("tamaños y acentos", () => {
  assert.equal(attachMeta({ kind: "text", size: 3500, lines: 12 }), "12 líneas · 3.4 kB");
  assert.equal(attachMeta({ kind: "file", size: 812 }), "812 B");
  assert.equal(Buffer.from(textToBase64("año ñ €"), "base64").toString("utf8"), "año ñ €");
});

console.log(`${n} pruebas de adjuntos OK`);
