import assert from "node:assert/strict";
import { parseEvery, nextRun, dayKey, isDue } from "./lib/schedule.js";

let n = 0;
function test(name, fn) {
  fn();
  n++;
  console.log("ok -", name);
}
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

test("entiende las frecuencias del hub", () => {
  assert.deepEqual(parseEvery("cada 30 min"), { kind: "interval", mins: 30 });
  assert.deepEqual(parseEvery("Cada 2 h"), { kind: "interval", mins: 120 });
  assert.equal(parseEvery("cada 5 min"), null);
  assert.equal(parseEvery("cada día 9:00").days.filter(Boolean).length, 7);
  assert.deepEqual(parseEvery("lun-vie 8:30").days, [true, true, true, true, true, false, false]);
  assert.deepEqual(parseEvery("lun,mié,vie 18:00").days, [true, false, true, false, true, false, false]);
  assert.deepEqual(parseEvery("sáb-lun 10:00").days, [true, false, false, false, false, true, true]);
  for (const bad of ["a veces", "lun 25:00", "pepe 9:00", "cada día"]) assert.equal(parseEvery(bad), null, bad);
});

test("la próxima vez, en hora local", () => {
  // Miércoles 22 de octubre de 2026, 10:00.
  const wed10 = at(2026, 10, 22, 10);
  assert.equal(nextRun(parseEvery("cada día 9:00"), wed10), at(2026, 10, 23, 9), "hoy ya pasó: mañana");
  assert.equal(nextRun(parseEvery("cada día 11:30"), wed10), at(2026, 10, 22, 11, 30));
  assert.equal(nextRun(parseEvery("lun-vie 8:30"), at(2026, 10, 24, 12)), at(2026, 10, 26, 8, 30), "del sábado al lunes");
  assert.equal(nextRun(parseEvery("cada 2 h"), wed10), wed10 + 2 * 3_600_000);
  assert.equal(dayKey(wed10), "2026-10-22");
});

test("le toca solo activa, de su proyecto y con la hora pasada", () => {
  const s = { id: 1, status: "active", every: "cada día 9:00", approved_ms: at(2026, 10, 21, 10), last_ms: 0, project: "C:/Users/X/Proy/" };
  const key = "c:/users/x/proy";
  assert.equal(isDue(s, at(2026, 10, 22, 8, 59), key), false);
  assert.equal(isDue(s, at(2026, 10, 22, 9, 0), key), true);
  assert.equal(isDue({ ...s, status: "pending" }, at(2026, 10, 22, 9), key), false);
  assert.equal(isDue(s, at(2026, 10, 22, 9), "c:/otro"), false);
  // Con Prometeo cerrado tres días: toca una vez al abrir, y la siguiente cuenta desde entonces.
  assert.equal(isDue({ ...s, last_ms: at(2026, 10, 19, 9) }, at(2026, 10, 22, 12), key), true);
});

console.log(`${n} pruebas de programadas OK`);
