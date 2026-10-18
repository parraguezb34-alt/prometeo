// Compila el despachador (src/lib/dispatcher.ts) y corre sus pruebas con Node.
// Uso: npm test
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "node_modules", ".cache", "dispatcher-test");
mkdirSync(out, { recursive: true });

execFileSync(
  process.execPath,
  [
    join(root, "node_modules", "typescript", "bin", "tsc"),
    "src/lib/dispatcher.ts",
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
writeFileSync(join(out, "dispatcher.test.mjs"), readFileSync(join(root, "scripts", "dispatcher.test.mjs"), "utf8"));
execFileSync(process.execPath, [join(out, "dispatcher.test.mjs")], { stdio: "inherit" });
