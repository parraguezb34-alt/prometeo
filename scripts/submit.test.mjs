import assert from "node:assert/strict";
import { DIALOG, needsResubmit, cleanTerm, bracketedAfter, asPaste, isMessage } from "./lib/submit.js";

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

test("reconoce el aviso de Codex que se come el teclado", () => {
  const warn = "Warnings \x1b[2m·\x1b[0m 1 of 1 · MCP · Roblox_Studio\r\n\x1b[1mk\x1b[0m keep & next · \x1b[1mesc\x1b[0m dismiss & close · ctrl+o copy";
  assert.equal(DIALOG.test(cleanTerm(warn)), true);
  assert.equal(DIALOG.test(cleanTerm("\x1b[2m esc to interrupt\x1b[0m")), false);
});

test("un texto largo resumido como pegado que sigue en el cuadro: otro Enter", () => {
  assert.equal(needsResubmit({ ...base, tail: "› [Pasted Content 812 chars]" }), true);
  assert.equal(needsResubmit({ ...base, tail: "> [Pasted text #1 +3 lines]" }), true);
});

test("pegado «bracketed»: manda la última marca y solo entonces se envuelve el texto", () => {
  assert.equal(bracketedAfter(false, "hola\x1b[?2004h"), true);
  assert.equal(bracketedAfter(true, "\x1b[?2004l"), false);
  assert.equal(bracketedAfter(true, "\x1b[?2004l…\x1b[?2004h"), true);
  assert.equal(bracketedAfter(true, "nada"), true);
  assert.equal(asPaste("hola", true), "\x1b[200~hola\x1b[201~");
  assert.equal(asPaste("hola", false), "hola");
});

test("solo los mensajes van como pegado: los comandos y las respuestas cortas no", () => {
  assert.equal(isMessage("📌 Despacho de Prometeo: toma la tarea #105"), true);
  assert.equal(isMessage("/clear"), false);
  assert.equal(isMessage("/model gpt-5"), false);
  assert.equal(isMessage("y"), false);
});

console.log(`${n} pruebas de envío OK`);
