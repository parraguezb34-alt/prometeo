import { useState } from "react";
import { setRemoteToken } from "../lib/bridge";

/**
 * Acceso remoto (iPad) sin enlace válido: se pega el enlace de Ajustes → Acceso remoto del PC
 * (o solo su token) y se recarga.
 */
export function RemoteGate({ reason }: { reason: "sin-enlace" | "token" }) {
  const [text, setText] = useState("");
  const go = () => {
    const raw = text.trim();
    if (!raw) return;
    let t = raw;
    try {
      t = new URL(raw).searchParams.get("t") ?? raw;
    } catch {
      /* no es un enlace: es el token tal cual */
    }
    setRemoteToken(t);
    window.location.reload();
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
            ? "El PC no aceptó este enlace (quizá se cambió el token o se apagó el acceso remoto)."
            : "Falta el enlace de acceso."}{" "}
          En el PC abre Prometeo → Ajustes → Acceso remoto, copia el enlace y pégalo aquí.
        </p>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
          placeholder="http://…:47820/?t=…"
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
        <button
          onClick={go}
          style={{ minHeight: 44, borderRadius: 8, border: 0, background: "#e8e8ea", color: "#111214", fontSize: 16, fontWeight: 600 }}
        >
          Entrar
        </button>
      </div>
    </div>
  );
}
