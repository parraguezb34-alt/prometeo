import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const inTauri = () => "__TAURI_INTERNALS__" in window;

/**
 * Minimizar, maximizar y cerrar, dentro de la barra de Prometeo (la ventana no lleva la barra
 * blanca de Windows). Cerrar la esconde en la bandeja: los agentes siguen trabajando.
 */
export function WindowControls() {
  const [max, setMax] = useState(false);
  useEffect(() => {
    if (!inTauri()) return;
    const w = getCurrentWindow();
    const check = () => void w.isMaximized().then(setMax).catch(() => {});
    check();
    const un = w.onResized(check);
    return () => {
      void un.then((f) => f()).catch(() => {});
    };
  }, []);
  if (!inTauri()) return null;
  const w = getCurrentWindow();
  return (
    <div className="wc" role="group" aria-label="Ventana">
      <button className="wc-btn" onClick={() => void w.minimize()} title="Minimizar" aria-label="Minimizar">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1 5.5h8" />
        </svg>
      </button>
      <button
        className="wc-btn"
        onClick={() => void w.toggleMaximize()}
        title={max ? "Restaurar" : "Maximizar"}
        aria-label={max ? "Restaurar" : "Maximizar"}
      >
        {max ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2.5 2.5V1h6.5v6.5H7.5M1 2.5h6.5V9H1z" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1 1h8v8H1z" />
          </svg>
        )}
      </button>
      <button
        className="wc-btn wc-close"
        onClick={() => void w.close()}
        title="Cerrar (Prometeo sigue en la bandeja, junto al reloj)"
        aria-label="Cerrar"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1 1l8 8M9 1L1 9" />
        </svg>
      </button>
    </div>
  );
}
