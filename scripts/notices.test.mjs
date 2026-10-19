import assert from "node:assert/strict";
import { parseNotice, splitOrders } from "./lib/notices.js";

let n = 0;
function test(name, fn) {
  fn();
  n++;
  console.log("ok -", name);
}

test("aviso de revisión (texto real del hub)", () => {
  const t =
    "🔎 Revisa la entrega de #18 «utilidades/fecha.js — formatearFecha y diasEntre» de antigravity (tras la ronda 1 de correcciones): Se creó utilidades/fecha.test.js cubriendo formatearFecha. Todos los tests pasan. · Archivos: utilidades/fecha.js, utilidades/fecha.test.js · Evidencia: node utilidades/fecha.test.js OK: todos los tests de fecha pasaron. Decide con team_task_review: verdict ok, fix (con órdenes concretas) o take (la haces tú). Los cambios van debajo: no abras los archivos salvo que te falte algo.";
  const r = parseNotice(t);
  assert.equal(r.kind, "review");
  assert.equal(r.task, 18);
  assert.equal(r.title, "utilidades/fecha.js — formatearFecha y diasEntre");
  assert.equal(r.by, "antigravity");
  assert.equal(r.round, 1);
  assert.match(r.summary, /^Se creó .*pasan\.$/);
  assert.deepEqual(r.files, ["utilidades/fecha.js", "utilidades/fecha.test.js"]);
  assert.equal(r.evidence, "node utilidades/fecha.test.js OK: todos los tests de fecha pasaron");
});

test("primera entrega, sin archivos ni evidencia", () => {
  const r = parseNotice(
    "🔎 Revisa la entrega de #3 «x» de opencode: hecho · Archivos: — · Evidencia: sin evidencia. Decide con team_task_review: verdict ok.",
  );
  assert.equal(r.round, 0);
  assert.deepEqual(r.files, []);
  assert.equal(r.evidence, "");
});

test("recordatorio, encargo y corrección", () => {
  assert.deepEqual(
    parseNotice("🔎 Tienes 2 entrega(s) esperando tu revisión: #4 «a», #5 «b». Míralas con team_task_list y decide."),
    { kind: "remind", count: 2, tasks: "#4 «a», #5 «b»" },
  );
  assert.deepEqual(parseNotice("📝 Nueva tarea #9 «Login» del usuario: escribe su encargo con team_task_brief."), {
    kind: "brief",
    task: 9,
    title: "Login",
  });
  const f = parseNotice(
    "🔧 Corrige #18 «fecha» (ronda 2 de 2): 1. Añade el test. 2. Ejecútalo. Es la última ronda: si no queda bien, la asumirá el líder. Al terminar, ciérrala otra vez con team_task_done (summary, files, evidence).",
  );
  assert.equal(f.kind, "fix");
  assert.equal(f.notes, "1. Añade el test. 2. Ejecútalo.");
  assert.equal(f.last, true);
  assert.equal(splitOrders(f.notes), "1. Añade el test.\n2. Ejecútalo.");
  assert.equal(
    splitOrders("1. añade diasEntre(a,b) === 2. 2. Ejecuta el test."),
    "1. añade diasEntre(a,b) === 2.\n2. Ejecuta el test.",
  );
});

test("un mensaje normal no es un aviso", () => {
  assert.equal(parseNotice("Hola, ¿cómo va #18?"), null);
});

console.log(`${n} pruebas de avisos OK`);
