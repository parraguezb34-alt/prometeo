import { invoke } from "./bridge";

export type ProjectInfo = { root: string; repo: boolean; branch: string };

export type RecentFile = { rel: string; mtime_ms: number; size: number };

export const projectInfo = (path: string) => invoke<ProjectInfo>("project_info", { path });

export const projectRecent = (path: string, exts: string[], limit = 40) =>
  invoke<RecentFile[]>("project_recent", { path, exts, limit });

/** Guarda en el proyecto una imagen pegada en el compositor; devuelve su ruta absoluta. */
export const projectSaveImage = (path: string, data: string, ext: string) =>
  invoke<string>("project_save_image", { path, data, ext });

/** Guarda en `.lienzo/adjuntos/` un adjunto (base64) del compositor; devuelve su ruta absoluta. */
export const projectSaveAttachment = (path: string, name: string, data: string) =>
  invoke<string>("project_save_attachment", { path, name, data });

export type Attached = { path: string; name: string; size: number; dir: boolean };

/** Prepara un archivo arrastrado: se pasa tal cual si está en el proyecto, si no se copia. */
export const projectAttachPath = (path: string, src: string) =>
  invoke<Attached>("project_attach_path", { path, src });

/** Crea la carpeta de un proyecto nuevo dentro de `parent`; devuelve su ruta. */
export const projectCreateDir = (parent: string, name: string) =>
  invoke<string>("project_create_dir", { parent, name });

/** Renombra la carpeta del proyecto en el disco (y lo suyo en el hub); devuelve la ruta nueva. */
export const projectRename = (path: string, name: string) => invoke<string>("project_rename", { path, name });

/** El nombre como lo dejará el renombrado («  Mi   web. » → «Mi web»). */
export function cleanFolderName(name: string): string {
  return name.replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
}

/**
 * Lo que Prometeo guarda en este equipo por carpeta (chats, preferencias…: claves
 * «lienzo.algo:<ruta>») se copia a la ruta nueva. Con `move`, además se borra lo de la vieja.
 */
export function copyProjectStorage(from: string, to: string, move: boolean) {
  try {
    const want = projectKey(from);
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("lienzo.")) keys.push(k);
    }
    for (const k of keys) {
      const at = k.indexOf(":");
      if (at < 0 || projectKey(k.slice(at + 1)) !== want) continue;
      const v = localStorage.getItem(k);
      if (v != null) localStorage.setItem(`${k.slice(0, at)}:${to}`, v);
      if (move && projectKey(to) !== want) localStorage.removeItem(k);
    }
  } catch {
    /* sin almacenamiento: no hay nada que mover */
  }
}

/** Clave de una carpeta (sin mayúsculas, con «/», sin barra final), como en el hub. */
export function projectKey(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** «C:\Users\yo\juego» → «juego». */
export function projectName(path: string): string {
  return path.trim().replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

/** Carpeta que contiene a otra («C:\Users\yo\juego» → «C:\Users\yo»). */
export function parentDir(path: string): string {
  const p = path.trim().replace(/[\\/]+$/, "");
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i > 0 ? p.slice(0, i) : p;
}

/** "812 B", "4.2 kB", "1.3 MB" */
export function friendlySize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Borra lo guardado en este equipo para una carpeta (p. ej. una copia que al final no se usó). */
export function dropProjectStorage(path: string) {
  try {
    const want = projectKey(path);
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("lienzo.") && k.includes(":") && projectKey(k.slice(k.indexOf(":") + 1)) === want) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* sin almacenamiento */
  }
}
