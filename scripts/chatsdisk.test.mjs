import assert from "node:assert/strict";
import { droppedEvents, mergeChats, sameChats, withOlder } from "./lib/chatsDisk.js";

let n = 0;
function test(name, fn) {
  fn();
  n++;
  console.log("ok -", name);
}

const chat = (id, createdMs, extra = {}) => ({ id, kind: "team", title: id, autoTitle: false, startMs: createdMs, createdMs, ...extra });

test("juntar la copia rápida con el disco sin perder ninguno", () => {
  const disk = [chat("c", 30), chat("b", 20, { title: "viejo" }), chat("a", 10)];
  const mine = [chat("d", 40), chat("b", 20, { title: "nuevo" })];
  const m = mergeChats(mine, disk);
  assert.deepEqual(m.map((c) => c.id), ["d", "c", "b", "a"]);
  assert.equal(m.find((c) => c.id === "b").title, "nuevo", "vale lo que se acaba de tocar");
  // Sin copia rápida (navegador limpiado): todo sale del disco.
  assert.deepEqual(mergeChats([], disk).map((c) => c.id), ["c", "b", "a"]);
  assert.ok(sameChats(mergeChats(disk, disk), disk));
  assert.ok(!sameChats(m, mine));
});

const ev = (seq, ts) => ({ seq, ts_ms: ts, agent: "a", session_id: "", kind: "message", text: `e${seq}`, files: [] });

test("lo que se cae del feed vivo queda en el chat abierto", () => {
  // Feeds del más nuevo al más viejo; entra el 6 y se cae el 3.
  const prev = [ev(5, 500), ev(4, 400), ev(3, 300)];
  const next = [ev(6, 600), ev(5, 500), ev(4, 400)];
  assert.deepEqual(droppedEvents(prev, next, 0).map((e) => e.seq), [3]);
  // Si el chat empezó después, no hace falta guardarlo.
  assert.deepEqual(droppedEvents(prev, next, 350), []);
  // Entran dos y se caen dos: van del más viejo al más nuevo.
  const next2 = [ev(8, 800), ev(7, 700), ev(6, 600)];
  assert.deepEqual(droppedEvents(next, next2, 0).map((e) => e.seq), [4, 5]);
  assert.deepEqual(droppedEvents([], next, 0), []);
});

test("lo viejo va delante de lo vivo, sin repetir", () => {
  const live = [ev(4, 400), ev(5, 500)];
  const out = withOlder([ev(3, 300), ev(1, 100), ev(4, 400), ev(3, 300), ev(2, 200)], live);
  assert.deepEqual(out.map((e) => e.seq), [1, 2, 3, 4, 5]);
  assert.equal(withOlder([], live), live);
});

console.log(`${n} pruebas de chats en disco OK`);
