import assert from "node:assert/strict";
import { detectPrompt, detectTrust } from "./lib/prompts.js";

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
    "  → Read ~/proyectos/demo/src/scene/Particles.jsx",
    "",
    "  △ Permission required",
    "    ← Access external directory ~/proyectos/demo/src/scene",
    "",
    "  Patterns",
    "",
    "  - C:/Users/ana/proyectos/demo/src/scene/*",
    "",
    "   Allow once   Always allow   Reject          ctrl+f fullscreen  ⇆ select  enter confirm",
  ]);
  assert.equal(p.title, "Pide permiso");
  assert.deepEqual(p.detail, [
    "Access external directory ~/proyectos/demo/src/scene",
    "C:/Users/ana/proyectos/demo/src/scene/*",
  ]);
  assert.deepEqual(
    p.options.map((o) => [o.label, o.keys, o.tone]),
    [
      // El selector de OpenCode da la vuelta y empieza en «Allow once»: ← va a «Reject».
      // «Always allow» y «Reject» piden un segundo Enter (confirmar / motivo vacío).
      ["Permitir una vez", "\r", "yes"],
      ["Permitir siempre", RIGHT + "\r\r", "always"],
      ["Rechazar", LEFT + "\r\r", "no"],
    ],
  );
});

test("OpenCode: el segundo paso de «Always allow» (Confirm / Cancel)", () => {
  const p = detectPrompt([
    "  △ Always allow",
    "",
    "  This will always allow the following patterns for this project.",
    "  - C:/Users/ana/proyectos/demo/*",
    "",
    "   Confirm   Cancel          ⇆ select  enter confirm  esc cancel",
  ]);
  assert.equal(p.title, "¿Permitir siempre?");
  assert.deepEqual(p.detail, [
    "This will always allow the following patterns for this project.",
    "C:/Users/ana/proyectos/demo/*",
  ]);
  assert.deepEqual(
    p.options.map((o) => [o.label, o.keys]),
    [
      ["Confirmar", "\r"],
      ["Cancelar", RIGHT + "\r"],
    ],
  );
});

test("Codex: «Would you like to run the following command?» con un comando largo en medio", () => {
  const p = detectPrompt([
    "• Explored",
    "  └ Read DESARROLLO.md",
    "",
    "  Would you like to run the following command?",
    "",
    "  Reason: Necesito leer el repositorio de Prometeo fuera de la carpeta de trabajo",
    "",
    "  $ Get-Content -LiteralPath 'C:\\Users\\ana\\proyectos\\demo\\src\\hub\\",
    "  server.rs' | Select-Object -Skip 700 -First 80",
    "",
    "› 1. Yes, proceed (y)",
    "  2. Yes, and don't ask again for commands that start with `Get-Content` (p)",
    "  3. No, and tell Codex what to do differently (esc)",
    "",
    "  Press enter to confirm or esc to cancel",
  ]);
  assert.equal(p.title, "Would you like to run the following command?");
  assert.equal(p.detail[0], "Reason: Necesito leer el repositorio de Prometeo fuera de la carpeta de trabajo");
  assert.match(p.detail[1], /^\$ Get-Content/);
  assert.deepEqual(
    p.options.map((o) => [o.label, o.keys, o.tone]),
    [
      ["Sí, adelante", "\r", "yes"],
      ["Sí, y no volver a preguntar", DOWN + "\r", "always"],
      ["No, y explicar qué hacer", DOWN + DOWN + "\r", "no"],
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

const UP = "\x1b[A";
const P3D = "C:\\Users\\ana\\proyectos\\demo";

test("Confianza de carpeta: Claude Code (No marcado arriba → bajar y Enter)", () => {
  const screen = [
    "Accessing workspace:",
    "",
    "C:\\Users\\ana\\proyectos\\demo",
    "",
    "Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known",
    "open source project, or work from your team). If not, take a moment to review what's in this folder first.",
    "",
    "Claude Code'll be able to read, edit, and execute files here.",
    "",
    "Security guide",
    "",
    "❯ No, exit",
    "  Yes, I trust this folder",
    "",
    "Enter to confirm · Esc to cancel",
  ];
  assert.equal(detectTrust(screen, P3D), DOWN + "\r");
  assert.equal(detectTrust(screen, P3D + "\\"), DOWN + "\r");
  // Otra carpeta: no se acepta sola.
  assert.equal(detectTrust(screen, "C:\\Users\\ana\\proyectos"+"\\otra"), null);
  assert.equal(detectTrust(screen, null), null);
});

test("Confianza de carpeta: Antigravity (Sí ya marcado → Enter)", () => {
  const screen = [
    "Accessing workspace:",
    "",
    "C:\\Users\\ana\\proyectos\\demo",
    "",
    "Do you trust the contents of this project?",
    "",
    "Antigravity CLI requires permission to read, edit, and execute files here.",
    "",
    "> Yes, I trust this folder",
    "  No, exit",
    "",
    "↑/↓ Navigate · enter Confirm",
    "                                   Gemini 3.8 Flash · high",
  ];
  assert.equal(detectTrust(screen, P3D), "\r");
});

test("Confianza de carpeta: menú numerado y ruta partida en dos líneas", () => {
  const screen = [
    "Do you trust the files in this folder?",
    "C:\\Users\\ana\\proyectos\\de",
    "mo",
    "  1. No, exit",
    "❯ 2. Yes, proceed",
  ];
  assert.equal(detectTrust(screen, P3D), UP.repeat(0) + "\r");
  assert.equal(detectTrust(["Do you trust this folder?", P3D, "❯ 1. Yes", "  2. No"], P3D), "\r");
  assert.equal(detectTrust(["Do you trust this folder?", P3D, "  1. Yes", "❯ 2. No"], P3D), UP + "\r");
});

test("Confianza: un permiso normal no se toma por la pregunta de confianza", () => {
  assert.equal(detectTrust(["Do you want to proceed?", P3D, "❯ 1. Yes", "  2. No"], P3D), null);
});

console.log(`${n} pruebas de preguntas de terminal OK`);
