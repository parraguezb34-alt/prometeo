import { useState } from "react";
import { cleanFolderName, parentDir, projectName } from "../lib/project";
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
  onRename,
}: {
  project: string | null;
  others: ProjectItem[];
  busy: boolean;
  onSwitch: (path: string) => void;
  onOpenFolder: () => void;
  onCreate: (name: string) => void;
  /** Renombra la carpeta del proyecto abierto (en el disco). */
  onRename: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState("");
  const close = () => {
    setOpen(false);
    setNaming(false);
    setName("");
    setRenaming(false);
  };
  const cur = project ? projectName(project) : "";
  const nextName = cleanFolderName(newName);

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
            {project &&
              (renaming ? (
                <form
                  className="ps-new"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!nextName || nextName === cur) return;
                    onRename(nextName);
                    close();
                  }}
                >
                  <input
                    autoFocus
                    value={newName}
                    maxLength={120}
                    onChange={(e) => setNewName(e.target.value)}
                    onFocus={(e) => e.target.select()}
                    placeholder="Nombre nuevo de la carpeta"
                    onKeyDown={(e) => e.key === "Escape" && setRenaming(false)}
                    aria-label="Nombre nuevo de la carpeta"
                  />
                  <button className="cc-btn" type="submit" disabled={!nextName || nextName === cur}>
                    Renombrar
                  </button>
                  <small>
                    Cambia el nombre de la carpeta en el disco. Las terminales se cierran un momento y los agentes
                    vuelven solos; chats, tareas, historial y memoria siguen igual.
                  </small>
                </form>
              ) : (
                <button
                  className="cc-mi"
                  role="menuitem"
                  onClick={() => {
                    setNewName(cur);
                    setRenaming(true);
                  }}
                >
                  <span className="cc-mi-ic">
                    <Icon name="pencil" />
                  </span>
                  <span>
                    <b>Renombrar carpeta…</b>
                    <small>Cambia su nombre en el disco</small>
                  </span>
                </button>
              ))}
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
