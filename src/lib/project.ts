import { invoke } from "@tauri-apps/api/core";

export type ProjectInfo = { root: string; repo: boolean; branch: string };

export type GitFile = { path: string; status: string };

export type GitStatus = {
  repo: boolean;
  branch: string;
  files: GitFile[];
  diff: string;
  truncated: boolean;
};

export type DirEntry = {
  name: string;
  rel: string;
  dir: boolean;
  size: number;
  mtime_ms: number;
};

export type FileData = {
  text: string;
  truncated: boolean;
  binary: boolean;
  size: number;
  mtime_ms: number;
};

export type RecentFile = { rel: string; mtime_ms: number; size: number };

export type TaskDiff = { diff: string; files: GitFile[]; truncated: boolean };

export const projectInfo = (path: string) => invoke<ProjectInfo>("project_info", { path });

export const projectStatus = (path: string) =>
  invoke<GitStatus>("project_status", { path });

export const projectList = (path: string, rel: string) =>
  invoke<DirEntry[]>("project_list", { path, rel });

export const projectRead = (path: string, rel: string) =>
  invoke<FileData>("project_read", { path, rel });

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

/** Diff y estado limitados a las rutas de una tarea. */
export const projectDiffPaths = (path: string, paths: string[]) =>
  invoke<TaskDiff>("project_diff_paths", { path, paths });

/** Confirma (commit) los archivos de una tarea; devuelve la línea del commit. */
export const projectCommitPaths = (path: string, paths: string[], message: string) =>
  invoke<string>("project_commit_paths", { path, paths, message });

/** Revierte los archivos de una tarea al último commit (destructivo). */
export const projectRevertPaths = (path: string, paths: string[]) =>
  invoke<string>("project_revert_paths", { path, paths });

/** "812 B", "4.2 kB", "1.3 MB" */
export function friendlySize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
