import { useState } from "react";
import { parentDir, projectName } from "../lib/project";
import { Icon } from "./Icon";

export type ProjectItem = { path: string; openTasks?: number };

/**
 * Proyecto en el que trabaja el equipo (una carpeta) y cómo cambiar: a uno reciente, a otra
 * carpeta o a uno nuevo. Cada proyecto guarda sus chats, tareas, memoria y normas.
 */
export function ProjectSwitcher({
  project,
  others,
  busy,
  onSwitch,
  onOpenFolder,
  onCreate,
}: {
  project: string | null;
  others: ProjectItem[];
  busy: boolean;
  onSwitch: (path: string) => void;
  onOpenFolder: () => void;
  onCreate: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const close = () => {
    setOpen(false);
    setNaming(false);
    setName("");
  };

  return (
    <div className="ps">
      <button
        className="ps-btn"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        disabled={busy}
        title={project ? `Proyecto: ${project}` : "Elige la carpeta del proyecto"}
      >
        <Icon name="folder" size={15} />
        <span className="ps-name">{busy ? "Cambiando…" : project ? projectName(project) : "Sin proyecto"}</span>
        <Icon name="chev" size={13} />
      </button>
      {open && (
        <>
          <div className="cc-scrim" data-light="1" onClick={close} />
          <div className="ps-menu" role="menu" aria-label="Proyectos">
            <div className="cc-menu-sep">Proyecto actual</div>
            {project ? (
              <div className="ps-cur" title={project}>
                <Icon name="check" size={14} />
                <span>
                  <b>{projectName(project)}</b>
                  <small>{project}</small>
                </span>
              </div>
            ) : (
              <div className="ps-cur">
                <span>
                  <b>Ninguno</b>
                  <small>Elige una carpeta para empezar</small>
                </span>
              </div>
            )}
            {others.length > 0 && <div className="cc-menu-sep">Cambiar a…</div>}
            {others.map((p) => (
              <button
                key={p.path}
                className="cc-mi"
                role="menuitem"
                title={p.path}
                onClick={() => {
                  close();
                  onSwitch(p.path);
                }}
              >
                <span className="cc-mi-ic">
                  <Icon name="folder" />
                </span>
                <span>
                  <b>{projectName(p.path)}</b>
                  <small>
                    {p.openTasks ? `${p.openTasks} ${p.openTasks === 1 ? "tarea abierta" : "tareas abiertas"} · ` : ""}
                    {parentDir(p.path)}
                  </small>
                </span>
              </button>
            ))}
            <div className="cc-menu-sep">Otro</div>
            <button
              className="cc-mi"
              role="menuitem"
              onClick={() => {
                close();
                onOpenFolder();
              }}
            >
              <span className="cc-mi-ic">
                <Icon name="search" />
              </span>
              <span>
                <b>Abrir otra carpeta…</b>
                <small>Un proyecto que ya tienes en el disco</small>
              </span>
            </button>
            {naming ? (
              <form
                className="ps-new"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!name.trim()) return;
                  onCreate(name.trim());
                  close();
                }}
              >
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Nombre del proyecto"
                  onKeyDown={(e) => e.key === "Escape" && setNaming(false)}
                />
                <button className="cc-btn" type="submit" disabled={!name.trim()}>
                  Crear
                </button>
                <small>Se crea en {project ? parentDir(project) : "la carpeta que elijas"}</small>
              </form>
            ) : (
              <button className="cc-mi" role="menuitem" onClick={() => setNaming(true)}>
                <span className="cc-mi-ic">
                  <Icon name="plus" />
                </span>
                <span>
                  <b>Proyecto nuevo…</b>
                  <small>Una carpeta vacía, con su propio equipo</small>
                </span>
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
