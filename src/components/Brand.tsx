import "@fontsource/silkscreen/700.css";

// Marca de Prometeo: la llama de píxel y el nombre en letras arcade con relieve. El icono de la
// app (src-tauri/icons/prometeo.svg) es la misma llama sobre el cuadrado grafito.

/** La llama, fila a fila: X rojo, O naranja, W amarillo, D base oscura. */
const FLAME = [
  "....X....",
  "....XX...",
  "...XXX...",
  "...XXXX..",
  "..XXXXX..",
  ".XXXXXXX.",
  ".XXXOXXX.",
  "XXXOOOXXX",
  "XXOOWOOXX",
  "XXOWWWOXX",
  ".XXOWOXX.",
  "..DDDDD..",
];
const FILL: Record<string, string> = { X: "#e5484d", O: "#ff8a4c", W: "#ffd27a", D: "#9e2a31" };

const PIXELS = FLAME.flatMap((row, y) =>
  [...row].flatMap((ch, x) => (FILL[ch] ? [{ x, y, fill: FILL[ch] }] : [])),
);

/** La llama sola (9 × 12 píxeles), al tamaño que se pida. */
export function PixelFlame({ size = 24 }: { size?: number }) {
  return (
    <svg width={(size * 9) / 12} height={size} viewBox="0 0 9 12" shapeRendering="crispEdges" aria-hidden="true">
      {PIXELS.map((p) => (
        <rect key={`${p.x}-${p.y}`} x={p.x} y={p.y} width="1.02" height="1.02" fill={p.fill} />
      ))}
    </svg>
  );
}

/** Icono de la app: la llama sobre el cuadrado grafito. */
export function BrandIcon({ size = 28 }: { size?: number }) {
  return (
    <span className="br-icon" style={{ width: size, height: size }} aria-hidden="true">
      <PixelFlame size={Math.round(size * 0.66)} />
    </span>
  );
}

/** «PROMETEO» en letras de píxel con relieve rojo (tres capas por detrás). */
export function BrandWordmark({ height = 20 }: { height?: number }) {
  return (
    <svg className="br-word" height={height} viewBox="0 0 121 20" role="img" aria-label="Prometeo">
      <defs>
        <linearGradient id="br-hot" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffb36b" />
          <stop offset=".45" stopColor="#ff5d62" />
          <stop offset="1" stopColor="#d63a42" />
        </linearGradient>
      </defs>
      <g fontFamily="Silkscreen, monospace" fontWeight="700" fontSize="17">
        <text x="0" y="15" fill="#5c161b" transform="translate(2.4 2.4)">PROMETEO</text>
        <text x="0" y="15" fill="#7d1f25" transform="translate(1.6 1.6)">PROMETEO</text>
        <text x="0" y="15" fill="#a12a31" transform="translate(0.8 0.8)">PROMETEO</text>
        <text x="0" y="15" fill="url(#br-hot)">PROMETEO</text>
      </g>
    </svg>
  );
}
