import { useState } from "react";
import { setRemoteToken } from "../lib/bridge";

/**
 * Acceso remoto (iPad) sin enlace válido: se pega el enlace de Ajustes → Acceso remoto del PC
 * (o solo su token) y se recarga.
 */
export function RemoteGate({ reason }: { reason: "sin-enlace" | "token" }) {
  const [text, setText] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    const raw = text.trim();
    if (!raw || busy) return;
    let t = raw;
    if (/^https?:\/\//i.test(raw)) {
      try {
        const fromUrl = new URL(raw).searchParams.get("t");
        if (!fromUrl) {
          setMsg("Ese enlace no trae la clave (termina sin «?t=…»). Escanea el QR del PC o usa su botón Copiar.");
          return;
        }
        t = fromUrl;
      } catch {
        setMsg("Eso no parece un enlace válido.");
        return;
      }
    }
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch(`/events?t=${encodeURIComponent(t)}`, { method: "HEAD", cache: "no-store" });
      if (res.status === 401) {
        setMsg("El PC no acepta esa clave. Cópiala otra vez desde Ajustes → Acceso remoto de tu Prometeo (no el «Dev»).");
        return;
      }
    } catch {
      setMsg("No llego al PC. Comprueba que Tailscale está encendido en el iPad.");
      return;
    } finally {
      setBusy(false);
    }
    setRemoteToken(t);
    window.location.replace(`/?t=${encodeURIComponent(t)}`);
  };
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 16,
        background: "#111214",
        color: "#e8e8ea",
        fontFamily: "'Inter Variable', system-ui, sans-serif",
      }}
    >
      <div style={{ width: "100%", maxWidth: 440, display: "grid", gap: 12 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>Prometeo · acceso remoto</h1>
        <p style={{ margin: 0, color: "#a9abb3", lineHeight: 1.5 }}>
          {reason === "token"
            ? "El PC no aceptó este enlace: es de otro Prometeo o se cambió el token."
            : "Falta el enlace de acceso."}
        </p>
        <p style={{ margin: 0, lineHeight: 1.5 }}>
          <b>Lo más fácil:</b> en el PC abre Prometeo → Ajustes → Acceso remoto. Abre la Cámara del iPad,
          apunta al código QR y toca el aviso. Entra solo.
        </p>
        <p style={{ margin: 0, color: "#a9abb3", lineHeight: 1.5 }}>O pega aquí el enlace copiado:</p>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void go()}
          placeholder="https://….ts.net/?t=…"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          style={{
            minHeight: 44,
            padding: "0 12px",
            borderRadius: 8,
            border: "1px solid #3a3c44",
            background: "#1b1c20",
            color: "inherit",
            fontSize: 16,
          }}
        />
        {msg && <p style={{ margin: 0, color: "#ffb4a8", lineHeight: 1.5 }}>{msg}</p>}
        <button
          disabled={busy}
          onClick={() => void go()}
          style={{ minHeight: 44, borderRadius: 8, border: 0, background: "#e8e8ea", color: "#111214", fontSize: 16, fontWeight: 600 }}
        >
          {busy ? "Comprobando…" : "Entrar"}
        </button>
      </div>
    </div>
  );
}
