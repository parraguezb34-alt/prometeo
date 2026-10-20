import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ago, errMsg } from "../lib/team";
import { SOURCE_ES, errorsClear, errorsFile, errorsList, markErrorsSeen } from "../lib/errors";
import type { ErrEntry } from "../lib/errors";
import { Icon } from "./Icon";

/** Un error como texto, para copiarlo o pasárselo a alguien. */
function asText(e: ErrEntry): string {
  const when = new Date(e.ts_ms).toLocaleString();
  return `[${when}] ${SOURCE_ES[e.source] ?? e.source}: ${e.message}${e.detail ? `\n${e.detail}` : ""}`;
}

/** Ajustes → Errores: lo que ha fallado en Prometeo, del más nuevo al más viejo. */
export function ErrorsPanel({ say }: { say: (text: string, err?: boolean) => void }) {
  const [all, setAll] = useState<ErrEntry[] | null>(null);
  const [src, setSrc] = useState<string>("all");
  const [open, setOpen] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);

  const load = useCallback(() => {
    errorsList()
      .then(setAll)
      .catch(() => setAll([]));
  }, []);

  useEffect(() => {
    load();
    markErrorsSeen();
    const un = listen("lienzo://error", () => {
      load();
      markErrorsSeen();
    });
    return () => {
      void un.then((f) => f()).catch(() => {});
    };
  }, [load]);

  const sources = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of all ?? []) m.set(e.source, (m.get(e.source) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [all]);
  const shown = (all ?? []).filter((e) => src === "all" || e.source === src);

  const copy = (text: string, what: string) =>
    navigator.clipboard.writeText(text).then(
      () => say(`${what} copiado al portapapeles.`),
      () => say("No pude copiarlo."),
    );

  const clear = async () => {
    try {
      await errorsClear();
      setConfirm(false);
      setOpen(null);
      load();
      say("Registro de errores vacío.");
    } catch (e) {
      say(errMsg(e));
    }
  };

  if (!all) return <div className="st-empty-row">Leyendo el registro…</div>;

  return (
    <section className="st-group">
      <div className="st-group-head">
        <div>
          <h4>Registro de errores</h4>
          <p>
            Lo que ha fallado en Prometeo (la interfaz, el hub, el historial o la app en vivo), con la hora
            y el detalle. Se guardan los últimos 500.
          </p>
        </div>
        {all.length > 0 && (
          <div className="er-actions">
            <button className="hs-btn" onClick={() => void copy(shown.map(asText).join("\n\n"), "Registro")}>
              <Icon name="copy" size={13} />
              Copiar todo
            </button>
            {confirm ? (
              <>
                <button className="hs-btn hs-btn-warn" onClick={() => void clear()}>
                  Sí, borrar
                </button>
                <button className="hs-btn" onClick={() => setConfirm(false)}>
                  No
                </button>
              </>
            ) : (
              <button className="hs-btn" onClick={() => setConfirm(true)}>
                <Icon name="trash" size={13} />
                Vaciar
              </button>
            )}
          </div>
        )}
      </div>

      {all.length === 0 ? (
        <div className="st-card er-empty">
          <span className="er-empty-ic">
            <Icon name="check" size={18} />
          </span>
          <div>
            <b>Sin errores</b>
            <p>Cuando algo falle, quedará anotado aquí con la hora y el detalle para poder revisarlo.</p>
          </div>
        </div>
      ) : (
        <>
          {sources.length > 1 && (
            <div className="er-filters" role="radiogroup" aria-label="Filtrar por origen">
              <button role="radio" aria-checked={src === "all"} onClick={() => setSrc("all")}>
                Todos <i>{all.length}</i>
              </button>
              {sources.map(([s, n]) => (
                <button key={s} role="radio" aria-checked={src === s} onClick={() => setSrc(s)}>
                  {SOURCE_ES[s] ?? s} <i>{n}</i>
                </button>
              ))}
            </div>
          )}
          <div className="st-card er-list">
            {shown.map((e, i) => {
              const isOpen = open === i;
              return (
                <div key={`${e.ts_ms}-${i}`} className="er-row" data-open={isOpen ? "1" : "0"}>
                  <button className="er-head" onClick={() => setOpen(isOpen ? null : i)} aria-expanded={isOpen}>
                    <span className="er-src" data-s={e.source}>
                      {SOURCE_ES[e.source] ?? e.source}
                    </span>
                    <span className="er-msg">{e.message}</span>
                    <span className="er-when" title={new Date(e.ts_ms).toLocaleString()}>
                      hace {ago(e.ts_ms)}
                    </span>
                    <Icon name="chev" size={13} />
                  </button>
                  {isOpen && (
                    <div className="er-body">
                      <div className="er-meta">{new Date(e.ts_ms).toLocaleString()}</div>
                      {e.detail ? <pre>{e.detail}</pre> : <div className="er-meta">Sin más detalle.</div>}
                      <button className="hs-btn" onClick={() => void copy(asText(e), "Error")}>
                        <Icon name="copy" size={13} />
                        Copiar
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <button
            className="er-file"
            onClick={() =>
              void errorsFile()
                .then((p) => revealItemInDir(p))
                .catch(() => say("No pude abrir la carpeta del registro."))
            }
          >
            <Icon name="folder" size={13} />
            Ver el archivo del registro
          </button>
        </>
      )}
    </section>
  );
}
