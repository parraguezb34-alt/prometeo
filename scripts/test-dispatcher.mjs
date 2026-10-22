// Compila las piezas puras del frontend (despachador y adjuntos) y corre sus pruebas con Node.
// Uso: npm test
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "node_modules", ".cache", "dispatcher-test");
mkdirSync(out, { recursive: true });

const suites = ["dispatcher", "stall", "attach", "notices", "prompts", "markdown", "limits", "research", "submit", "schedule", "viewer"];

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
    "src/components/Markdown.tsx",
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
for (const s of suites) {
  writeFileSync(join(out, `${s}.test.mjs`), readFileSync(join(root, "scripts", `${s}.test.mjs`), "utf8"));
  execFileSync(process.execPath, [join(out, `${s}.test.mjs`)], { stdio: "inherit" });
}
