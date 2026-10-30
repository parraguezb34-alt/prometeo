import assert from "node:assert/strict";
import {
  askQueue, changeQuestionOther, chooseQuestionOption, emptyQuestionPicks,
  nextQuestionStep, questionAnswers, questionSummary,
} from "./lib/askDock.js";

let passed = 0;
function test(name, run) {
  run();
  passed++;
  console.log("ok -", name);
}

const question = (id, ts_ms, items, extra = {}) => ({
  id, ts_ms, agent: "claude", context: "", items,
  answers: null, dismissed: false, ...extra,
});
const item = (question, header, multi = false) => ({
  question, header, multi,
  options: [{ label: "Claro", description: "" }, { label: "Oscuro", description: "" }],
});
const prompt = { key: "permiso", title: "Pide permiso", detail: [], options: [{ label: "Sí", keys: "y" }] };

test("cola global por antigüedad: preguntas y permisos de cualquier agente", () => {
  const list = askQueue([
    question(3, 300, [item("Tres", "Tercera")]),
    question(1, 100, [item("Una", "Primera")]),
    question(2, 200, [item("Dos", "Segunda")], { answers: [] }),
    question(4, 400, [item("Cuatro", "Cuarta")], { dismissed: true }),
  ], [{ agent: "codex", prompt, since: 220 }]);
  assert.deepEqual(list.map((entry) => entry.key), ["q1", "pcodex:permiso", "q3"]);
});

test("pregunta de tres pasos: elección única avanza y se envía todo junto", () => {
  const q = question(7, 100, [item("Tema", "Estilo"), item("Tono", "Voz"), item("Formato", "Salida")]);
  let picks = emptyQuestionPicks(q);
  assert.equal(nextQuestionStep(q, picks, 0), null);
  picks = chooseQuestionOption(q, picks, 0, "Oscuro");
  assert.equal(nextQuestionStep(q, picks, 0), 1);
  picks = chooseQuestionOption(q, picks, 1, "Claro");
  assert.equal(nextQuestionStep(q, picks, 1), 2);
  picks = chooseQuestionOption(q, picks, 2, "Oscuro");
  assert.equal(nextQuestionStep(q, picks, 2), 3);
  assert.deepEqual(questionAnswers(q, picks), [
    { question: "Tema", choices: ["Oscuro"], other: "" },
    { question: "Tono", choices: ["Claro"], other: "" },
    { question: "Formato", choices: ["Oscuro"], other: "" },
  ]);
});

test("multi y Otra esperan Enter/Continuar y conservan respuestas al volver", () => {
  const q = question(8, 100, [item("Modos", "Opciones", true), item("Detalle", "Texto")]);
  let picks = emptyQuestionPicks(q);
  picks = chooseQuestionOption(q, picks, 0, "Claro");
  picks = chooseQuestionOption(q, picks, 0, "Oscuro");
  assert.equal(nextQuestionStep(q, picks, 0), 1);
  picks = changeQuestionOther(q, picks, 1, { otherOn: true });
  assert.equal(nextQuestionStep(q, picks, 1), null);
  picks = changeQuestionOther(q, picks, 1, { other: "  Personalizado  " });
  assert.equal(nextQuestionStep(q, picks, 1), 2);
  assert.deepEqual(questionAnswers(q, picks), [
    { question: "Modos", choices: ["Claro", "Oscuro"], other: "" },
    { question: "Detalle", choices: [], other: "Personalizado" },
  ]);
  assert.equal(questionSummary({ ...q, answers: questionAnswers(q, picks) }),
    "Opciones → Claro, Oscuro · Texto → Personalizado");
});

console.log(`${passed} pruebas del panel de preguntas OK`);
