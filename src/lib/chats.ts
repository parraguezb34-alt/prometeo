import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentLabel } from "./team";
import type { TeamEvent } from "./team";

/**
 * Chats = ventanas de tiempo sobre el feed del hub. El hub no sabe de chats:
 * un chat es una conversación (con el equipo o privada con un agente) que
 * empieza en `startMs` y termina cuando se abre otra del mismo ámbito. Así el
 * historial se reconstruye de los eventos reales, sin duplicar nada.
 */
export type Chat = {
  id: string;
  kind: "team" | "agent";
  /** Solo en chats privados. */
  agent?: string;
  title: string;
  /** El título aún es el de por defecto y se sustituye con el primer mensaje. */
  autoTitle: boolean;
  /** Inicio de la ventana de eventos (0 = desde el principio del feed). */
  startMs: number;
  /** Fin de la ventana; ausente mientras el chat siga abierto. */
  endMs?: number;
  /** Cuándo se creó (orden y agrupación en la barra). */
  createdMs: number;
};

const MAX_CHATS = 80;
const DEFAULT_TITLE = "Chat nuevo";

function storageKey(project: string | null): string {
  return `lienzo.chats.v1:${project ?? "-"}`;
}

function newId(now: number): string {
  return `c${now.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

function bootstrap(): Chat[] {
  const now = Date.now();
  return [
    {
      id: newId(now),
      kind: "team",
      title: "Conversación del equipo",
      autoTitle: false,
      startMs: 0,
      createdMs: now,
    },
  ];
}

function load(project: string | null): Chat[] {
  try {
    const raw = localStorage.getItem(storageKey(project));
    if (raw) {
      const parsed = JSON.parse(raw) as Chat[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {
    /* almacenamiento no disponible: se parte de cero */
  }
  return bootstrap();
}

function save(project: string | null, chats: Chat[]) {
  try {
    localStorage.setItem(storageKey(project), JSON.stringify(chats.slice(0, MAX_CHATS)));
  } catch {
    /* sin almacenamiento: el historial no persistirá */
  }
}

/** ¿El evento pertenece a la ventana del chat? */
export function inWindow(chat: Chat, e: TeamEvent): boolean {
  if (e.ts_ms < chat.startMs) return false;
  return chat.endMs == null || e.ts_ms < chat.endMs;
}

/** Eventos de un chat: todo el feed (equipo) o lo que toca a ese agente. */
export function chatEvents(chat: Chat, events: TeamEvent[]): TeamEvent[] {
  return events.filter((e) => {
    if (!inWindow(chat, e)) return false;
    if (chat.kind === "team") return true;
    return (
      (e.agent === chat.agent && e.kind !== "tool") || e.to === chat.agent || e.kind === "broadcast"
    );
  });
}

export function useChats(project: string | null) {
  const [chats, setChats] = useState<Chat[]>(() => load(project));
  const [activeId, setActiveId] = useState<string>(() => chats[0]?.id ?? "");
  // La referencia va por delante del estado: varias acciones en el mismo
  // evento (crear y titular, por ejemplo) ven siempre la lista al día.
  const ref = useRef(chats);
  const projectRef = useRef(project);

  // Al cambiar de proyecto se carga su propio historial.
  useEffect(() => {
    if (projectRef.current === project) return;
    projectRef.current = project;
    const next = load(project);
    ref.current = next;
    setChats(next);
    setActiveId(next[0]?.id ?? "");
  }, [project]);

  const update = useCallback((fn: (prev: Chat[]) => Chat[]) => {
    const next = fn(ref.current);
    ref.current = next;
    setChats(next);
    save(projectRef.current, next);
  }, []);

  const active = useMemo(
    () => chats.find((c) => c.id === activeId) ?? chats[0] ?? null,
    [chats, activeId],
  );

  /** Abre un chat nuevo y cierra el anterior del mismo ámbito. */
  const create = useCallback(
    (kind: "team" | "agent", agent?: string, title?: string): Chat => {
      const now = Date.now();
      const chat: Chat = {
        id: newId(now),
        kind,
        agent,
        title: title ?? (kind === "agent" && agent ? `Privado · ${agentLabel(agent)}` : DEFAULT_TITLE),
        autoTitle: title == null,
        startMs: now,
        createdMs: now,
      };
      update((prev) => [
        chat,
        ...prev.map((c) =>
          c.endMs == null && c.kind === kind && c.agent === agent ? { ...c, endMs: now } : c,
        ),
      ]);
      setActiveId(chat.id);
      return chat;
    },
    [update],
  );

  /** Chat abierto más reciente del ámbito, o uno nuevo si no hay. */
  const openScope = useCallback(
    (kind: "team" | "agent", agent?: string): Chat => {
      const found = ref.current.find((c) => c.endMs == null && c.kind === kind && c.agent === agent);
      if (found) {
        setActiveId(found.id);
        return found;
      }
      return create(kind, agent);
    },
    [create],
  );

  const select = useCallback((id: string) => setActiveId(id), []);

  /** Pone título al chat con su primer mensaje. */
  const autoTitle = useCallback(
    (id: string, text: string) => {
      const clean = text.replace(/^@[\wÀ-ſ.-]+\s+/, "").replace(/\s+/g, " ").trim();
      if (!clean) return;
      update((prev) =>
        prev.map((c) =>
          c.id === id && c.autoTitle
            ? { ...c, title: clean.length > 48 ? `${clean.slice(0, 47)}…` : clean, autoTitle: false }
            : c,
        ),
      );
    },
    [update],
  );

  const remove = useCallback(
    (id: string) => {
      const rest = ref.current.filter((c) => c.id !== id);
      const next = rest.length > 0 ? rest : bootstrap();
      update(() => next);
      setActiveId((cur) => (cur === id ? next[0].id : cur));
    },
    [update],
  );

  return { chats, active, create, openScope, select, autoTitle, remove };
}

/** "Hoy", "Ayer", "Esta semana" o "Antes". */
export function dayGroup(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(now) - start(d)) / 86_400_000);
  if (days <= 0) return "Hoy";
  if (days === 1) return "Ayer";
  if (days < 7) return "Esta semana";
  return "Antes";
}

/** Hora si es de hoy; si no, el día de la semana o la fecha corta. */
export function stampLabel(ts: number): string {
  const d = new Date(ts);
  const group = dayGroup(ts);
  if (group === "Hoy") {
    return d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
  }
  if (group === "Ayer" || group === "Esta semana") {
    return d.toLocaleDateString("es", { weekday: "short" }).replace(".", "");
  }
  return d.toLocaleDateString("es", { day: "numeric", month: "short" }).replace(".", "");
}
