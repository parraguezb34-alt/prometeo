// Pone el número de versión antes de compilar: 1.0.<commits>. Si hay cambios sin guardar en git,
// cuenta uno más (el commit que los guardará), así la versión ya no cambia al hacer ese commit.
// Uso: npm run release (lo llama antes de `tauri build`).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

/** Los archivos donde va la versión: cambiarlos no cuenta como «cambios sin guardar». */
export const VERSION_FILES = ["package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock"];

const count = Number(git("rev-list", "--count", "HEAD"));
const dirty = git("status", "--porcelain", "--untracked-files=no", "--", ".", ...VERSION_FILES.map((f) => `:!${f}`)) !== "";
const version = `1.0.${count + (dirty ? 1 : 0)}`;

const setJson = (rel) => {
  const p = join(root, rel);
  const raw = readFileSync(p, "utf8");
  const next = raw.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  if (next !== raw) writeFileSync(p, next);
};
setJson("package.json");
setJson("src-tauri/tauri.conf.json");
{
  const p = join(root, "src-tauri/Cargo.toml");
  const raw = readFileSync(p, "utf8");
  // Solo la de [package] (la primera), no las de las dependencias.
  const next = raw.replace(/^version = "[^"]*"/m, `version = "${version}"`);
  if (next !== raw) writeFileSync(p, next);
}
console.log(`Prometeo ${version}${dirty ? " (con cambios sin guardar)" : ""}`);
