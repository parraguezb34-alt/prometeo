import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Pastilla que se desliza bajo la pestaña elegida de un control segmentado (motion.css,
 * `.cc-vtabs-pill`). Va dentro del contenedor de las pestañas y mide el botón con
 * `aria-selected="true"`; `active` es la pestaña elegida, para volver a medir al cambiar.
 */
export function SlidingPill({ active }: { active: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [box, setBox] = useState<{ x: number; w: number } | null>(null);
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const host = ref.current?.parentElement;
    if (!host) return;
    const measure = () => {
      const b = host.querySelector<HTMLElement>('[aria-selected="true"]');
      if (b) setBox({ x: b.offsetLeft, w: b.offsetWidth });
    };
    measure();
    // Cambia de ancho si carga la letra, aparece un contador o cambia la ventana.
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    host.querySelectorAll("button").forEach((b) => ro.observe(b));
    return () => ro.disconnect();
  }, [active]);

  // La primera vez aparece en su sitio, sin deslizarse desde la izquierda.
  useEffect(() => {
    if (!box || ready) return;
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, [box, ready]);

  return (
    <span
      ref={ref}
      className="cc-vtabs-pill"
      data-ready={ready ? "1" : "0"}
      style={box ? { width: box.w, transform: `translateX(${box.x}px)` } : { visibility: "hidden" }}
      aria-hidden="true"
    />
  );
}
