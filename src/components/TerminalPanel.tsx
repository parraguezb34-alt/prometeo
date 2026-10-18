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
import { setPanelSession } from "../store";
import type { Panel } from "../store";

const THEME = {
  background: "#09090b",
  foreground: "#e4e4e7",
  cursor: "#fbbf24",
  cursorAccent: "#09090b",
  selectionBackground: "#3f3f46",
  black: "#18181b",
  red: "#f87171",
  green: "#34d399",
  yellow: "#fbbf24",
  blue: "#93c5fd",
  magenta: "#c4b5fd",
  cyan: "#67e8f9",
  white: "#e4e4e7",
  brightBlack: "#71717a",
  brightRed: "#fca5a5",
  brightGreen: "#6ee7b7",
  brightYellow: "#fcd34d",
  brightBlue: "#bfdbfe",
  brightMagenta: "#ddd6fe",
  brightCyan: "#a5f3fc",
  brightWhite: "#fafafa",
};

export const TerminalPanel = memo(function TerminalPanel({
  panel,
  lod,
}: {
  panel: Panel;
  lod: boolean;
}) {
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
    const addUn = async (p: Promise<UnlistenFn>) => {
      const un = await p;
      if (disposedRef.current) un();
      else unlisteners.push(un);
    };

    (async () => {
      let sid = sessionRef.current;
      if (sid) {
        // Re-attach to an existing session (frontend reload): repaint scrollback.
        try {
          const b64 = await termScrollback(sid);
          if (disposedRef.current) return;
          term.clear();
          term.write(base64ToBytes(b64));
        } catch {
          sid = null; // session no longer exists: spawn a fresh one
        }
      }
      if (!sid) {
        const info = await termSpawn(null, term.cols, term.rows, panel.cmd ?? null);
        sid = info.id;
        if (disposedRef.current) {
          termKill(sid).catch(() => {});
          return;
        }
        sessionRef.current = sid;
        setPanelSession(panel.id, sid);
      }
      if (disposedRef.current) return;
      // Sync the PTY with the real panel size before the agent paints its TUI
      // (OpenCode / Claude render cleanly from the first frame this way).
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
      termResize(sid, term.cols, term.rows).catch(() => {});
      await addUn(
        listen<PtyDataEvent>("pty://data", (e) => {
          if (!disposedRef.current && e.payload.id === sessionRef.current) {
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
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When coming back from semantic zoom (LOD), ask xterm to repaint.
  useEffect(() => {
    if (!lod && termRef.current) {
      const term = termRef.current;
      requestAnimationFrame(() => {
        try {
          term.refresh(0, term.rows - 1);
        } catch {
          /* disposed */
        }
      });
    }
  }, [lod]);

  return (
    <div
      className="term-host"
      ref={hostRef}
      onMouseDown={() => termRef.current?.focus()}
    />
  );
});
