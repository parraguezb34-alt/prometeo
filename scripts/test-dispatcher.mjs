// Compila las piezas puras del frontend (despachador y adjuntos) y corre sus pruebas con Node.
// Uso: npm test
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "node_modules", ".cache", "dispatcher-test");
mkdirSync(out, { recursive: true });

const suites = ["dispatcher", "stall", "attach", "notices", "prompts", "markdown", "limits", "research", "submit", "schedule", "viewer", "chatsdisk", "update", "leaderbatch", "askdock", "quote", "visibleinterval"];

execFileSync(
  process.execPath,
  [
    join(root, "node_modules", "typescript", "bin", "tsc"),
    "src/lib/dispatcher.ts",
    "src/lib/stall.ts",
    "src/lib/attach.ts",
    "src/lib/notices.ts",
    "src/lib/prompts.ts",
    "src/lib/limits.ts",
    "src/lib/research.ts",
    "src/lib/submit.ts",
    "src/lib/schedule.ts",
    "src/lib/viewer.ts",
    "src/lib/exportChat.ts",
    "src/lib/chatsDisk.ts",
    "src/lib/update.ts",
    "src/lib/leaderBatch.ts",
    "src/lib/askDock.ts",
    "src/lib/quote.ts",
    "src/lib/useVisibleInterval.ts",
    "src/components/Markdown.tsx",
    "src/lib/bridge.ts",
    "--jsx",
    "react-jsx",
    "--rootDir",
    "src",
    "--ignoreConfig",
    "--outDir",
    out,
    "--target",
    "es2020",
    "--module",
    "esnext",
    "--moduleResolution",
    "bundler",
    "--skipLibCheck",
  ],
  { cwd: root, stdio: "inherit" },
);
writeFileSync(join(out, "package.json"), '{"type":"module"}');
// Node no resuelve imports relativos sin extensión: el puente (lib/bridge) es el único que se importa
// en tiempo de ejecución desde lo que se prueba, así que se le pone su «.js».
for (const dir of [out, join(out, "lib"), join(out, "components")]) {
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    if (!name.endsWith(".js")) continue;
    const p = join(dir, name);
    const src = readFileSync(p, "utf8");
    const fixed = src.replace(/from "((?:\.\.?\/)+(?:lib\/)?bridge)"/g, 'from "$1.js"');
    if (fixed !== src) writeFileSync(p, fixed);
  }
}
for (const s of suites) {
  writeFileSync(join(out, `${s}.test.mjs`), readFileSync(join(root, "scripts", `${s}.test.mjs`), "utf8"));
  execFileSync(process.execPath, [join(out, `${s}.test.mjs`)], { stdio: "inherit" });
}
