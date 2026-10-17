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

export const projectInfo = (path: string) => invoke<ProjectInfo>("project_info", { path });

export const projectStatus = (path: string) =>
  invoke<GitStatus>("project_status", { path });

export const projectList = (path: string, rel: string) =>
  invoke<DirEntry[]>("project_list", { path, rel });

export const projectRead = (path: string, rel: string) =>
  invoke<FileData>("project_read", { path, rel });

export const projectRecent = (path: string, exts: string[], limit = 40) =>
  invoke<RecentFile[]>("project_recent", { path, exts, limit });

/** "812 B", "4.2 kB", "1.3 MB" */
export function friendlySize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
