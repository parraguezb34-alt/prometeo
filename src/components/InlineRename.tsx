import { useEffect, useRef, useState } from "react";

/**
 * Campo para renombrar en el sitio: Enter guarda, Esc cancela y salir del campo también guarda.
 * Devuelve el texto nuevo solo si cambió.
 */
export function InlineRename({
  value,
  onDone,
  className = "rn-input",
  maxLength = 80,
  label = "Nuevo nombre",
}: {
  value: string;
  onDone: (next: string | null) => void;
  className?: string;
  maxLength?: number;
  label?: string;
}) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const clean = text.replace(/\s+/g, " ").trim();
    onDone(save && clean && clean !== value ? clean : null);
  };
  return (
    <input
      ref={ref}
      className={className}
      value={text}
      maxLength={maxLength}
      aria-label={label}
      onChange={(e) => setText(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}
