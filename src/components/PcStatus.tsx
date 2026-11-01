import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { invoke, onRemoteLink } from "../lib/bridge";
import type { RemoteLink } from "../lib/bridge";
import "./remote-link.css";

type PcStatus = {
  version: string;
  ram_total_mb: number | null;
  ram_free_mb: number | null;
  disk_free_mb: number | null;
  disk_total_mb: number | null;
  on_ac: boolean | null;
  battery_pct: number | null;
  uptime_s: number | null;
  tailscale: string | null;
  project: string | null;
  warnings: string[];
};

type PcShot = { data_url: string; width: number; height: number; taken_at: number };

const gb = (mb: number | null) => (mb == null ? "—" : `${(mb / 1024).toFixed(1)} GB`);

function uptime(s: number | null): string {
  if (s == null) return "—";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

/**
 * Solo en el iPad: botón «PC» abajo a la izquierda con el estado del PC de casa (memoria, disco,
 * corriente, Tailscale). Se pone ámbar si hay un aviso (poca RAM o disco, sin enchufe).
 */
export function PcStatusChip() {
  const [st, setSt] = useState<PcStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState<RemoteLink>("ok");
  const [at, setAt] = useState(0);
  const [screen, setScreen] = useState(false);

  useEffect(() => onRemoteLink(setLink), []);
  useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.visibilityState === "hidden") return;
      invoke<PcStatus>("pc_status")
        .then((s) => {
          if (!alive) return;
          setSt(s);
          setAt(Date.now());
        })
        .catch(() => {});
    };
    load();
    const id = window.setInterval(load, open ? 10_000 : 60_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [open, link]);

  const warn = (st?.warnings.length ?? 0) > 0;
  const down = link !== "ok";
  const ramPct =
    st?.ram_total_mb && st.ram_free_mb != null ? Math.round((1 - st.ram_free_mb / st.ram_total_mb) * 100) : null;

  return (
    <>
      <button
        className="pcs-chip"
        data-tone={down ? "down" : warn ? "warn" : "ok"}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="Estado del PC"
      >
        <span className="pcs-dot" aria-hidden="true" />
        PC{ramPct != null && !down ? ` · RAM ${ramPct} %` : ""}
      </button>
      {open && (
        <div className="pcs-card" role="dialog" aria-label="Estado del PC">
          <div className="pcs-head">
            <b>Estado del PC</b>
            <button className="pcs-x" onClick={() => setOpen(false)} aria-label="Cerrar">
              ×
            </button>
          </div>
          {down && <p className="pcs-warn">Sin conexión con el PC: los datos pueden estar viejos.</p>}
          {st?.warnings.map((w) => (
            <p className="pcs-warn" key={w}>
              {w}
            </p>
          ))}
          {st ? (
            <dl className="pcs-grid">
              <dt>Memoria libre</dt>
              <dd>
                {gb(st.ram_free_mb)} de {gb(st.ram_total_mb)}
              </dd>
              <dt>Disco del proyecto</dt>
              <dd>
                {gb(st.disk_free_mb)} libres de {gb(st.disk_total_mb)}
              </dd>
              <dt>Corriente</dt>
              <dd>
                {st.on_ac == null ? "—" : st.on_ac ? "Enchufado" : "Con batería"}
                {st.battery_pct != null ? ` · batería ${st.battery_pct} %` : ""}
              </dd>
              <dt>Encendido desde hace</dt>
              <dd>{uptime(st.uptime_s)}</dd>
              <dt>Tailscale</dt>
              <dd>{st.tailscale ?? "no conectado (entras por el propio PC)"}</dd>
              <dt>Prometeo</dt>
              <dd>{st.version}</dd>
            </dl>
          ) : (
            <p className="pcs-muted">Leyendo…</p>
          )}
          <button className="cv-btn pcs-screen-btn" onClick={() => setScreen(true)} disabled={down}>
            Ver pantalla del PC
          </button>
          {at > 0 && <p className="pcs-muted">Actualizado a las {new Date(at).toLocaleTimeString()}</p>}
        </div>
      )}
      {screen && <PcScreen onClose={() => setScreen(false)} />}
    </>
  );
}

/**
 * Visor a pantalla completa con una captura del escritorio del PC (RPC `pc_screenshot`). Se pide
 * al abrir y con «Actualizar»; el PC da como mucho una nueva cada 2 s. Se amplía pellizcando.
 */
function PcScreen({ onClose }: { onClose: () => void }) {
  const [shot, setShot] = useState<PcShot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setBusy(true);
    setErr(null);
    invoke<PcShot>("pc_screenshot")
      .then((s) => setShot(s))
      .catch((e) => setErr(typeof e === "string" ? e : e instanceof Error ? e.message : "No se pudo ver la pantalla."))
      .finally(() => setBusy(false));
  }, []);

  useEffect(load, [load]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return createPortal(
    <div className="cv-lightbox" onClick={onClose} role="dialog" aria-label="Pantalla del PC">
      <div className="cv-lightbox-stage" onClick={(e) => e.stopPropagation()}>
        {shot && !err ? (
          <img key={shot.taken_at} src={shot.data_url} alt="Pantalla del PC" />
        ) : err ? (
          <p className="pcs-screen-msg">{err}</p>
        ) : (
          <span className="cv-lightbox-wait" />
        )}
      </div>
      <div className="cv-lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span className="cv-lightbox-path">
          {shot && !err ? `Pantalla del PC · ${new Date(shot.taken_at).toLocaleTimeString()}` : "Pantalla del PC"}
        </span>
        <button className="cv-btn" onClick={load} disabled={busy}>
          {busy ? "Capturando…" : "Actualizar"}
        </button>
      </div>
      <button className="cv-lightbox-x" onClick={onClose} aria-label="Cerrar">
        ×
      </button>
    </div>,
    document.body,
  );
}
