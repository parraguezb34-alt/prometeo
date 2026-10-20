import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { agentColor, agentInitial } from "../lib/team";
import { onInAppAviso } from "../lib/notify";
import type { Aviso } from "../lib/notify";
import { Icon } from "./Icon";
import { PixelFlame } from "./Brand";
import type { IconName } from "./Icon";
import "../avisos.css";

/** Cuánto dura cada aviso a la vista (se para al pasar el ratón). */
const LIFE_MS: Record<string, number> = { ask: 14000, late: 10000, done: 7000, reply: 8000, info: 6000 };
const MAX = 4;

const BADGE: Record<string, IconName | undefined> = { ask: "warn", done: "check", late: "pulse" };

type Live = Aviso & { leaving?: boolean };

/** Una tarjeta de aviso: quién, qué y una línea que se va gastando hasta que se cierra sola. */
function AvisoCard({ a, onOpen, onClose }: { a: Live; onOpen: () => void; onClose: () => void }) {
  const color = a.agent ? agentColor(a.agent) : "var(--accent)";
  const badge = BADGE[a.kind];
  return (
    <div
      className="av-card"
      data-kind={a.kind}
      data-leaving={a.leaving ? "1" : "0"}
      role="status"
      onClick={onOpen}
      onAnimationEnd={(e) => {
        if (e.animationName === "av-out") onClose();
      }}
      style={{ ["--av-c" as string]: color, ["--av-life" as string]: `${LIFE_MS[a.kind] ?? 7000}ms` }}
    >
      <span className="av-avatar" aria-hidden="true">
        {a.agent ? agentInitial(a.agent) : <PixelFlame size={18} />}
        {badge && (
          <i className="av-badge" data-kind={a.kind}>
            <Icon name={badge} size={10} />
          </i>
        )}
      </span>
      <span className="av-text">
        <span className="av-top">
          <span className="av-app">Prometeo</span>
          <span className="av-when">ahora</span>
        </span>
        <b>{a.title}</b>
        {a.body && <span className="av-body">{a.body}</span>}
      </span>
      <button
        className="av-x"
        aria-label="Cerrar aviso"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <Icon name="x" size={12} />
      </button>
      <i
        className="av-life"
        aria-hidden="true"
        onAnimationEnd={(e) => {
          e.stopPropagation();
          if (e.animationName === "av-life") onClose();
        }}
      />
    </div>
  );
}

/** Montón de avisos: añade, cierra con animación de salida y como mucho MAX a la vista. */
function useStack() {
  const [items, setItems] = useState<Live[]>([]);
  const add = useCallback((a: Aviso) => {
    setItems((cur) => {
      const next: Live[] = [...cur.filter((x) => x.id !== a.id), a];
      // Los más viejos se van si hay demasiados.
      const extra = next.filter((x) => !x.leaving).length - MAX;
      if (extra <= 0) return next;
      let n = extra;
      return next.map((x) => (!x.leaving && n-- > 0 ? { ...x, leaving: true } : x));
    });
  }, []);
  /** Primero sale animado; al terminar la salida desaparece. */
  const close = useCallback((id: string) => {
    setItems((cur) => {
      const it = cur.find((x) => x.id === id);
      if (!it) return cur;
      if (it.leaving) return cur.filter((x) => x.id !== id);
      return cur.map((x) => (x.id === id ? { ...x, leaving: true } : x));
    });
  }, []);
  return { items, add, close };
}

/** Avisos dentro de Prometeo (cuando lo estás mirando), arriba a la derecha. */
export function InAppAvisos({ onOpen }: { onOpen: (a: Aviso) => void }) {
  const { items, add, close } = useStack();
  useEffect(() => onInAppAviso(add), [add]);
  if (items.length === 0) return null;
  return (
    <div className="av-stack av-inapp" aria-live="polite">
      {items.map((a) => (
        <AvisoCard
          key={a.id}
          a={a}
          onOpen={() => {
            onOpen(a);
            close(a.id);
          }}
          onClose={() => close(a.id)}
        />
      ))}
    </div>
  );
}

/** La ventanita de avisos de fuera (ver aviso.rs): se ajusta a lo que ocupa y se cierra vacía. */
export function AvisoWindow() {
  const { items, add, close } = useStack();
  const box = useRef<HTMLDivElement>(null);
  const seen = useRef(false);

  useEffect(() => {
    document.documentElement.classList.add("av-window");
    const take = () =>
      invoke<Aviso[]>("aviso_take")
        .then((list) => list.forEach(add))
        .catch(() => {});
    take();
    const un = listen("aviso://poke", take);
    return () => {
      void un.then((f) => f());
    };
  }, [add]);

  useLayoutEffect(() => {
    if (items.length > 0) seen.current = true;
    if (items.length === 0) {
      if (seen.current) void invoke("aviso_close");
      return;
    }
    const h = box.current?.getBoundingClientRect().height ?? 0;
    void invoke("aviso_resize", { height: Math.ceil(h) });
  }, [items]);

  return (
    <div className="av-stack av-outside" ref={box} aria-live="polite">
      {items.map((a) => (
        <AvisoCard
          key={a.id}
          a={a}
          onOpen={() => {
            void invoke("aviso_open", { item: a });
            close(a.id);
          }}
          onClose={() => close(a.id)}
        />
      ))}
    </div>
  );
}

/** El mensaje corto de arriba («Copiado», «No pude…»): entra y sale con su animación. */
export function Toast({ flash, onDismiss }: { flash: { text: string; err?: boolean } | null; onDismiss: () => void }) {
  const [shown, setShown] = useState(flash);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (flash) {
      setShown(flash);
      setLeaving(false);
    } else if (shown) {
      setLeaving(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flash]);
  if (!shown) return null;
  return (
    <div
      className="cc-toast"
      role={shown.err ? "alert" : "status"}
      data-err={shown.err ? "1" : undefined}
      data-leaving={leaving ? "1" : "0"}
      onClick={onDismiss}
      onAnimationEnd={(e) => {
        if (e.animationName === "toast-out") {
          setShown(null);
          setLeaving(false);
        }
      }}
    >
      <span className="cc-toast-ic" aria-hidden="true">
        <Icon name={shown.err ? "warn" : "check"} size={12} />
      </span>
      <span className="cc-toast-text">{shown.text}</span>
    </div>
  );
}
