import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { errMsg } from "../lib/team";
import type { TeamEvent } from "../lib/team";
import { appDetect, appStart, appStatus, appStop, fixRequest } from "../lib/devapp";
import type { AppDetect, AppStatus } from "../lib/devapp";
import { projectKey } from "../lib/project";
import { PreviewTab } from "./PreviewTab";
import { Icon } from "./Icon";
import "../history.css";

/**
 * «App»: el proyecto arrancado y a la vista (su `npm run dev`, o sus páginas servidas), y sus
 * archivos: páginas, PDF, Word, Excel, PowerPoint, imágenes, vídeo… (ver PreviewTab).
 */
export function AppTab({
  project,
  events,
  openRel,
  onChooseProject,
  onAsk,
  onSay,
}: {
  project: string | null;
  events: TeamEvent[];
  /** Archivo a abrir (un enlace del chat o del historial). */
  openRel: string | null;
  onChooseProject: () => void;
  /** Manda un mensaje al equipo (para pedir que arreglen la app). */
  onAsk: (text: string) => void;
  onSay: (text: string, err?: boolean) => void;
}) {
  const [mode, setMode] = useState<"app" | "file">(openRel ? "file" : "app");
  const [det, setDet] = useState<AppDetect | null>(null);
  const [st, setSt] = useState<AppStatus | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (openRel) setMode("file");
  }, [openRel]);

  useEffect(() => {
    setDet(null);
    if (project) appDetect(project).then(setDet).catch(() => setDet(null));
  }, [project]);
  // Sin nada que arrancar, lo útil son los archivos.
  useEffect(() => {
    if (det?.kind === "none" && !st?.running) setMode("file");
  }, [det?.kind, st?.running]);

  const poll = useCallback(() => {
    appStatus()
      .then(setSt)
      .catch(() => {});
  }, []);

  // Más a menudo mientras arranca; luego basta con vigilar que siga viva.
  const starting = !!st?.running && !st.url;
  useEffect(() => {
    poll();
    const id = window.setInterval(poll, starting ? 700 : 2500);
    return () => window.clearInterval(id);
  }, [poll, starting]);

  // Una web suelta no se recarga sola: se recarga cuando el equipo termina algo.
  const lastDone = events.find((e) => e.kind === "task" && /hecha|aprobada|entregada/.test(e.text))?.seq;
  const firstDone = useRef(lastDone);
  useEffect(() => {
    if (st?.kind === "static" && lastDone !== firstDone.current) setReload((n) => n + 1);
    firstDone.current = lastDone;
  }, [lastDone, st?.kind]);

  useEffect(() => {
    if (showLog && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [showLog, st?.log.length]);

  const mine = !!st && !!project && projectKey(st.project) === projectKey(project);
  const running = mine && st!.running;
  const url = mine ? st!.url : null;
  const failed = mine && !st!.running && st!.exit != null && st!.exit !== 0;

  const start = async () => {
    if (!project) return;
    setBusy(true);
    try {
      setSt(await appStart(project));
      setShowLog(false);
    } catch (e) {
      onSay(errMsg(e), true);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await appStop();
      poll();
    } finally {
      setBusy(false);
    }
  };

  const log = mine ? st!.log : [];
  const logView = (
    <pre className="ap-log" ref={logRef} aria-label="Consola de la app">
      {log.length ? log.join("\n") : "Sin salida todavía."}
    </pre>
  );

  let body;
  if (!project) {
    body = (
      <div className="ap-empty">
        <h3>Sin proyecto</h3>
        Elige la carpeta del proyecto para poder arrancarlo aquí.
        <button className="hs-btn" onClick={onChooseProject}>
          Elegir carpeta
        </button>
      </div>
    );
  } else if (url) {
    body = (
      <>
        <iframe
          key={`${url}|${reload}`}
          className="ap-frame"
          src={url}
          title="Tu app"
          allow="autoplay; fullscreen; gamepad; clipboard-write; xr-spatial-tracking"
        />
        {showLog && logView}
      </>
    );
  } else if (running) {
    body = (
      <>
        <div className="ap-empty">
          <h3>Arrancando…</h3>
          <span>
            Ejecutando <code>{st!.cmd}</code>. En cuanto diga su dirección, aparece aquí.
          </span>
        </div>
        {logView}
      </>
    );
  } else if (failed) {
    body = (
      <>
        <div className="ap-empty">
          <h3>La app se paró</h3>
          <span>
            <code>{st!.cmd}</code> terminó con un error (código {st!.exit}). Abajo está lo que dijo.
          </span>
          <div className="ap-empty-row">
            <button className="hs-btn hs-btn-go" onClick={() => onAsk(fixRequest(st!.cmd, st!.log))}>
              Pedir al equipo que lo arregle
            </button>
            <button className="hs-btn" onClick={() => void start()} disabled={busy}>
              <Icon name="play" size={13} />
              Probar otra vez
            </button>
          </div>
        </div>
        {logView}
      </>
    );
  } else if (det?.kind === "none") {
    body = (
      <div className="ap-empty">
        <h3>Aún no hay nada que arrancar</h3>
        Este proyecto no tiene un <code>package.json</code> con «dev» o «start», ni una página
        <code>.html</code>. Cuando el equipo cree la app, podrás verla aquí.
      </div>
    );
  } else {
    body = (
      <div className="ap-empty">
        <h3>Tu app, aquí dentro</h3>
        <span>
          {det?.kind === "static" ? (
            <>
              Se abrirá <code>{det.cmd}</code> con un servidor local, y se recarga cuando el equipo
              termina una tarea.
            </>
          ) : det ? (
            <>
              Se ejecuta <code>{det.install ? `npm install && ${det.cmd}` : det.cmd}</code> en la carpeta del
              proyecto. Los cambios de los agentes se ven al momento.
            </>
          ) : (
            "Mirando cómo se arranca…"
          )}
        </span>
        <button className="hs-btn hs-btn-go" onClick={() => void start()} disabled={busy || !det}>
          <Icon name="play" size={13} />
          Arrancar
        </button>
        {mine && st!.exit === 0 && <small>La última vez terminó sin errores.</small>}
      </div>
    );
  }

  return (
    <div className="ap">
      <div className="ap-bar">
        <div className="ap-seg" role="tablist">
          <button role="tab" aria-selected={mode === "app"} data-on={mode === "app" ? "1" : "0"} onClick={() => setMode("app")}>
            App
          </button>
          <button
            role="tab"
            aria-selected={mode === "file"}
            data-on={mode === "file" ? "1" : "0"}
            onClick={() => setMode("file")}
            title="Ver archivos: web, Markdown, PDF, Word, Excel, PowerPoint, imágenes, vídeo…"
          >
            {openRel ? openRel.split("/").pop() : "Archivos"}
          </button>
        </div>
        {mode === "app" && (
          <>
            <span className="ap-state">
              <span className="ap-led" data-s={url ? "on" : running ? "wait" : failed ? "err" : "off"} />
              {url ? <code title={url}>{url}</code> : running ? "Arrancando…" : failed ? "Parada con error" : "Parada"}
            </span>
            <span className="ap-spacer" />
            {url && (
              <>
                <button className="ap-icon" onClick={() => setReload((n) => n + 1)} title="Recargar" aria-label="Recargar">
                  <Icon name="refresh" size={15} />
                </button>
                <button
                  className="ap-icon"
                  onClick={() => void openUrl(url).catch((e) => onSay(errMsg(e), true))}
                  title="Abrir en el navegador"
                  aria-label="Abrir en el navegador"
                >
                  <Icon name="external" size={15} />
                </button>
              </>
            )}
            {mine && (
              <button
                className="ap-icon"
                data-on={showLog ? "1" : "0"}
                onClick={() => setShowLog((v) => !v)}
                title="Ver la consola"
                aria-label="Ver la consola"
              >
                <Icon name="term" size={15} />
              </button>
            )}
            {/* Arrancar está en el centro; aquí solo Parar (un único botón rojo a la vista). */}
            {running && (
              <button className="hs-btn" onClick={() => void stop()} disabled={busy}>
                <Icon name="stop" size={12} />
                Parar
              </button>
            )}
          </>
        )}
      </div>
      {mode === "file" ? (
        <PreviewTab project={project} events={events} openRel={openRel} onChooseProject={onChooseProject} />
      ) : (
        <div className="ap-body">{body}</div>
      )}
    </div>
  );
}
