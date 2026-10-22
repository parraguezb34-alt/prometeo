import { useEffect, useState } from "react";
import { ago, errMsg } from "../../lib/team";
import { updateApply, updateCheck } from "../../lib/update";
import type { UpdateInfo } from "../../lib/update";
import { Icon } from "../Icon";

/**
 * «Actualizar» arriba a la derecha: aparece cuando hay una versión compilada nueva (se mira cada
 * pocos minutos). Al aceptar, Prometeo se cierra, se instala solo y se vuelve a abrir.
 */
export function UpdateChip({ working, onError }: { working: number; onError: (text: string) => void }) {
  const [upd, setUpd] = useState<UpdateInfo | null>(null);
  const [updAsk, setUpdAsk] = useState(false);
  const [updBusy, setUpdBusy] = useState(false);
  useEffect(() => {
    const check = () => void updateCheck().then(setUpd).catch(() => {});
    check();
    const id = window.setInterval(check, 3 * 60_000);
    return () => window.clearInterval(id);
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

  if (!upd?.available) return null;
  return (
    <div className="cc-upd">
      <button className="cc-upd-btn" onClick={() => setUpdAsk((v) => !v)} title="Hay una versión nueva de Prometeo">
        <Icon name="refresh" size={13} />
        Actualizar
      </button>
      {updAsk && (
        <div className="cc-upd-pop" role="dialog" aria-label="Actualizar Prometeo">
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
