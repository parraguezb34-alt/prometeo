import { memo, useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import {
  base64ToBytes,
  termKill,
  termResize,
  termScrollback,
  termSpawn,
  termWrite,
} from "../lib/pty";
import type { PtyDataEvent, PtyExitEvent } from "../lib/pty";
import { registerScreen } from "../lib/screens";
import { respawnCmd, setPanelSession } from "../store";
import type { Panel } from "../store";

const THEME = {
  background: "#161618",
  foreground: "#f5f5f7",
  cursor: "#e5484d",
  cursorAccent: "#161618",
  selectionBackground: "#48484e",
  black: "#2c2c2e",
  red: "#ff6961",
  green: "#30d158",
  yellow: "#ffb340",
  blue: "#6cb6ff",
  magenta: "#c4b5fd",
  cyan: "#67e8f9",
  white: "#e5e5ea",
  brightBlack: "#8e8e93",
  brightRed: "#fca5a5",
  brightGreen: "#6ee7b7",
  brightYellow: "#fcd34d",
  brightBlue: "#bfdbfe",
  brightMagenta: "#ddd6fe",
  brightCyan: "#a5f3fc",
  brightWhite: "#fafafa",
};

export const TerminalPanel = memo(function TerminalPanel({ panel }: { panel: Panel }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const sessionRef = useRef<string | null>(panel.sessionId);
  const disposedRef = useRef(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    disposedRef.current = false;

    const term = new Terminal({
      fontSize: 13,
      fontFamily:
        '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace',
      cursorBlink: true,
      scrollback: 5000,
      theme: THEME,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      fit.fit();
    } catch {
      /* host not measurable yet */
    }
    const raf = requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        /* host not measurable yet */
      }
    });

    const unlisteners: UnlistenFn[] = [];
    let unregisterScreen = () => {};
    const addUn = async (p: Promise<UnlistenFn>) => {
      const un = await p;
      if (disposedRef.current) un();
      else unlisteners.push(un);
    };

    (async () => {
      // Se escucha la salida ANTES de abrir la sesión. Los agentes (Claude Code, OpenCode…)
      // preguntan al terminal por sus capacidades nada más arrancar y esperan la respuesta; si
      // esa primera salida se perdía por escuchar tarde, se quedaban esperando hasta que alguien
      // abría la terminal y se repintaba el historial.
      const early: PtyDataEvent[] = [];
      let live = false;
      await addUn(
        listen<PtyDataEvent>("pty://data", (e) => {
          if (disposedRef.current) return;
          if (!live) {
            early.push(e.payload);
            return;
          }
          if (e.payload.id === sessionRef.current) {
            term.write(base64ToBytes(e.payload.data));
          }
        }),
      );
      await addUn(
        listen<PtyExitEvent>("pty://exit", (e) => {
          if (!disposedRef.current && e.payload.id === sessionRef.current) {
            term.write("\r\n\x1b[90m[proceso finalizado]\x1b[0m\r\n");
          }
        }),
      );

      let sid = sessionRef.current;
      // Tenía sesión y ya no existe: lienzo se reinició y la terminal se vuelve a abrir.
      const hadSession = !!sid;
      let reattached = false;
      if (sid) {
        // Re-attach to an existing session (frontend reload): repaint scrollback.
        try {
          const b64 = await termScrollback(sid);
          if (disposedRef.current) return;
          term.clear();
          term.write(base64ToBytes(b64));
          reattached = true;
        } catch {
          sid = null; // session no longer exists: spawn a fresh one
        }
      }
      if (!sid) {
        // Al reabrir un agente se retoma la conversación del chat actual (ver respawnCmd).
        const cmd = hadSession ? respawnCmd(panel) : (panel.cmd ?? null);
        const info = await termSpawn(null, term.cols, term.rows, cmd);
        sid = info.id;
        if (disposedRef.current) {
          termKill(sid).catch(() => {});
          return;
        }
        sessionRef.current = sid;
        setPanelSession(panel.id, sid);
      }
      if (disposedRef.current) return;
      // Su pantalla queda a la vista del chat (para contestar sus permisos con botones).
      unregisterScreen = registerScreen(sid, term);
      // Sync the PTY with the real panel size before the agent paints its TUI
      // (OpenCode / Claude render cleanly from the first frame this way).
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
      termResize(sid, term.cols, term.rows).catch(() => {});
      // Lo que el agente ya escribió mientras se abría la sesión (sus preguntas al terminal
      // incluidas): en una sesión nueva se entrega entero; en una re-adjuntada ya iba en el historial.
      if (!reattached) {
        for (const ev of early) {
          if (ev.id === sid) term.write(base64ToBytes(ev.data));
        }
      }
      early.length = 0;
      live = true;
    })().catch((err) => {
      term.write(
        `\r\n\x1b[31m[error al iniciar la terminal: ${String(err)}]\x1b[0m\r\n`,
      );
    });

    const dataSub = term.onData((data) => {
      const sid = sessionRef.current;
      if (sid) termWrite(sid, data).catch(() => {});
    });

    const ro = new ResizeObserver(() => {
      if (host.clientWidth < 40 || host.clientHeight < 40) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      const sid = sessionRef.current;
      if (sid) termResize(sid, term.cols, term.rows).catch(() => {});
    });
    ro.observe(host);

    return () => {
      disposedRef.current = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      dataSub.dispose();
      unlisteners.forEach((u) => u());
      unregisterScreen();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="term-host"
      ref={hostRef}
      onMouseDown={() => termRef.current?.focus()}
    />
  );
});
