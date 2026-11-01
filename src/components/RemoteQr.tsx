import { useMemo } from "react";
import qrcode from "qrcode-generator";

/** Código QR del enlace de acceso remoto: el iPad lo escanea con la cámara y entra ya con token. */
export function RemoteQr({ text, size = 220 }: { text: string; size?: number }) {
  const { path, n } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
      }
    }
    return { path: d, n: count + 8 };
  }, [text]);
  return (
    <svg
      viewBox={`0 0 ${n} ${n}`}
      width={size}
      height={size}
      role="img"
      aria-label="Código QR del enlace para el iPad"
      shapeRendering="crispEdges"
      style={{ background: "#fff", borderRadius: 8, display: "block" }}
    >
      <path d={path} fill="#000" />
    </svg>
  );
}
