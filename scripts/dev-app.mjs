// Prometeo Dev: compila la versión de desarrollo y la abre, sin tocar el Prometeo instalado.
// Tiene otro nombre e identificador, sus datos en %APPDATA%\lienzo-dev y su propia carpeta de
// compilación (src-tauri/target-dev), así que el instalado ni la ve como actualización ni comparte
// hub, chats ni proyectos con ella.
// Uso: npm run dev:app            (compila y abre)
//      npm run dev:app -- --no-run (solo compila)
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const targetDir = join(root, "src-tauri", "target-dev");
const exe = join(targetDir, "release", "lienzo.exe");
const run = !process.argv.includes("--no-run");

// Si Prometeo Dev está abierto, su exe está bloqueado y no se puede reescribir: se cierra. Solo
// los procesos de target-dev; el Prometeo instalado (y sus agentes) no se tocan.
function closeDev() {
  const ps = `Get-Process lienzo, lienzo-mcp -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*\\target-dev\\*' } | Stop-Process -Force`;
  try {
    execFileSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore" });
  } catch {
    /* no había ninguno */
  }
}

closeDev();
execFileSync(process.execPath, [join(root, "scripts", "unblock-bins.mjs")], { stdio: "inherit", cwd: root });
execFileSync(
  process.execPath,
  [
    join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"),
    "build",
    "--no-bundle",
    "--features",
    "dev",
    "--config",
    join("src-tauri", "tauri.dev.conf.json"),
  ],
  { stdio: "inherit", cwd: root, env: { ...process.env, CARGO_TARGET_DIR: targetDir } },
);

if (!existsSync(exe)) {
  console.error(`No encuentro ${exe} tras compilar.`);
  process.exit(1);
}
console.log(`Prometeo Dev compilado: ${exe}`);
if (run) {
  // Sin las variables del hub de quien lo lanza (una terminal de Prometeo): Prometeo Dev monta el suyo.
  const env = { ...process.env };
  for (const k of ["LIENZO_HUB", "LIENZO_TOKEN", "LIENZO_DATA", "LIENZO_AGENT"]) delete env[k];
  // Solo el proceso Dev expone CDP, y solo en loopback. El instalable normal no hereda este ajuste.
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9333 --remote-debugging-address=127.0.0.1";
  spawn(exe, [], { detached: true, stdio: "ignore", env }).unref();
  console.log("Prometeo Dev abierto. Ábrele una carpeta de pruebas, no un proyecto del Prometeo normal.");
}
