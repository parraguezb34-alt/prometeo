import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { agentColor, agentInitial } from "../lib/team";
import type { TeamEvent } from "../lib/team";
import { chatEvents, dayGroup, loadChats, stampLabel } from "../lib/chats";
import { projectName } from "../lib/project";
import { ProjectSwitcher } from "./ProjectSwitcher";
import type { ProjectItem } from "./ProjectSwitcher";
import type { Chat } from "../lib/chats";
import { Icon } from "./Icon";
import { InlineRename } from "./InlineRename";

const GROUPS = ["Hoy", "Ayer", "Esta semana", "Antes"];

/** Quién participó en el chat (agentes distintos de ti, máx. 3). */
function participants(chat: Chat, events: TeamEvent[]): string[] {
  const names: string[] = [];
  if (chat.kind === "agent" && chat.agent) names.push(chat.agent);
  for (const e of chatEvents(chat, events)) {
    if (e.agent === "tú" || e.agent === "equipo") continue;
    if (!names.includes(e.agent)) names.push(e.agent);
    if (names.length >= 3) break;
  }
  return names.slice(0, 3);
}

export function ChatsSidebar({
  chats,
  activeId,
  events,
  collapsed,
  newChatOpen,
  onToggle,
  onNew,
  onSelect,
  onRemove,
  onRename,
  project,
  otherProjects,
  switching,
  onSwitchProject,
  onOpenFolder,
  onCreateProject,
  onRenameProject,
}: {
  chats: Chat[];
  activeId: string;
  events: TeamEvent[];
  collapsed: boolean;
  newChatOpen: boolean;
  onToggle: () => void;
  onNew: () => void;
  onSelect: (chat: Chat) => void;
  onRemove: (chat: Chat) => void;
  onRename: (chat: Chat, title: string) => void;
  project: string | null;
  otherProjects: ProjectItem[];
  switching: boolean;
  /** Cambia de proyecto (y, si se da, abre ese chat suyo). */
  onSwitchProject: (path: string, chatId?: string) => void;
  onOpenFolder: () => void;
  onCreateProject: (name: string) => void;
  onRenameProject: (name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [openProj, setOpenProj] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = chats
      .filter((c) => !q || c.title.toLowerCase().includes(q) || (c.agent ?? "").includes(q))
      .slice()
      .sort((a, b) => b.createdMs - a.createdMs);
    return GROUPS.map((g) => ({ name: g, items: list.filter((c) => dayGroup(c.createdMs) === g) })).filter(
      (g) => g.items.length > 0,
    );
  }, [chats, query]);

  if (collapsed) {
    return (
      <aside className="cc-chats" data-collapsed="1" aria-label="Chats">
        <button className="cc-icon-btn" onClick={onToggle} title="Abrir chats" aria-label="Abrir chats">
          <Icon name="panel" />
        </button>
        <button
          className="cc-rail-plus"
          data-open={newChatOpen ? "1" : "0"}
          onClick={onNew}
          title="Nuevo chat"
          aria-label="Nuevo chat"
        >
          <Icon name="plus" />
        </button>
        <span className="cc-rail-sep" />
        {chats
          .slice()
          .sort((a, b) => b.createdMs - a.createdMs)
          .slice(0, 7)
          .map((c) => {
            const who = c.kind === "agent" && c.agent ? c.agent : (participants(c, events)[0] ?? "equipo");
            return (
              <button
                key={c.id}
                className="cc-agav"
                data-active={c.id === activeId ? "1" : "0"}
                data-done={c.endMs != null ? "1" : "0"}
                style={{ "--ac": agentColor(who) } as CSSProperties}
                onClick={() => onSelect(c)}
                title={c.title}
              >
                {c.kind === "team" ? <Icon name="users" size={15} /> : agentInitial(who)}
              </button>
            );
          })}
      </aside>
    );
  }

  return (
    <aside className="cc-chats" aria-label="Chats">
      <div className="cc-chats-head">
        <ProjectSwitcher
          project={project}
          others={otherProjects}
          busy={switching}
          onSwitch={(p) => onSwitchProject(p)}
          onOpenFolder={onOpenFolder}
          onCreate={onCreateProject}
          onRename={onRenameProject}
        />
        <button className="cc-icon-btn" onClick={onToggle} title="Plegar chats" aria-label="Plegar chats">
          <Icon name="panel" />
        </button>
      </div>
      <button className="cc-newchat" data-open={newChatOpen ? "1" : "0"} onClick={onNew}>
        <Icon name="plus" size={15} />
        Nuevo chat
      </button>
      <label className="cc-chats-search">
        <Icon name="search" size={14} />
        <input
          type="text"
          value={query}
          placeholder="Buscar en chats"
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="cc-chats-list">
        {grouped.length === 0 && <div className="cc-chats-empty">Ningún chat coincide.</div>}
        {grouped.map((g) => (
          <div key={g.name}>
            <div className="cc-chats-grp">{g.name}</div>
            {g.items.map((c) => {
              const who = participants(c, events);
              return (
                <div
                  key={c.id}
                  className="cc-chat-item"
                  data-active={c.id === activeId ? "1" : "0"}
                  onClick={() => onSelect(c)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onSelect(c);
                    if (e.key === "F2") setEditing(c.id);
                  }}
                >
                  {editing === c.id ? (
                    <InlineRename
                      value={c.title}
                      label="Nombre del chat"
                      onDone={(t) => {
                        setEditing(null);
                        if (t) onRename(c, t);
                      }}
                    />
                  ) : (
                    <div
                      className="cc-chat-item-t"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setEditing(c.id);
                      }}
                      title="Doble clic para renombrar"
                    >
                      {c.title}
                    </div>
                  )}
                  <div className="cc-chat-item-m">
                    <span className="cc-minis">
                      {who.map((n) => (
                        <span key={n} className="cc-mini-av" style={{ "--ac": agentColor(n) } as CSSProperties}>
                          {agentInitial(n)}
                        </span>
                      ))}
                    </span>
                    <span className="cc-chat-tag">{c.kind === "team" ? "equipo" : "privado"}</span>
                    {c.endMs == null && <span className="cc-live" title="Chat abierto" />}
                    <time>{stampLabel(c.createdMs)}</time>
                  </div>
                  <button
                    className="cc-chat-del cc-chat-ren"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditing(c.id);
                    }}
                    title="Renombrar (F2)"
                    aria-label="Renombrar chat"
                  >
                    <Icon name="pencil" size={12} />
                  </button>
                  <button
                    className="cc-chat-del"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemove(c);
                    }}
                    title="Quitar de la lista (los eventos siguen en el feed)"
                    aria-label="Quitar chat"
                  >
                    <Icon name="x" size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        ))}
        {otherProjects.length > 0 && !query.trim() && (
          <div className="cc-otherproj">
            <div className="cc-chats-grp">Otros proyectos</div>
            {otherProjects.slice(0, 8).map((p) => {
              const isOpen = openProj === p.path;
              const list = isOpen
                ? loadChats(p.path)
                    .slice()
                    .sort((a, b) => b.createdMs - a.createdMs)
                    .slice(0, 6)
                : [];
              return (
                <div key={p.path} className="cc-proj" data-open={isOpen ? "1" : "0"}>
                  <button
                    className="cc-proj-head"
                    onClick={() => setOpenProj(isOpen ? null : p.path)}
                    aria-expanded={isOpen}
                    title={p.path}
                  >
                    <Icon name="folder" size={14} />
                    <span>{projectName(p.path)}</span>
                    {!!p.openTasks && <small>{p.openTasks}</small>}
                    <Icon name="chev" size={12} />
                  </button>
                  {isOpen && (
                    <div className="cc-proj-chats">
                      {list.map((c) => (
                        <button
                          key={c.id}
                          className="cc-proj-chat"
                          disabled={switching}
                          onClick={() => onSwitchProject(p.path, c.id)}
                          title={`Abrir este chat (cambia al proyecto ${projectName(p.path)})`}
                        >
                          <span>{c.title}</span>
                          <time>{stampLabel(c.createdMs)}</time>
                        </button>
                      ))}
                      <button className="cc-proj-go" disabled={switching} onClick={() => onSwitchProject(p.path)}>
                        Ir a este proyecto
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
