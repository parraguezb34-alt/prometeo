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

test("Antigravity real: grupos de modelos, lo que queda y la nota del pie", () => {
  const w = parseUsagePanel(
    [
      "└ Models & Quota",
      "  Account: alguien@example.com",
      "GEMINI MODELS",
      "  Models within this group: Gemini Flash, Gemini Pro",
      "  Weekly Limit Remaining",
      "    [███████████████████████████████████████████░░░░░░░] 86.33%",
      "    Refreshes in 90h 4m",
      "  Five Hour Limit Remaining",
      "    [██████████████████████████████████████████████████] 100.00%",
      "    Quota available",
      "CLAUDE AND GPT MODELS",
      "  Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
      "  Weekly Limit Remaining",
      "    [██████████████████████████████████████████████████] 100.00%",
      "    Quota available",
      "  Five Hour Limit Remaining",
      "    [█████████████████████████████████████████░░░░░░░░░] 82.00%",
      "    Refreshes in 2h 30m",
      "  │Within each group, models share a weekly limit and a 5-hour limit. Quota is",
      "  │consumed proportionally to the cost of the tokens.",
      "  (1–22 of 30 lines)",
    ],
    NOW,
  );
  assert.deepEqual(
    w.map((x) => [x.label, x.used_pct]),
    [
      ["Gemini · semana", 13.7],
      ["Gemini · 5 h", 0],
      ["Claude y GPT · semana", 0],
      ["Claude y GPT · 5 h", 18],
    ],
  );
  assert.equal(new Set(w.map((x) => x.key)).size, 4);
  assert.equal(w[0].resets_at, NOW + (90 * 3600 + 4 * 60) * 1000);
  assert.equal(w[1].resets_at, null);
  assert.equal(w[3].resets_at, NOW + (2 * 3600 + 30 * 60) * 1000);
});

test("sin porcentajes no hay ventanas", () => {
  assert.deepEqual(parseUsagePanel(["> hola", "nada que ver"], NOW), []);
  assert.deepEqual(parseUsagePanel(null, NOW), []);
});

console.log(`${n} pruebas de límites OK`);

{
  const { quotaAlerts } = await import("./lib/limits.js");
  const lim = (pct, resets_at = 1000) => ({ claude: { windows: [{ key: "5h", label: "Sesión de 5 h", used_pct: pct, resets_at }], exact: true, note: "", ts_ms: 0 } });
  const seen = new Set();
  assert.equal(quotaAlerts(lim(70), seen).length, 0, "por debajo del 80 no avisa");
  const a = quotaAlerts(lim(82), seen);
  assert.equal(a.length, 1);
  assert.equal(a[0].threshold, 80);
  assert.equal(quotaAlerts(lim(85), seen).length, 0, "un aviso por umbral");
  assert.equal(quotaAlerts(lim(96), seen)[0].threshold, 95, "al 95 vuelve a avisar");
  assert.equal(quotaAlerts(lim(83, 9000), seen).length, 1, "tras el reinicio, otra vez");
  const fresh = new Set();
  const b = quotaAlerts(lim(97), fresh);
  assert.equal(b.length, 1, "si salta directo al 95, un solo aviso");
  assert.equal(quotaAlerts(lim(97), fresh).length, 0);
  console.log("ok - avisos de cuota al 80 y al 95 %");
}

{
  const { burnAlerts } = await import("./lib/limits.js");
  const lim = (week, session = 10, exact = true) => ({
    claude: { windows: [{ key: "session", label: "Sesión (5 h)", used_pct: session, resets_at: null }, { key: "week", label: "Semana", used_pct: week, resets_at: null }], exact, note: "", ts_ms: 0 },
  });
  const h = new Map();
  const last = new Map();
  const min = 60_000;
  assert.equal(burnAlerts(lim(40), h, last, 0).length, 0);
  assert.equal(burnAlerts(lim(42), h, last, 10 * min).length, 0, "2 puntos de la semana en 10 min: normal");
  const a = burnAlerts(lim(45, 20), h, last, 20 * min);
  assert.equal(a.length, 1, "5 puntos de la semana en 20 min: aviso");
  assert.equal(a[0].window, "Semana");
  assert.equal(a[0].rise, 5);
  assert.equal(a[0].minutes, 20);
  assert.equal(burnAlerts(lim(49, 25), h, last, 25 * min).length, 0, "no se repite enseguida");
  // La de 5 h aguanta más: 15 puntos en media hora es trabajo normal; 40, no.
  const h2 = new Map();
  const l2 = new Map();
  burnAlerts(lim(10, 10), h2, l2, 0);
  assert.equal(burnAlerts(lim(10, 25), h2, l2, 20 * min).length, 0);
  const b = burnAlerts(lim(10, 50), h2, l2, 25 * min);
  assert.equal(b.length, 1);
  assert.equal(b[0].window, "Sesión (5 h)");
  // Lo antiguo sale de la media hora y no cuenta; los datos leídos de pantalla, tampoco.
  const h3 = new Map();
  const l3 = new Map();
  burnAlerts(lim(10), h3, l3, 0);
  assert.equal(burnAlerts(lim(16), h3, l3, 60 * min).length, 0, "6 puntos en una hora: fuera de la ventana");
  assert.equal(burnAlerts(lim(99, 10, false), new Map(), new Map(), 0).length, 0);
  console.log("ok - aviso de gasto rápido de la cuota");
}

{
  const { quotaPace } = await import("./lib/limits.js");
  const H = 3_600_000;
  const now = 1_000 * H;
  const lim = (week, wLeftH, session = 0, sLeftH = 5) => ({
    windows: [
      { key: "session", label: "Sesión (5 h)", used_pct: session, resets_at: now + sLeftH * H },
      { key: "week", label: "Semana", used_pct: week, resets_at: now + wLeftH * H },
    ],
    exact: true, note: "", ts_ms: 0,
  });
  // Mitad de la semana (84 h de 168): con el 40 % va 10 puntos por debajo de un gasto parejo.
  assert.equal(Math.round(quotaPace(lim(40, 84, 0, 5), now)), -10);
  assert.equal(Math.round(quotaPace(lim(70, 84, 0, 5), now)), 20, "por delante: gasta rápido");
  // La de 5 h también cuenta (con 15 de margen): 60 % gastado en la primera hora va muy por delante.
  assert.equal(Math.round(quotaPace(lim(10, 84, 60, 4), now)), 25);
  assert.equal(quotaPace(lim(85, 84), now), Infinity, "pasado el 80 %, nada pesado");
  assert.equal(quotaPace(undefined, now), 0, "sin datos, neutro");
  console.log("ok - ritmo de la cuota");
}
