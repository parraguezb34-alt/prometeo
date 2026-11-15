import assert from "node:assert/strict";
import { acceptOption, findRule, forgetRule, loadRules, rememberRule, ruleKey } from "./lib/permMemory.js";
import { detectPrompt } from "./lib/prompts.js";

let passed = 0;
function test(name, run) {
  run();
  passed++;
  console.log("ok -", name);
}

const memStore = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
};

const ask = {
  title: "Do you want to proceed?",
  detail: ["Bash command", "npm   test"],
  options: [
    { label: "Sí", keys: "\r", tone: "yes" },
    { label: "Sí, y no volver a preguntar", keys: "\x1b[B\r", tone: "always" },
    { label: "No", keys: "\x1b[B\x1b[B\r", tone: "no" },
  ],
  key: "num|x",
};

test("la clave no depende de mayúsculas, espacios ni barras", () => {
  assert.equal(ruleKey(ask), ruleKey({ title: "do you want to PROCEED?", detail: ["bash command", "npm test"] }));
  assert.notEqual(ruleKey(ask), ruleKey({ ...ask, detail: ["Bash command", "npm run build"] }));
});

test("recuerda y encuentra solo con el mismo agente, proyecto y pregunta", () => {
  const s = memStore();
  rememberRule("Claude", "C:\\Proy\\demo\\", ask, s);
  assert.ok(findRule("claude", "c:/proy/demo", ask, s));
  assert.equal(findRule("codex", "c:/proy/demo", ask, s), null);
  assert.equal(findRule("claude", "c:/proy/otro", ask, s), null);
  assert.equal(findRule("claude", "c:/proy/demo", { ...ask, detail: ["Bash command", "rm -rf /"] }, s), null);
  assert.equal(findRule("claude", null, ask, s), null);
});

test("no duplica y se puede olvidar", () => {
  const s = memStore();
  const r = rememberRule("claude", "c:/p", ask, s);
  rememberRule("claude", "c:/p", ask, s);
  assert.equal(loadRules(s).length, 1);
  forgetRule(r, s);
  assert.equal(loadRules(s).length, 0);
});

test("acepta con «siempre» o «sí», nunca rechaza", () => {
  assert.equal(acceptOption(ask).tone, "always");
  assert.equal(acceptOption({ ...ask, options: ask.options.filter((o) => o.tone !== "always") }).tone, "yes");
  assert.equal(acceptOption({ ...ask, options: [{ label: "No", keys: "n\r", tone: "no" }] }), null);
});

test("pantalla real de Claude Code: la segunda vez se contesta sola con la misma tecla", () => {
  const screen = (cmd) => [
    " Bash command",
    "",
    `   ${cmd}`,
    "   Run the tests",
    "",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and don't ask again for npm test commands in C:/Users/ana/demo",
    "   3. No, and tell Claude what to do differently (esc)",
  ];
  const s = memStore();
  const first = detectPrompt(screen("npm test"));
  const always = first.options.find((o) => o.tone === "always");
  assert.ok(always, "trae opción «siempre»");
  rememberRule("claude", "C:/Users/ana/demo", first, s);
  const again = detectPrompt(screen("npm test"));
  assert.ok(findRule("claude", "C:/Users/ana/demo", again, s));
  assert.equal(acceptOption(again).keys, always.keys);
  assert.equal(findRule("claude", "C:/Users/ana/demo", detectPrompt(screen("rm -rf build")), s), null);
});

console.log(`${passed} pruebas de permisos recordados OK`);
