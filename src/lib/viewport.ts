/**
 * Teclado en pantalla del iPad: Safari no encoge la página al sacar el teclado, solo la «vista
 * visible» (visualViewport), así que la caja de texto y Enviar quedaban debajo del teclado.
 *
 * Aquí se mide cuánto tapa el teclado y se publica en la variable CSS `--kb-inset` (px) del
 * <html>, más `data-kb="open"` mientras está abierto. chat.css acorta #root con ella y la barra de
 * teclas especiales (#235) se pega encima usando la misma variable. En PC (ratón) siempre es 0.
 */

let inset = 0;
let started = false;

/** Lo que tapa ahora el teclado, en px (0 si está cerrado o no es táctil). */
export function getKbInset(): number {
  return inset;
}

function isTouch(): boolean {
  return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}

/** Cálculo puro (exportado para pruebas): ignora el zoom por pellizco y valores minúsculos. */
export function computeInset(innerHeight: number, vvHeight: number, vvOffsetTop: number, scale = 1): number {
  if (scale > 1.01) return 0; // con zoom la vista visible también encoge: no es el teclado
  const v = Math.round(innerHeight - (vvHeight + vvOffsetTop));
  return v > 40 ? v : 0; // barras de Safari y redondeos no cuentan como teclado
}

function apply(next: number) {
  const root = document.documentElement;
  const opened = next > 0 && inset === 0;
  inset = next;
  root.style.setProperty("--kb-inset", `${next}px`);
  if (next > 0) root.dataset.kb = "open";
  else delete root.dataset.kb;
  if (next > 0) {
    // Safari desplaza la página para enseñar el campo; con #root ya acortado sobra: se deshace.
    if (window.scrollY !== 0) window.scrollTo(0, 0);
    if (opened) {
      const el = document.activeElement;
      if (el instanceof HTMLElement && el.matches("textarea, input, [contenteditable]")) {
        requestAnimationFrame(() => el.scrollIntoView({ block: "nearest" }));
      }
    }
  }
}

/** Arranca la medición (una vez). En PC deja `--kb-inset: 0px` y no escucha nada. */
export function initViewport(): void {
  if (started) return;
  started = true;
  document.documentElement.style.setProperty("--kb-inset", "0px");
  const vv = window.visualViewport;
  if (!vv || !isTouch()) return;
  let raf = 0;
  const measure = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const next = computeInset(window.innerHeight, vv.height, vv.offsetTop, vv.scale);
      if (next !== inset) apply(next);
    });
  };
  vv.addEventListener("resize", measure);
  vv.addEventListener("scroll", measure);
  window.addEventListener("orientationchange", measure);
  document.addEventListener("focusout", () => setTimeout(measure, 120));
  measure();
}
