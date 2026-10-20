import assert from "node:assert/strict";
import { fmtReset, level, parseUsagePanel, worst } from "./lib/limits.js";

let n = 0;
function test(name, fn) {
  fn();
  n++;
  console.log("ok -", name);
}

const NOW = 1_800_000_000_000;

test("tiempo hasta el reinicio, en palabras", () => {
  assert.equal(fmtReset(NOW + (2 * 3600 + 13 * 60) * 1000, NOW), "en 2 h 13 min");
  assert.equal(fmtReset(NOW + 40 * 60 * 1000, NOW), "en 40 min");
  assert.equal(fmtReset(NOW + 30 * 3600 * 1000, NOW), "en 1 día y 6 h");
  assert.equal(fmtReset(NOW + 4 * 86400 * 1000, NOW), "en 4 días");
  assert.equal(fmtReset(NOW - 1000, NOW), "ya");
  assert.equal(fmtReset(null, NOW), "");
});

test("niveles y la ventana más llena", () => {
  assert.equal(level(10), "ok");
  assert.equal(level(75), "warn");
  assert.equal(level(95), "crit");
  const w = worst({ windows: [{ key: "a", label: "A", used_pct: 20, resets_at: null }, { key: "b", label: "B", used_pct: 61, resets_at: null }], exact: true, note: "", ts_ms: 0 });
  assert.equal(w.key, "b");
});

test("panel de /usage: usado y restante, con reinicio", () => {
  const w = parseUsagePanel(
    [
      "╭──────────────── Usage ────────────────╮",
      "│ Gemini Models                           │",
      "│ 5-hour limit   ██████░░░░  62% used     │",
      "│   resets in 3h 12m                      │",
      "│ Weekly limit   ██░░░░░░░░  80% remaining │",
      "│   resets in 4d                          │",
      "╰─────────────────────────────────────────╯",
    ],
    NOW,
  );
  assert.equal(w.length, 2);
  assert.equal(w[0].label, "5-hour limit");
  assert.equal(w[0].used_pct, 62);
  assert.equal(w[0].resets_at, NOW + (3 * 3600 + 12 * 60) * 1000);
  assert.equal(w[1].label, "Weekly limit");
  assert.equal(w[1].used_pct, 20);
  assert.equal(w[1].resets_at, NOW + 4 * 86400 * 1000);
});

test("panel con barra entre corchetes y nombre arriba; el panel dice lo que queda", () => {
  const w = parseUsagePanel(
    [
      "Model quota (remaining)",
      "Gemini 3.8 Flash",
      "[████████░░] 86%",
      "Resets in 3d",
      "Gemini 3.1 Pro",
      "[██████████] 100%",
      "Claude Sonnet",
      "[██████████] 100%",
    ],
    NOW,
  );
  assert.deepEqual(
    w.map((x) => [x.label, x.used_pct]),
    [
      ["Gemini 3.8 Flash", 14],
      ["Gemini 3.1 Pro", 0],
      ["Claude Sonnet", 0],
    ],
  );
  assert.equal(w[0].resets_at, NOW + 3 * 86400 * 1000);
});

test("sin porcentajes no hay ventanas", () => {
  assert.deepEqual(parseUsagePanel(["> hola", "nada que ver"], NOW), []);
  assert.deepEqual(parseUsagePanel(null, NOW), []);
});

console.log(`${n} pruebas de límites OK`);
