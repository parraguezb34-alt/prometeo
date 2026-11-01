import "../keybar.css";
import { invoke } from "../lib/bridge";

const KEYS = [
  { label: "Esc", data: "\x1b" },
  { label: "Tab", data: "\t" },
  { label: "⇧Tab", data: "\x1b[Z" },
  { label: "←", data: "\x1b[D", aria: "Flecha izquierda" },
  { label: "↑", data: "\x1b[A", aria: "Flecha arriba" },
  { label: "↓", data: "\x1b[B", aria: "Flecha abajo" },
  { label: "→", data: "\x1b[C", aria: "Flecha derecha" },
  { label: "Ctrl+C", data: "\x03" },
  { label: "Ctrl+D", data: "\x04" },
  { label: "Enter", data: "\r" },
  { label: "/", data: "/" },
];

export function KeyBar({ sessionId }: { sessionId: string | null }) {
  if (!sessionId) return null;

  return (
    <div className="term-keybar" role="toolbar" aria-label="Teclas especiales de terminal">
      {KEYS.map(({ label, data, aria }) => (
        <button
          key={label}
          type="button"
          aria-label={aria ?? label}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void invoke<void>("term_write", { id: sessionId, data }).catch(() => {});
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
