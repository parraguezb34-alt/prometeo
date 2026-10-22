import { invoke } from "@tauri-apps/api/core";

/** ¿Hay una versión de Prometeo recién compilada distinta de la que corre? (ver updater.rs) */
export type UpdateInfo = { available: boolean; setup: string; built_ms: number; reason: string };

export const updateCheck = () => invoke<UpdateInfo>("update_check");
/** Cierra Prometeo, instala la versión nueva en silencio y lo vuelve a abrir. */
export const updateApply = () => invoke<void>("update_apply");
