import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { VisibilityTarget } from "./useVisibleInterval";

/**
 * Si la ventana de Prometeo está a la vista. WebView2 deja `document.hidden` en false aunque la
 * ventana de Tauri esté minimizada o escondida en la bandeja, y no avisa con visibilitychange; así
 * que se pregunta a la ventana al cambiar de tamaño (minimizar), al esconderse en la bandeja
 * (app://bandeja), al volver a mostrarla (app://mostrada) y al cambiar de foco.
 */
let winHidden = false;
const listeners = new Set<() => void>();
const docHidden = () => typeof document !== "undefined" && document.hidden;
let last = docHidden();

function emit() {
  const now = docHidden() || winHidden;
  if (now === last) return;
  last = now;
  for (const l of Array.from(listeners)) l();
}

export const windowVisibility: VisibilityTarget = {
  get hidden() {
    return docHidden() || winHidden;
  },
  addEventListener(event, listener) {
    if (event === "visibilitychange") listeners.add(listener);
  },
  removeEventListener(event, listener) {
    if (event === "visibilitychange") listeners.delete(listener);
  },
};

if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
  const w = getCurrentWindow();
  const check = () =>
    void Promise.all([w.isMinimized(), w.isVisible()])
      .then(([min, vis]) => {
        winHidden = min || !vis;
        emit();
      })
      .catch(() => {});
  check();
  void w.onResized(check).catch(() => {});
  void w.onFocusChanged(check).catch(() => {});
  void listen("app://bandeja", check).catch(() => {});
  void listen("app://mostrada", check).catch(() => {});
}
if (typeof document !== "undefined") document.addEventListener("visibilitychange", emit);
