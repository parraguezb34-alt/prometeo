import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type SyntheticEvent } from "react";

/**
 * Hook para implementar la confirmación por doble clic en cualquier elemento interactivo.
 * Primer clic: arma la confirmación durante `timeoutMs` (por defecto 3 s).
 * Segundo clic mientras está armado: ejecuta `onConfirm`.
 */
export function useConfirm(onConfirm: () => void, timeoutMs = 3000) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  const trigger = (e?: SyntheticEvent) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    if (armed) {
      if (timer.current) window.clearTimeout(timer.current);
      setArmed(false);
      onConfirm();
    } else {
      setArmed(true);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setArmed(false), timeoutMs);
    }
  };

  const reset = () => {
    if (timer.current) window.clearTimeout(timer.current);
    setArmed(false);
  };

  return { armed, trigger, reset };
}

export type ConfirmButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & {
  onConfirm: () => void;
  children?: ReactNode;
  confirmText?: ReactNode;
  timeoutMs?: number;
  armedClassName?: string;
};

/**
 * Botón con confirmación destructiva por doble clic (sin modal).
 * Primer clic: cambia el texto a «¿Seguro? Pulsa otra vez» (o `confirmText`) por 3 s.
 * Segundo clic: ejecuta `onConfirm`.
 */
export function ConfirmButton({
  onConfirm,
  children,
  confirmText = "¿Seguro? Pulsa otra vez",
  timeoutMs = 3000,
  armedClassName = "is-confirming",
  className = "",
  style,
  ...rest
}: ConfirmButtonProps) {
  const { armed, trigger } = useConfirm(onConfirm, timeoutMs);

  return (
    <button
      {...rest}
      type="button"
      className={`${className} ${armed ? armedClassName : ""}`.trim()}
      style={{
        ...style,
        ...(armed ? { color: "var(--err, #f87171)", borderColor: "var(--err, #f87171)", fontWeight: 600 } : {}),
      }}
      onClick={trigger}
      aria-pressed={armed}
      title={armed ? "Pulsa otra vez para confirmar" : rest.title}
    >
      {armed ? confirmText : children}
    </button>
  );
}
