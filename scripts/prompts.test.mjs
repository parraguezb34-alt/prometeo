import assert from "node:assert/strict";
import { detectPrompt } from "./lib/prompts.js";

let n = 0;
function test(name, fn) {
  fn();
  n++;
  console.log("ok -", name);
}

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const DOWN = "\x1b[B";

test("OpenCode: permiso con Allow once / Always allow / Reject (pantalla real)", () => {
  const p = detectPrompt([
    "  + Thought · 693ms",
    "  → Read ~/OneDrive/Escritorio/pagian3daa/src/scene/Particles.jsx",
    "",
    "  △ Permission required",
    "    ← Access external directory ~/OneDrive/Escritorio/pagian3daa/src/scene",
    "",
    "  Patterns",
    "",
    "  - C:/Users/parra/OneDrive/Escritorio/pagian3daa/src/scene/*",
    "",
    "   Allow once   Always allow   Reject          ctrl+f fullscreen  ⇆ select  enter confirm",
  ]);
  assert.equal(p.title, "Pide permiso");
  assert.deepEqual(p.detail, [
    "Access external directory ~/OneDrive/Escritorio/pagian3daa/src/scene",
    "C:/Users/parra/OneDrive/Escritorio/pagian3daa/src/scene/*",
  ]);
  assert.deepEqual(
    p.options.map((o) => [o.label, o.keys, o.tone]),
    [
      ["Permitir una vez", LEFT + LEFT + "\r", "yes"],
      ["Permitir siempre", LEFT + LEFT + RIGHT + "\r", "always"],
      ["Rechazar", LEFT + LEFT + RIGHT + RIGHT + "\r", "no"],
    ],
  );
});

test("Claude Code: «Do you want to proceed?» con menú numerado y caja", () => {
  const p = detectPrompt([
    "╭──────────────────────────────────────────────╮",
    "│ Bash command                                 │",
    "│                                              │",
    "│   npm run build                              │",
    "│   Compila el proyecto                        │",
    "│                                              │",
    "│ Do you want to proceed?                      │",
    "│ ❯ 1. Yes                                     │",
    "│   2. Yes, and don't ask again for npm run    │",
    "│   build commands in C:\\proj                  │",
    "│   3. No, and tell Claude what to do          │",
    "╰──────────────────────────────────────────────╯",
    "",
  ]);
  assert.equal(p.title, "Do you want to proceed?");
  assert.deepEqual(p.detail, ["Bash command", "npm run build", "Compila el proyecto"]);
  assert.deepEqual(
    p.options.map((o) => [o.label, o.keys]),
    [
      ["Sí", "\r"],
      ["Sí, y no volver a preguntar", DOWN + "\r"],
      ["No, and tell Claude what to do", DOWN + DOWN + "\r"],
    ],
  );
});

test("la opción marcada puede no ser la primera", () => {
  const p = detectPrompt(["Allow this action?", "  1. Yes, allow once", "● 2. Yes, allow always", "  3. No (esc)"]);
  assert.deepEqual(
    p.options.map((o) => [o.label, o.keys]),
    [
      ["Sí, esta vez", "\x1b[A\r"],
      ["Sí, siempre", "\r"],
      ["No", DOWN + "\r"],
    ],
  );
});

test("una lista normal en un mensaje no es una pregunta", () => {
  assert.equal(detectPrompt(["Resumen:", "1. Repartí el encargo.", "2. Revisé la entrega.", "3. La cerré."]), null);
  assert.equal(detectPrompt(["¿Seguimos?", "1. Uno", "2. Dos", "", "> escribe aquí", "", "", "", "", "", "", "estado"]), null);
  assert.equal(detectPrompt([]), null);
});

test("(y/n)", () => {
  const p = detectPrompt(["Se borrará la carpeta dist", "¿Continuar? (y/n)"]);
  assert.equal(p.title, "¿Continuar?");
  assert.deepEqual(p.options.map((o) => o.keys), ["y\r", "n\r"]);
});

console.log(`${n} pruebas de preguntas de terminal OK`);
