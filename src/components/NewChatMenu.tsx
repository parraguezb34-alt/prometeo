import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { projectName } from "../lib/project";
import { agentColor, agentInitial, agentLabel } from "../lib/team";
import type { TeamAgent } from "../lib/team";
import { ctxOf } from "./AgentCard";
import { Icon } from "./Icon";

export type NewChatChoice =
  | { kind: "team" }
  | { kind: "agent"; name: string }
  | { kind: "handover" }
  /** Chat del equipo en otra carpeta (se elige en el explorador). */
  | { kind: "folder" }
  /** Chat del equipo en un proyecto nuevo (carpeta vacía con ese nombre). */
  | { kind: "newproject"; name: string };

function NewProjectForm({
  name,
  setName,
  onSubmit,
  onCancel,
}: {
  name: string;
  setName: (v: string) => void;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  return (
    <form
      className="ps-new"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSubmit(name.trim());
      }}
    >
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Nombre del proyecto"
        aria-label="Nombre del proyecto"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <button className="cc-btn" type="submit" disabled={!name.trim()}>
        Crear
      </button>
    </form>
  );
}

/** Menú de "Nuevo chat": con el equipo, el líder, un agente en privado o desde un relevo. */
export function NewChatMenu({
  agents,
  leader,
  collapsed,
  project,
  onPick,
  onClose,
}: {
  agents: TeamAgent[];
  leader: string;
  collapsed: boolean;
  project: string | null;
  onPick: (choice: NewChatChoice) => void;
  onClose: () => void;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (naming) {
          setNaming(false);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [naming, onClose]);

  return (
    <>
      <div className="cc-scrim" data-light="1" onClick={onClose} />
      {naming ? (
        <div className="cc-menu" data-collapsed={collapsed ? "1" : "0"} role="dialog" aria-label="Crear proyecto nuevo">
          <div className="cc-menu-sep">Crear proyecto nuevo</div>
          <NewProjectForm
            name={name}
            setName={setName}
            onSubmit={(n) => onPick({ kind: "newproject", name: n })}
            onCancel={() => setNaming(false)}
          />
        </div>
      ) : (
        <div className="cc-menu" data-collapsed={collapsed ? "1" : "0"} role="menu" aria-label="Nuevo chat">
          {project && <div className="cc-menu-sep">En {projectName(project)}</div>}
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

          <div className="cc-menu-sep">En otro sitio</div>
          <button className="cc-mi" role="menuitem" onClick={() => onPick({ kind: "folder" })}>
            <span className="cc-mi-ic">
              <Icon name="folder" />
            </span>
            <span>
              <b>En otra carpeta…</b>
              <small>Los agentes se reabren allí, con sus tareas y memoria</small>
            </span>
          </button>
          <button className="cc-mi" role="menuitem" onClick={() => setNaming(true)}>
            <span className="cc-mi-ic">
              <Icon name="plus" />
            </span>
            <span>
              <b>En un proyecto nuevo…</b>
              <small>Carpeta vacía junto a la actual</small>
            </span>
          </button>

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
      )}
    </>
  );
}
