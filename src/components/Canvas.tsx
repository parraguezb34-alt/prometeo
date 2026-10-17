import { useEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  addTeam,
  addTerminal,
  clampZoom,
  getLayout,
  removePanel,
  resetView,
  setView,
  useLayout,
} from "../store";
import { termKill } from "../lib/pty";
import { PanelFrame } from "./PanelFrame";
import { TerminalPanel } from "./TerminalPanel";
import { TeamPanel } from "./TeamPanel";

/** Below this zoom the canvas switches to semantic zoom (LOD) mode. */
const LOD_ZOOM = 0.35;
/** Grid spacing in world units. */
const GRID = 26;

export function Canvas() {
  const layout = useLayout();
  const containerRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{
    px: number;
    py: number;
    vx: number;
    vy: number;
  } | null>(null);
  const [panning, setPanning] = useState(false);

  const view = layout.view;
  const lod = view.zoom < LOD_ZOOM;

  // Wheel: zoom at cursor (over the background), shift+wheel pans.
  // Attached natively to keep preventDefault working (React listeners may be passive).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && target.closest(".panel, .ui-overlay")) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const v = getLayout().view;
      if (e.shiftKey) {
        setView({ ...v, x: v.x - e.deltaY });
        return;
      }
      const factor = Math.exp(-e.deltaY * 0.0018);
      const zoom = clampZoom(v.zoom * factor);
      const k = zoom / v.zoom;
      setView({ zoom, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const isBackground = (target: EventTarget | null) => {
    const el = target as HTMLElement | null;
    return !el || (!el.closest(".panel") && !el.closest(".ui-overlay"));
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 1) return;
    if (!isBackground(e.target)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const v = getLayout().view;
    panRef.current = { px: e.clientX, py: e.clientY, vx: v.x, vy: v.y };
    setPanning(true);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = panRef.current;
    if (!p) return;
    const v = getLayout().view;
    setView({
      ...v,
      x: p.vx + (e.clientX - p.px),
      y: p.vy + (e.clientY - p.py),
    });
  };

  const endPan = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!panRef.current) return;
    panRef.current = null;
    setPanning(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!isBackground(e.target)) return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const v = getLayout().view;
    addTerminal(
      Math.round((e.clientX - rect.left - v.x) / v.zoom),
      Math.round((e.clientY - rect.top - v.y) / v.zoom),
    );
  };

  const zoomAtCenter = (factor: number) => {
    const el = containerRef.current;
    if (!el) return;
    const cx = el.clientWidth / 2;
    const cy = el.clientHeight / 2;
    const v = getLayout().view;
    const zoom = clampZoom(v.zoom * factor);
    const k = zoom / v.zoom;
    setView({ zoom, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k });
  };

  const addAtCenter = () => {
    const el = containerRef.current;
    if (!el) return;
    const v = getLayout().view;
    addTerminal(
      Math.round((el.clientWidth / 2 - v.x) / v.zoom) - 320,
      Math.round((el.clientHeight / 2 - v.y) / v.zoom) - 200,
    );
  };

  const addTeamAtCenter = () => {
    const el = containerRef.current;
    if (!el) return;
    const v = getLayout().view;
    addTeam(
      Math.round((el.clientWidth / 2 - v.x) / v.zoom) - 310,
      Math.round((el.clientHeight / 2 - v.y) / v.zoom) - 235,
    );
  };

  const closePanel = (id: string, sessionId: string | null) => {
    if (sessionId) termKill(sessionId).catch(() => {});
    removePanel(id);
  };

  const lodFont = Math.min(64, Math.max(13, 13 / view.zoom));

  return (
    <div
      ref={containerRef}
      className="canvas"
      data-panning={panning ? "1" : "0"}
      data-lod={lod ? "1" : "0"}
      style={{ "--lod-font": `${lodFont}px` } as CSSProperties}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onDoubleClick={onDoubleClick}
    >
      <div
        className="grid"
        style={{
          backgroundSize: `${GRID * view.zoom}px ${GRID * view.zoom}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
      />
      <div
        className="world"
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
        }}
      >
        {layout.panels.map((p) => (
          <PanelFrame
            key={p.id}
            panel={p}
            onClose={() => closePanel(p.id, p.sessionId)}
          >
            {p.kind === "team" ? (
              <TeamPanel panel={p} />
            ) : (
              <TerminalPanel panel={p} lod={lod} />
            )}
          </PanelFrame>
        ))}
      </div>

      <div className="toolbar ui-overlay">
        <button onClick={addAtCenter} title="Nueva terminal (o doble clic en el lienzo)">
          + Terminal
        </button>
        <button
          onClick={addTeamAtCenter}
          title="Panel del equipo: actividad, tareas y conexión de agentes"
        >
          + Equipo
        </button>
        <button onClick={() => zoomAtCenter(1 / 1.25)} title="Alejar">
          −
        </button>
        <button
          className="zoom-label"
          onClick={() => resetView()}
          title="Restablecer vista (100%)"
        >
          {Math.round(view.zoom * 100)}%
        </button>
        <button onClick={() => zoomAtCenter(1.25)} title="Acercar">
          +
        </button>
      </div>

      <div className="hint">
        Arrastra el fondo para mover · Rueda = zoom · Doble clic = nueva terminal · + Equipo =
        agentes trabajando en conjunto
      </div>
    </div>
  );
}
