import assert from "node:assert/strict";
import { copyProjectStorage } from "./lib/project.js";

const values = new Map();
let failNextWrite = false;
globalThis.localStorage = {
  get length() { return values.size; },
  key(i) { return [...values.keys()][i] ?? null; },
  getItem(k) { return values.get(k) ?? null; },
  setItem(k, v) {
    if (failNextWrite) {
      failNextWrite = false;
      throw new Error("almacenamiento lleno");
    }
    values.set(k, v);
  },
  removeItem(k) { values.delete(k); },
};

const a = "C:\\Proyectos\\A";
const b = "C:\\Proyectos\\B";
const chatA = `lienzo.chats.v1:${a}`;
const chatB = `lienzo.chats.v1:${b}`;

values.set(chatA, "chats de A");
values.set(chatB, "chats de B");
const undo = copyProjectStorage(a, b, false);
assert.equal(values.get(chatB), "chats de A");
assert.equal(typeof undo, "function");
undo();
assert.equal(values.get(chatA), "chats de A");
assert.equal(values.get(chatB), "chats de B", "un renombrado fallido restaura el destino");
console.log("ok - la copia reversible conserva los chats del destino al fallar el renombrado");

values.delete(chatB);
failNextWrite = true;
assert.equal(copyProjectStorage(a, b, true), null);
assert.equal(values.get(chatA), "chats de A");
assert.equal(values.has(chatB), false);
console.log("ok - una escritura local fallida no borra el origen");

assert.equal(typeof copyProjectStorage(a, b, true), "function");
assert.equal(values.has(chatA), false);
assert.equal(values.get(chatB), "chats de A");
console.log("ok - un renombrado confirmado mueve los chats");
