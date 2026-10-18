import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { agentColor, agentInitial } from "../lib/team";
import type { TeamEvent } from "../lib/team";
import { chatEvents, dayGroup, stampLabel } from "../lib/chats";
import type { Chat } from "../lib/chats";
import { Icon } from "./Icon";

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
}) {
  const [query, setQuery] = useState("");

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
        <span>Chats</span>
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
                  }}
                >
                  <div className="cc-chat-item-t">{c.title}</div>
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
      </div>
    </aside>
  );
}
