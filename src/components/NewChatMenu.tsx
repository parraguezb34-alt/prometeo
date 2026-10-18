import type { CSSProperties } from "react";
import { agentColor, agentInitial, agentLabel } from "../lib/team";
import type { TeamAgent } from "../lib/team";
import { ctxOf } from "./AgentCard";
import { Icon } from "./Icon";

export type NewChatChoice =
  | { kind: "team" }
  | { kind: "agent"; name: string }
  | { kind: "handover" };

/** Menú de "Nuevo chat": con el equipo, el líder, un agente en privado o desde un relevo. */
export function NewChatMenu({
  agents,
  leader,
  collapsed,
  onPick,
  onClose,
}: {
  agents: TeamAgent[];
  leader: string;
  collapsed: boolean;
  onPick: (choice: NewChatChoice) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="cc-scrim" data-light="1" onClick={onClose} />
      <div className="cc-menu" data-collapsed={collapsed ? "1" : "0"} role="menu" aria-label="Nuevo chat">
        <button className="cc-mi" role="menuitem" onClick={() => onPick({ kind: "team" })}>
          <span className="cc-mi-ic">
            <Icon name="users" />
          </span>
          <span>
            <b>Con todo el equipo</b>
            <small>Misión para @equipo, en plan o directo</small>
          </span>
        </button>
        <button
          className="cc-mi"
          role="menuitem"
          disabled={!leader}
          onClick={() => leader && onPick({ kind: "agent", name: leader })}
        >
          <span className="cc-mi-ic" style={{ color: "var(--warn)" }}>
            <Icon name="crown" />
          </span>
          <span>
            <b>Con el líder</b>
            <small>{leader ? `${agentLabel(leader)} reparte el trabajo` : "Aún no hay líder elegido"}</small>
          </span>
        </button>

        {agents.length > 0 && <div className="cc-menu-sep">Privado con…</div>}
        {agents.map((a) => {
          const ctx = ctxOf(a);
          return (
            <button
              key={a.session_id}
              className="cc-mi"
              role="menuitem"
              onClick={() => onPick({ kind: "agent", name: a.name })}
            >
              <span className="cc-agav" style={{ "--ac": agentColor(a.name) } as CSSProperties}>
                {agentInitial(a.name)}
              </span>
              <span>
                <b>{agentLabel(a.name)}</b>
                <small>{ctx ? `${ctx.pct}% de contexto` : a.online ? "en línea" : "sin sesión viva"}</small>
              </span>
            </button>
          );
        })}

        <div className="cc-menu-sep">Retomar</div>
        <button className="cc-mi" role="menuitem" onClick={() => onPick({ kind: "handover" })}>
          <span className="cc-mi-ic">
            <Icon name="book" />
          </span>
          <span>
            <b>Desde un relevo</b>
            <small>Continúa una tarea con su memoria</small>
          </span>
        </button>
      </div>
    </>
  );
}
