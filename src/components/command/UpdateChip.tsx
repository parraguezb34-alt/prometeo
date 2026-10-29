import { useEffect, useRef, useState } from "react";
import { ago, errMsg } from "../../lib/team";
import { appAbout, updateApply, updateCheck } from "../../lib/update";
import type { UpdateInfo } from "../../lib/update";
import { Icon } from "../Icon";

/**
 * «Actualizar» arriba a la derecha: aparece cuando hay una versión compilada nueva. Al aceptar, Prometeo se cierra, se instala solo y se vuelve a abrir.
 */
export function UpdateChip({ working, onError }: { working: number; onError: (text: string) => void }) {
  const [upd, setUpd] = useState<UpdateInfo | null>(null);
  const [updAsk, setUpdAsk] = useState(false);
  const [updBusy, setUpdBusy] = useState(false);
  const [dev, setDev] = useState(false);
  const [checkErr, setCheckErr] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!updAsk) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setUpdAsk(false);
    };
    const onClick = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setUpdAsk(false);
      }
    };
    window.addEventListener("keydown", onKey);
    const timer = window.setTimeout(() => {
      window.addEventListener("mousedown", onClick);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [updAsk]);
  useEffect(() => {
    void appAbout()
      .then((a) => setDev(!!a.dev))
      .catch(() => {});
  }, []);

  const check = () => {
    setChecking(true);
    updateCheck()
      .then((u) => {
        setUpd(u);
        setCheckErr(null);
      })
      .catch((e) => {
        setCheckErr(errMsg(e) || "Error al comprobar");
      })
      .finally(() => {
        setChecking(false);
      });
  };

  // Se mira al abrir, cada 45 s y al volver a la ventana (es solo comparar fechas de archivos).
  useEffect(() => {
    check();
    const id = window.setInterval(check, 45_000);
    window.addEventListener("focus", check);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", check);
    };
  }, []);
  const applyUpdate = async () => {
    setUpdBusy(true);
    try {
      await updateApply();
    } catch (e) {
      setUpdBusy(false);
      onError(errMsg(e));
    }
  };

  // Prometeo Dev no se actualiza (se recompila con npm run dev:app): en su lugar, su etiqueta.
  if (dev)
    return (
      <span className="cc-dev" title="Prometeo Dev: la versión de desarrollo, con sus datos aparte (%APPDATA%\lienzo-dev). Úsala con carpetas de prueba.">
        DEV
      </span>
    );
  if (checkErr && !upd?.available) {
    return (
      <div className="cc-upd">
        <button
          className="cc-upd-btn"
          style={{
            color: "var(--warn)",
            background: "color-mix(in srgb, var(--warn) 14%, transparent)",
          }}
          onClick={check}
          disabled={checking}
          title={`No se pudo comprobar si hay actualizaciones (${checkErr}). Clic para reintentar.`}
          aria-label="Reintentar comprobación de actualizaciones"
        >
          <Icon name="refresh" size={12} />
          {checking ? "Comprobando…" : "Sin comprobar"}
        </button>
      </div>
    );
  }
  if (!upd?.available) return null;
  return (
    <div className="cc-upd">
      <button className="cc-upd-btn" onClick={() => setUpdAsk((v) => !v)} title="Hay una versión nueva de Prometeo">
        <Icon name="refresh" size={13} />
        Actualizar
      </button>
      {updAsk && (
        <div ref={popRef} className="cc-upd-pop" role="dialog" aria-label="Actualizar Prometeo">
          <b>Prometeo {upd.version || "nuevo"} está listo</b>
          <p>
            Compilada hace {ago(upd.built_ms)}. Prometeo se cierra, se instala solo y se vuelve a abrir en unos
            segundos. Las terminales de los agentes se reabren retomando su conversación.
          </p>
          {working > 0 && (
            <p className="cc-upd-warn">
              {working === 1 ? "Hay 1 agente trabajando" : `Hay ${working} agentes trabajando`}: se cortará lo que
              esté haciendo en este momento.
            </p>
          )}
          <div className="cc-upd-row">
            <button className="hs-btn hs-btn-go" disabled={updBusy} onClick={() => void applyUpdate()}>
              {updBusy ? "Actualizando…" : "Actualizar ahora"}
            </button>
            <button className="hs-btn" onClick={() => setUpdAsk(false)}>
              Luego
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
