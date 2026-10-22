import assert from "node:assert/strict";
import { needsResubmit, cleanTerm } from "./lib/submit.js";

let n = 0;
function test(name, fn) {
  fn();
  n++;
  console.log("ok -", name);
}

const base = { text: "Revisa la entrega de #62 y decide", busyBefore: false, sentMs: 1000, lastBusyMs: 0 };
const screen = "\x1b[2K> Revisa la\x1b[1C entrega de #62 y decide\x1b[0m";

test("el texto sigue en el cuadro y el agente no arrancó: otro Enter", () => {
  assert.equal(needsResubmit({ ...base, tail: screen }), true);
});

test("si el agente arrancó, o ya trabajaba, no se toca", () => {
  assert.equal(needsResubmit({ ...base, tail: screen, lastBusyMs: 1500 }), false);
  assert.equal(needsResubmit({ ...base, tail: screen, busyBefore: true }), false);
});

test("si el texto ya no está a la vista, no se insiste", () => {
  assert.equal(needsResubmit({ ...base, tail: "> \x1b[0m" }), false);
});

test("los comandos con «/» y los textos cortos no se repiten", () => {
  assert.equal(needsResubmit({ ...base, text: "/usage", tail: "/usage" }), false);
  assert.equal(needsResubmit({ ...base, text: "sí", tail: "sí" }), false);
});

test("limpia escapes y spinners", () => {
  assert.equal(cleanTerm("\x1b[31m⠋ hola\x1b[0m").trim(), "hola");
});

console.log(`${n} pruebas de envío OK`);
