import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { agentColor, agentInitial, agentLabel } from "../lib/team";
import { Icon } from "./Icon";
import { STATE_LABEL } from "./TeamModal";
import type { AgentState } from "./TeamModal";

export type Dest = { kind: "team" } | { kind: "agent"; name: string };

/**
 * «Para: …» del compositor: a quién va el mensaje. Un solo botón en vez de una
 * fila de chips; al abrirlo se ve el estado de cada agente (libre, trabajando,
 * espera tu respuesta…) para elegir con conocimiento.
 */
export function DestPicker({
  dest,
  names,
  leader,
  states,
  onChange,
}: {
  dest: Dest;
  names: string[];
  leader: string;
  states: Map<string, AgentState>;
  onChange: (d: Dest) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const item = listRef.current.querySelector<HTMLElement>(`[data-hi="1"]`);
    if (item) {
      item.scrollIntoView({ block: "nearest" });
    }
  }, [open, hi]);
  const options: Dest[] = [{ kind: "team" }, ...names.map((name) => ({ kind: "agent" as const, name }))];
  const current =
    dest.kind === "team"
      ? 0
      : Math.max(
          0,
          options.findIndex((o) => o.kind === "agent" && o.name === dest.name),
        );

  useEffect(() => {
    if (!open) return;
    setHi(current);
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
    // Solo al abrir: el resaltado parte del destino actual.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pick = (d: Dest) => {
    onChange(d);
    setOpen(false);
  };

  const onKey = (e: KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi((h) => (h + 1) % options.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => (h - 1 + options.length) % options.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(options[hi]);
    }
  };

  const label = (d: Dest) => (d.kind === "team" ? "Todo el equipo" : agentLabel(d.name));

  return (
    <div className="dp" ref={ref} onKeyDown={onKey}>
      <button
        className="dp-btn"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="dp-listbox"
        aria-activedescendant={open && hi >= 0 ? `dp-opt-${hi}` : undefined}
        onClick={() => setOpen((o) => !o)}
        title="A quién va el mensaje"
      >
        <span className="dp-pre">Para</span>
        {dest.kind === "team" ? (
          <span className="dp-team">
            <Icon name="users" size={13} />
          </span>
        ) : (
          <span className="dp-av" style={{ "--ac": agentColor(dest.name) } as CSSProperties}>
            {agentInitial(dest.name)}
          </span>
        )}
        <b>{label(dest)}</b>
        <span className="dp-chev">
          <Icon name="chev" size={12} />
        </span>
      </button>
      {open && (
        <div
          ref={listRef}
          id="dp-listbox"
          className="dp-menu"
          role="listbox"
        >
          {options.map((o, i) => {
            const name = o.kind === "agent" ? o.name : "";
            const st = name ? states.get(name) : undefined;
            const sel = i === current;
            return (
              <button
                key={o.kind === "team" ? "@team" : name}
                id={`dp-opt-${i}`}
                role="option"
                aria-selected={sel}
                className="dp-opt"
                data-hi={i === hi ? "1" : "0"}
                onMouseEnter={() => setHi(i)}
                onClick={() => pick(o)}
                style={name ? ({ "--ac": agentColor(name) } as CSSProperties) : undefined}
              >
                {o.kind === "team" ? (
                  <span className="dp-team">
                    <Icon name="users" size={13} />
                  </span>
                ) : (
                  <span className="dp-av" data-state={st}>
                    {agentInitial(name)}
                  </span>
                )}
                <span className="dp-opt-main">
                  <span className="dp-opt-name">
                    {label(o)}
                    {name && name === leader && (
                      <span className="dp-lead">
                        <Icon name="crown" size={11} />
                        Líder
                      </span>
                    )}
                  </span>
                  <span className="dp-opt-sub" data-state={st}>
                    {o.kind === "team"
                      ? "Lo recibe cada agente con su terminal abierta"
                      : st
                        ? STATE_LABEL[st]
                        : "Sin sesión"}
                  </span>
                </span>
                {sel && <Icon name="check" size={13} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
