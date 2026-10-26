import assert from "node:assert/strict";
import { leaderRelayDue, LEADER_BATCH_MS } from "./lib/leaderBatch.js";

let n = 0;
function test(name, fn) {
  fn();
  n++;
  console.log("ok -", name);
}

const NOW = 1_000_000;
const review = (id, extra = {}) => ({ id, status: "review", owner: "opencode", reviewer: "claude", ...extra });
const busy = { id: 9, status: "claimed", owner: "antigravity" };
const base = { now: NOW, waitingSince: NOW - 30_000, from: ["lienzo"], unread: 1, leader: "claude", tasks: [review(1), busy], othersBusy: true };

test("una entrega sin prisa mientras el equipo trabaja: espera", () => {
  assert.equal(leaderRelayDue(base), false);
});

test("pasado el tiempo máximo, o con varias juntas, se avisa", () => {
  assert.equal(leaderRelayDue({ ...base, waitingSince: NOW - LEADER_BATCH_MS }), true);
  assert.equal(leaderRelayDue({ ...base, unread: 3 }), true);
});

test("un mensaje de un agente no espera", () => {
  assert.equal(leaderRelayDue({ ...base, from: ["lienzo", "opencode"] }), true);
});

test("una entrega que bloquea otra tarea no espera", () => {
  const tasks = [review(1), busy, { id: 2, status: "open", parents: [1] }];
  assert.equal(leaderRelayDue({ ...base, tasks }), true);
  // Si la hija ya está hecha, no bloquea nada.
  const done = [review(1), busy, { id: 2, status: "done", parents: [1] }];
  assert.equal(leaderRelayDue({ ...base, tasks: done }), false);
});

test("si nadie más trabaja, esperar no ahorra nada: se avisa", () => {
  assert.equal(leaderRelayDue({ ...base, tasks: [review(1)], othersBusy: false }), true);
  assert.equal(leaderRelayDue({ ...base, tasks: [review(1)], othersBusy: true }), false, "otro agente en marcha");
});

test("las entregas que revisa Codex no cuentan como bloqueo del líder", () => {
  const tasks = [review(1, { reviewer: "codex" }), busy, { id: 2, status: "open", parents: [1] }];
  assert.equal(leaderRelayDue({ ...base, tasks }), false);
});

console.log(`${n} pruebas de avisos juntos OK`);
