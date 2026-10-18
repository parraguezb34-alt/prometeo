// Aparta binarios bloqueados del target antes de compilar. En Windows no se
// puede sobrescribir un .exe en uso ("Acceso denegado", os error 5), pero
// renombrarlo sí: los procesos vivos (p. ej. puentes MCP de agentes) siguen
// con su copia y el linker escribe una nueva. Corre como script `pretauri`.
import { closeSync, copyFileSync, existsSync, openSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const names = ["lienzo-mcp.exe", "lienzo.exe", "WebView2Loader.dll"];
const dirs = ["src-tauri/target/debug", "src-tauri/target/release"];

/** ¿Está bloqueado el archivo? (se puede abrir para escritura → libre) */
function locked(path) {
  try {
    closeSync(openSync(path, "r+"));
    return false;
  } catch {
    return true;
  }
}

for (const dir of dirs) {
  for (const name of names) {
    const path = join(root, dir, name);
    if (!existsSync(path) || !locked(path)) continue;
    const stamp = Math.floor(Date.now() / 1000);
    try {
      renameSync(path, `${path}.locked-${stamp}`);
      // Copia de vuelta con el nombre original: sin ella, un build que no regenere el archivo
      // (o una DLL que el linker no reescribe) deja a los agentes sin puente MCP.
      copyFileSync(`${path}.locked-${stamp}`, path);
      console.log(`[unblock] ${dir}/${name} estaba en uso → ${name}.locked-${stamp}`);
    } catch (e) {
      console.warn(`[unblock] no pude apartar ${dir}/${name}: ${e.message}`);
    }
  }
}
