import { useEffect, useState } from "react";
import { onRemoteLink, reconnectNow } from "../lib/bridge";
import type { RemoteLink } from "../lib/bridge";
import "./remote-link.css";

/**
 * Franja del iPad cuando se pierde el PC: «Reconectando…» mientras se reintenta solo y
 * «Sin conexión con el PC» (con «Reintentar») si dura. Al volver desaparece y la interfaz
 * vuelve a pedir el estado entero (bridge.ts).
 */
export function RemoteLinkBar() {
  const [link, setLink] = useState<RemoteLink>("ok");
  useEffect(() => onRemoteLink(setLink), []);
  if (link === "ok") return null;
  const offline = link === "offline";
  return (
    <div className="rl-bar" data-state={link} role="status" aria-live="polite">
      <span className="rl-dot" aria-hidden="true" />
      <span className="rl-txt">
        {offline
          ? "Sin conexión con el PC. Revisa que Tailscale esté encendido en el iPad y que el PC siga con Prometeo abierto."
          : "Reconectando con el PC…"}
      </span>
      {offline && (
        <button className="rl-btn" onClick={reconnectNow}>
          Reintentar
        </button>
      )}
    </div>
  );
}
