import assert from "node:assert/strict";
import { STALL_CONFIG as C, detectStall, lastHubSignal, sameToolSince, stallPrompt, stallText } from "./lib/stall.js";

const NOW = 10_000_000;
const MIN = 60_000;
// Los eventos del hub llegan del más nuevo al más viejo (seq decreciente).
const ev = (agent, kind, text, ago) => ({ agent, kind, text, ts_ms: NOW - ago });
const feed = (...list) => list.map((e, i) => ({ ...e, seq: 1000 - i }));
const base = (events, extra = {}) => ({ now: NOW, agent: "x", taskId: 7, events, termBusyMs: 0, waiting: false, ...extra });
let n = 0;
function test(name, fn) {
  fn();
  n++;
  console.log("ok -", name);
}

test("con señales recientes no está colgado", () => {
  const events = feed(ev("x", "tool", "Edit a.ts", 2 * MIN));
  assert.equal(detectStall(base(events)), null);
});

test("ocho minutos sin señales: colgado", () => {
  const events = feed(ev("x", "tool", "Edit a.ts", 9 * MIN));
  const s = detectStall(base(events));
  assert.equal(s.reason, "quiet");
  assert.equal(s.minutes, 9);
  assert.equal(s.sinceMs, NOW - 9 * MIN);
  assert.equal(stallText(s), "Sin señales desde hace 9 min");
});

test("la terminal trabajando cuenta como señal", () => {
  const events = feed(ev("x", "tool", "Bash npm test", 9 * MIN));
  assert.equal(detectStall(base(events, { termBusyMs: NOW - 10_000 })), null);
});

test("entrar o salir del equipo no cuenta como señal; las de otros agentes tampoco", () => {
  const events = feed(ev("x", "join", "", 1 * MIN), ev("y", "tool", "Edit b.ts", 1 * MIN), ev("x", "tool", "Edit a.ts", 10 * MIN));
  assert.equal(lastHubSignal(events, "x"), NOW - 10 * MIN);
  assert.equal(detectStall(base(events)).reason, "quiet");
});

test("tomar la tarea cuenta como señal", () => {
  const events = feed(ev("x", "tool", "Edit a.ts", 30 * MIN));
  assert.equal(detectStall(base(events, { claimedMs: NOW - 3 * MIN })), null);
});

test("sin ninguna señal conocida no se acusa a nadie", () => {
  assert.equal(detectStall(base([])), null);
});

test("si te espera a ti (permiso o pregunta), no está colgado", () => {
  const events = feed(ev("x", "tool", "Edit a.ts", 30 * MIN));
  assert.equal(detectStall(base(events, { waiting: true })), null);
});

test("veinte minutos con la misma herramienta aunque la terminal se mueva: atascado", () => {
  const events = feed(ev("x", "tool", "Bash cargo build", 21 * MIN));
  const s = detectStall(base(events, { termBusyMs: NOW - 1_000 }));
  assert.equal(s.reason, "tool");
  assert.equal(s.minutes, 21);
  assert.equal(s.tool, "Bash cargo build");
  assert.ok(stallText(s).startsWith("Lleva 21 min con la misma herramienta"));
});

test("repetir la misma herramienta en bucle también es atascarse", () => {
  const events = feed(
    ev("x", "tool", "Bash npm test", 1 * MIN),
    ev("x", "tool", "Bash npm test", 8 * MIN),
    ev("x", "tool", "Bash npm test", 15 * MIN),
    ev("x", "tool", "Bash npm test", 22 * MIN),
    ev("x", "tool", "Edit a.ts", 23 * MIN),
  );
  assert.deepEqual(sameToolSince(events, "x"), { tool: "Bash npm test", since: NOW - 22 * MIN });
  assert.equal(detectStall(base(events, { termBusyMs: NOW })).reason, "tool");
});

test("una herramienta distinta o un avance cortan la racha", () => {
  const otra = feed(ev("x", "tool", "Bash npm test", 1 * MIN), ev("x", "tool", "Edit a.ts", 5 * MIN), ev("x", "tool", "Bash npm test", 25 * MIN));
  assert.equal(sameToolSince(otra, "x").since, NOW - 1 * MIN);
  assert.equal(detectStall(base(otra, { termBusyMs: NOW })), null);
  const avance = feed(ev("x", "update", "voy por la mitad", 1 * MIN), ev("x", "tool", "Bash npm test", 25 * MIN));
  assert.equal(sameToolSince(avance, "x"), null);
  assert.equal(detectStall(base(avance)), null);
});

test("los umbrales se pueden cambiar (y 0 apaga cada regla)", () => {
  const events = feed(ev("x", "tool", "Edit a.ts", 4 * MIN));
  assert.equal(detectStall(base(events), { ...C, quietMs: 3 * MIN }).reason, "quiet");
  assert.equal(detectStall(base(events), { quietMs: 0, sameToolMs: 0 }), null);
});

test("la pregunta es una sola línea que pide un team_update", () => {
  const p = stallPrompt({ agent: "x", taskId: 7, reason: "quiet", sinceMs: 0, minutes: 9 });
  assert.ok(!p.includes("\n") && p.includes("#7") && p.includes("team_update") && p.includes("9 min"));
});

test("lo de antes de abrir Prometeo no cuenta como silencio ni como racha", () => {
  const events = feed(ev("x", "tool", "Bash cargo build", 60 * MIN));
  assert.equal(detectStall(base(events, { fromMs: NOW - 2 * MIN })), null);
  const s = detectStall(base(events, { fromMs: NOW - 9 * MIN }));
  assert.equal(s.reason, "quiet");
  assert.equal(s.minutes, 9);
});

console.log(`\n${n} pruebas pasadas`);
