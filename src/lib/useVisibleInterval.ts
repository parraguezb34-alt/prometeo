import { useEffect, useRef } from "react";

export type VisibleIntervalFn = () => void;

export interface VisibilityTarget {
  hidden: boolean;
  addEventListener(event: string, listener: () => void): void;
  removeEventListener(event: string, listener: () => void): void;
}

/**
 * Inicia un timer adaptativo según la visibilidad del documento.
 * - visibleMs: cadencia cuando document.hidden es false.
 * - hiddenMs: cadencia cuando document.hidden es true (null = pausa).
 * - al volver a visible: ejecuta fn() inmediatamente y reprograma a visibleMs.
 * Devuelve función de limpieza para cancelar timer y listener.
 */
export function startVisibleInterval(
  fn: VisibleIntervalFn,
  visibleMs: number,
  hiddenMs: number | null = null,
  doc?: VisibilityTarget
): () => void {
  const target = doc ?? (typeof document !== "undefined" ? document : undefined);
  let timerId: ReturnType<typeof setInterval> | null = null;
  let wasHidden = target ? target.hidden : false;

  const stopTimer = () => {
    if (timerId !== null) {
      clearInterval(timerId);
      timerId = null;
    }
  };

  const startTimer = (ms: number) => {
    stopTimer();
    timerId = setInterval(() => {
      try {
        fn();
      } catch (e) {
        console.error("Error executing visible interval timer callback:", e);
      }
    }, ms);
  };

  // Estado inicial
  if (wasHidden) {
    if (hiddenMs !== null && hiddenMs > 0) {
      startTimer(hiddenMs);
    }
  } else {
    if (visibleMs > 0) {
      startTimer(visibleMs);
    }
  }

  const onVisibilityChange = () => {
    const isHidden = target ? target.hidden : false;
    if (wasHidden && !isHidden) {
      wasHidden = false;
      try {
        fn();
      } catch (e) {
        console.error("Error executing visible interval callback on visible:", e);
      }
      stopTimer();
      if (visibleMs > 0) {
        startTimer(visibleMs);
      }
    } else if (!wasHidden && isHidden) {
      wasHidden = true;
      stopTimer();
      if (hiddenMs !== null && hiddenMs > 0) {
        startTimer(hiddenMs);
      }
    }
  };

  if (target && typeof target.addEventListener === "function") {
    target.addEventListener("visibilitychange", onVisibilityChange);
  }

  return () => {
    stopTimer();
    if (target && typeof target.removeEventListener === "function") {
      target.removeEventListener("visibilitychange", onVisibilityChange);
    }
  };
}

/**
 * Hook useVisibleInterval(fn, visibleMs, hiddenMs | null).
 * - hiddenMs=null significa pausa con la ventana oculta.
 * - Usa la última fn mediante un ref.
 * - Escucha visibilitychange y, al volver a visible, ejecuta fn() inmediatamente y reprograma.
 * - Limpia el listener y el timer al desmontar.
 */
export function useVisibleInterval(
  fn: VisibleIntervalFn,
  visibleMs: number | null,
  hiddenMs: number | null = null
): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (visibleMs === null || visibleMs <= 0) return;
    return startVisibleInterval(() => fnRef.current(), visibleMs, hiddenMs);
  }, [visibleMs, hiddenMs]);
}
