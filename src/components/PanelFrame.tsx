import { memo, useRef } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { bringToFront, getLayout, movePanel, resizePanel } from "../store";
import type { Panel } from "../store";

const MIN_W = 280;
const MIN_H = 180;

type DragState = { px: number; py: number; x: number; y: number };
type SizeState = { px: number; py: number; w: number; h: number };

export const PanelFrame = memo(function PanelFrame({
  panel,
  onClose,
  children,
}: {
  panel: Panel;
  onClose: () => void;
  children: ReactNode;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const sizeRef = useRef<SizeState | null>(null);

  const zoom = () => getLayout().view.zoom;

  const onHeaderDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { px: e.clientX, py: e.clientY, x: panel.x, y: panel.y };
  };

  const onHeaderMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    const el = elRef.current;
    if (!d || !el) return;
    const z = zoom();
    el.style.transform = `translate(${(e.clientX - d.px) / z}px, ${
      (e.clientY - d.py) / z
    }px)`;
  };

  const onHeaderUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    const el = elRef.current;
    dragRef.current = null;
    if (!d || !el) return;
    const z = zoom();
    const dx = (e.clientX - d.px) / z;
    const dy = (e.clientY - d.py) / z;
    el.style.transform = "";
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    if (dx !== 0 || dy !== 0) {
      movePanel(panel.id, Math.round(d.x + dx), Math.round(d.y + dy));
    }
  };

  const onResizeDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    sizeRef.current = { px: e.clientX, py: e.clientY, w: panel.w, h: panel.h };
  };

  const onResizeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = sizeRef.current;
    const el = elRef.current;
    if (!s || !el) return;
    const z = zoom();
    el.style.width = `${Math.max(MIN_W, s.w + (e.clientX - s.px) / z)}px`;
    el.style.height = `${Math.max(MIN_H, s.h + (e.clientY - s.py) / z)}px`;
  };

  const onResizeUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = sizeRef.current;
    const el = elRef.current;
    sizeRef.current = null;
    if (!s || !el) return;
    const z = zoom();
    const w = Math.max(MIN_W, s.w + (e.clientX - s.px) / z);
    const h = Math.max(MIN_H, s.h + (e.clientY - s.py) / z);
    el.style.width = "";
    el.style.height = "";
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    resizePanel(panel.id, Math.round(w), Math.round(h));
  };

  return (
    <div
      ref={elRef}
      className="panel"
      style={{ left: panel.x, top: panel.y, width: panel.w, height: panel.h }}
      onPointerDownCapture={() => bringToFront(panel.id)}
    >
      <div
        className="panel-header"
        onPointerDown={onHeaderDown}
        onPointerMove={onHeaderMove}
        onPointerUp={onHeaderUp}
        onPointerCancel={onHeaderUp}
      >
        <span className="panel-glyph">{panel.kind === "team" ? "◈" : ">_"}</span>
        <span className="panel-title">{panel.title}</span>
        <button
          className="panel-close"
          title="Cerrar panel (termina la sesión)"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      <div className="panel-body">{children}</div>
      <div
        className="resize-handle"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
      />
    </div>
  );
});
