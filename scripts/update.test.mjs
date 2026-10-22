import assert from "node:assert/strict";
import { newSince } from "./lib/update.js";

let n = 0;
function test(name, fn) {
  fn();
  n++;
  console.log("ok -", name);
}

const ch = (hash) => ({ hash, ts_ms: 0, subject: `s-${hash}` });
const list = [ch("e5"), ch("d4"), ch("c3"), ch("b2"), ch("a1")];

test("novedades: los commits desde el último visto", () => {
  assert.deepEqual(newSince(list, { version: "1.0.3", commit: "c3" }).map((c) => c.hash), ["e5", "d4"]);
  // El mismo commit: nada nuevo.
  assert.deepEqual(newSince(list, { version: "1.0.5", commit: "e5" }), []);
  // Hash largo guardado frente a corto en la lista (y al revés).
  assert.deepEqual(newSince(list, { version: "", commit: "d4ffff" }).map((c) => c.hash), ["e5"]);
  // Sin nada visto: sin novedades (las decide quien llama).
  assert.deepEqual(newSince(list, null), []);
  // El visto ya no está en la lista: las más recientes, con tope.
  assert.deepEqual(newSince(list, { version: "", commit: "zz" }, 2).map((c) => c.hash), ["e5", "d4"]);
});

console.log(`${n} pruebas de novedades OK`);
