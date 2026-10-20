import assert from "node:assert/strict";
import { bestFile, coverage, fileLabel, fileOrder, overall, phasesOf } from "./lib/research.js";

let n = 0;
function test(name, fn) {
  fn();
  n++;
  console.log("ok -", name);
}

const deep = {
  id: "x",
  question: "q",
  mode: "profunda",
  created_ms: 0,
  tasks: [10, 11, 12, 13, 14],
  roles: ["plan", "parte", "parte", "verificar", "informe"],
  agents: ["claude", "opencode", "antigravity", "opencode", "claude"],
  files: [],
};

test("fases: las partes en paralelo cuentan como una", () => {
  const ph = phasesOf(deep, [
    { id: 10, status: "done" },
    { id: 11, status: "done" },
    { id: 12, status: "claimed" },
    { id: 13, status: "open" },
    { id: 14, status: "open" },
  ]);
  assert.deepEqual(
    ph.map((p) => [p.label, p.state]),
    [
      ["Plan listo", "done"],
      ["Investigando 1/2", "now"],
      ["Verificando fuentes", "wait"],
      ["Escribiendo el informe", "wait"],
    ],
  );
  assert.equal(ph[1].who, "opencode, antigravity");
});

test("estado general: lista, en curso o parada (tareas borradas)", () => {
  const all = deep.tasks.map((id) => ({ id, status: "done" }));
  assert.equal(overall(deep, all), "lista");
  assert.equal(overall(deep, [{ id: 10, status: "claimed" }, ...all.slice(1)]), "en-curso");
  assert.equal(overall(deep, all.slice(0, 3)), "parada");
});

test("cobertura: tipos, URLs repetidas y la puerta de evidencia", () => {
  const md = [
    "## Fuentes",
    "[1] Documentación de SQLite — https://www.sqlite.org/whentouse.html — primaria — cuándo usarla",
    "[2] Blog comparativo — https://blog.example.com/sqlite-vs-duckdb — secundaria — rendimiento",
    "- [3] Hilo — https://reddit.com/r/x/1 — comunidad — experiencias",
    "4. Repetida — https://sqlite.org/whentouse.html/ — primaria",
    "Texto suelto con https://otra.com que no es una fuente",
  ].join("\n");
  const c = coverage(md);
  assert.equal(c.total, 3);
  assert.equal(c.byKind.primaria, 1);
  assert.equal(c.byKind.secundaria, 1);
  assert.equal(c.byKind.comunidad, 1);
  assert.equal(c.strong, 1);
  assert.equal(c.ok, true);
  const weak = coverage("[1] A — https://a.com — secundaria\n[2] B — https://b.com — comercial");
  assert.equal(weak.ok, false);
  assert.match(weak.why, /oficial o primaria/);
  assert.equal(coverage("").why, "Sin fuentes citadas.");
});

test("qué archivo mostrar y cómo se llama", () => {
  assert.equal(bestFile({ ...deep, files: [{ name: "plan.md" }, { name: "hallazgos-opencode.md" }] }), "plan.md");
  assert.equal(bestFile({ ...deep, files: [{ name: "plan.md" }, { name: "informe.md" }] }), "informe.md");
  assert.equal(bestFile({ ...deep, files: [] }), null);
  assert.equal(fileLabel("hallazgos-opencode.md"), "Hallazgos · opencode");
  assert.equal(fileLabel("verificacion.md"), "Verificación");
  assert.deepEqual(fileOrder(["informe.md", "verificacion.md", "plan.md", "hallazgos-b.md", "hallazgos-a.md"]), ["plan.md", "hallazgos-a.md", "hallazgos-b.md", "verificacion.md", "informe.md"]);
});

console.log(`${n} pruebas de investigación OK`);
