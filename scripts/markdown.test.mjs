import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./components/Markdown.js";

let n = 0;
function test(name, fn) {
  fn();
  n++;
  console.log("ok -", name);
}
const html = (text, onPath = () => {}) => renderToStaticMarkup(createElement(Markdown, { text, onPath }));
const count = (s, re) => (s.match(re) ?? []).length;

// Tal cual lo escribió Antigravity en una prueba real.
const REAL =
  "Hecho:\n\n1. **Pruebas**: Se creó [`utilidades/fecha.test.js`](file:///C:/Users/x/Nueva%20carpeta/utilidades/fecha.test.js), validando:\n   - [`formatearFecha`](file:///C:/x/fecha.js#L11-L16) con un dígito.\n   - [`diasEntre`](file:///C:/x/fecha.js#L26-L31) invertido.\n2. **Ejecución**:\n   ```bash\n   node utilidades/fecha.test.js\n   ```\n   **Salida**:\n   ```\n   OK: todos pasaron\n   ```\n3. **Entrega**: cerrada con `team_task_done`.";

test("listas anidadas: las sub-viñetas no se convierten en ítems numerados", () => {
  const h = html(REAL);
  assert.equal(count(h, /<ol/g), 1);
  assert.equal(count(h, /<ul/g), 1);
  assert.equal(count(h, /<li/g), 5);
  assert.match(h, /<ol[^>]*>.*<ul[^>]*>.*<\/ul>.*<\/ol>/s);
});

test("los bloques de código dentro de una lista se pintan como código, sin sangría", () => {
  const h = html(REAL);
  assert.equal(count(h, /<pre>/g), 2);
  assert.match(h, /<code>node utilidades\/fecha\.test\.js<\/code>/);
  assert.doesNotMatch(h, /```/);
  assert.match(h, /<span>bash<\/span>/);
});

test("enlaces a archivos: etiqueta sin comillas de código, ruta sin #L y líneas aparte", () => {
  let opened = "";
  const h = html(REAL, (p) => (opened = p));
  assert.doesNotMatch(h, /`/);
  assert.match(h, /title="Abrir C:\/x\/fecha\.js \(líneas 11-16\)"/);
  assert.match(h, />formatearFecha<span class="md-path-lines">:11-16<\/span>/);
  assert.match(h, /Abrir C:\/Users\/x\/Nueva carpeta\/utilidades\/fecha\.test\.js"/);
  assert.equal(opened, "");
});

test("una lista suelta sigue igual", () => {
  const h = html("- uno\n- dos\n\n- tres");
  assert.equal(count(h, /<ul/g), 1);
  assert.equal(count(h, /<li>/g), 3);
});

test("listas numeradas que no empiezan en 1", () => {
  assert.match(html("3. tres\n4. cuatro"), /<ol class="md-list" start="3">/);
});

test("tablas", () => {
  const h = html("| Tarea | Coste |\n|---|---:|\n| #1 | $0.13 |\n| #2 | $0.15 |");
  assert.equal(count(h, /<tr>/g), 3);
  assert.match(h, /<th style="text-align:right">Coste<\/th>/);
});

test("párrafos, títulos, citas y separadores", () => {
  const h = html("## Plan\nLínea uno\nlínea dos\n\n> nota\n\n---\n\nFin ~~viejo~~");
  assert.match(h, /class="md-h" data-level="2">Plan/);
  assert.match(h, /Línea uno<br\/>línea dos/);
  assert.match(h, /<blockquote/);
  assert.match(h, /<hr/);
  assert.match(h, /<s>viejo<\/s>/);
});

test("escapes de markdown", () => {
  assert.match(html("mi\\_archivo y \\*nada\\*"), /mi_archivo y \*nada\*/);
  assert.match(html("`a\\_b` y **x\\*y**"), /<code class="md-code">a\\_b<\/code> y <strong>x\*y<\/strong>/);
});

console.log(`${n} pruebas de markdown OK`);
