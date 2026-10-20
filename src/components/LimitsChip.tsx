import { useEffect, useState } from "react";
import { agentColor, agentLabel, ago } from "../lib/team";
import { fmtReset, level, windowLabel, worst } from "../lib/limits";
import type { AgentLimits } from "../lib/limits";
import { Icon } from "./Icon";

/** Orden fijo: primero Claude, luego OpenCode y Antigravity. */
const ORDER = ["claude", "opencode", "antigravity", "codex"];
const rank = (a: string) => {
  const i = ORDER.findIndex((k) => a.toLowerCase().includes(k));
  return i < 0 ? 99 : i;
};

const SOURCE = (l: AgentLimits) => (l.exact ? "exacto" : l.note || "estimado");

/**
 * Límites de uso del equipo en la barra superior: una barrita por agente con lo que lleva de su
 * ventana más llena. Al pulsar, el detalle (sesión, semana…) y cuándo se reinicia cada una.
 */
export function LimitsChip({
  limits,
  canRead,
  onRead,
  screens,
}: {
  limits: Record<string, AgentLimits> | undefined;
  /** Agentes cuyo límite se puede leer de su pantalla ahora (Antigravity con /usage). */
  canRead: string[];
  onRead: (agent: string) => void;
  /** Lo que se leyó de la pantalla de cada agente con /usage (para comprobarlo). */
  screens?: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const [, tick] = useState(0);
  // Los «se reinicia en…» avanzan solos mientras el panel está abierto.
  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, [open]);

  const entries = Object.entries(limits ?? {})
    .filter(([, l]) => l.windows.length > 0)
    .sort(([a], [b]) => rank(a) - rank(b));
  const readable = canRead.filter((a) => !entries.some(([k]) => k === a));
  if (entries.length === 0 && readable.length === 0) return null;

  const top = entries.map(([, l]) => worst(l)?.used_pct ?? 0);
  const alarm = top.some((p) => p >= 90) ? "crit" : top.some((p) => p >= 70) ? "warn" : "ok";

  return (
    <div className="lm">
      <button
        className="lm-chip"
        data-level={alarm}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="Límites de uso de los agentes"
      >
        <Icon name="pulse" size={14} />
        {entries.length === 0 ? (
          <span className="lm-chip-txt">Límites</span>
        ) : (
          entries.map(([agent, l]) => {
            const w = worst(l);
            return (
              <span key={agent} className="lm-mini" title={w ? `${agentLabel(agent)}: ${windowLabel(w, l.windows.indexOf(w))} ${Math.round(w.used_pct)}%` : agentLabel(agent)}>
                <i style={{ background: agentColor(agent) }} />
                <span className="lm-bar" data-level={level(w?.used_pct ?? 0)}>
                  <b style={{ width: `${Math.min(100, w?.used_pct ?? 0)}%` }} />
                </span>
              </span>
            );
          })
        )}
      </button>
      {open && (
        <>
          <div className="cc-scrim" data-light="1" onClick={() => setOpen(false)} />
          <div className="lm-pop" role="dialog" aria-label="Límites de uso">
            <div className="lm-pop-head">
              <b>Límites de uso</b>
              <small>Para repartir el trabajo antes de quedarte sin cuota.</small>
            </div>
            {entries.map(([agent, l]) => (
              <section key={agent} className="lm-agent">
                <div className="lm-agent-head">
                  <span className="lm-dot" style={{ background: agentColor(agent) }} />
                  <b>{agentLabel(agent)}</b>
                  <small title={new Date(l.ts_ms).toLocaleString()}>
                    {SOURCE(l)} · hace {ago(l.ts_ms)}
                  </small>
                  {canRead.includes(agent) && (
                    <button className="lm-read" onClick={() => onRead(agent)} title="Leer otra vez su /usage">
                      <Icon name="refresh" size={12} />
                    </button>
                  )}
                </div>
                {l.windows.map((w, i) => (
                  <div key={`${i}-${w.key}`} className="lm-win">
                    <div className="lm-win-top">
                      <span>{windowLabel(w, i)}</span>
                      <b data-level={level(w.used_pct)}>{Math.round(w.used_pct)}%</b>
                    </div>
                    <span className="lm-bar lm-bar-big" data-level={level(w.used_pct)}>
                      <b style={{ width: `${Math.min(100, w.used_pct)}%` }} />
                    </span>
                    {w.resets_at ? <small>Se reinicia {fmtReset(w.resets_at)}</small> : null}
                  </div>
                ))}
                {screens?.[agent] && (
                  <details className="lm-raw">
                    <summary>Ver lo que se leyó de su pantalla</summary>
                    <pre>{screens[agent]}</pre>
                  </details>
                )}
              </section>
            ))}
            {readable.map((agent) => (
              <section key={agent} className="lm-agent">
                <div className="lm-agent-head">
                  <span className="lm-dot" style={{ background: agentColor(agent) }} />
                  <b>{agentLabel(agent)}</b>
                </div>
                <button className="hs-btn" onClick={() => onRead(agent)}>
                  <Icon name="refresh" size={12} />
                  Leer su límite (/usage)
                </button>
              </section>
            ))}
            <p className="lm-foot">
              Claude: exacto, de su barra de estado. OpenCode Go: estimado con el gasto guardado en este equipo
              ($12 cada 5 h, $30 por semana, $60 al mes). Antigravity: se lee de su /usage cuando lo pides.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
