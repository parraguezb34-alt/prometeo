import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentLabel } from "./team";
import type { TeamEvent } from "./team";
import { chatsRead, chatsWrite, mergeChats, sameChats } from "./chatsDisk";

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
  /** Conversación de cada agente en este chat (id del CLI, o «*» = la última de la carpeta). */
  sessions?: Record<string, string>;
  /** Chat que este retoma («Retomar con su memoria»): su historial y sus tareas siguen aquí. */
  from?: string;
};

/** El chat del equipo que está abierto ahora: a él pertenecen las conversaciones de los agentes. */
export function currentTeamChat(chats: Chat[]): Chat | null {
  return chats.find((c) => c.kind === "team" && c.endMs == null) ?? null;
}

/** Tope de chats por proyecto (en disco y en la copia rápida del navegador). */
const MAX_CHATS = 500;
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

/** Proyectos cuyo disco ya se leyó: hasta entonces no se escribe en él (la copia rápida podría
 * estar vacía y pisaría los chats guardados). */
const synced = new Set<string>();

/**
 * Guarda en disco (lo que vale) y en el navegador interno (copia rápida para abrir al instante).
 * Las escrituras a disco van en orden, así que la última siempre gana.
 */
function save(project: string | null, chats: Chat[]) {
  const list = chats.slice(0, MAX_CHATS);
  try {
    localStorage.setItem(storageKey(project), JSON.stringify(list));
  } catch {
    /* sin almacenamiento rápido: queda el disco */
  }
  if (project && synced.has(storageKey(project))) void chatsWrite(project, list).catch(() => {});
}

/** ¿El evento pertenece a la ventana del chat? */
export function inWindow(chat: Chat, e: TeamEvent): boolean {
  if (e.ts_ms < chat.startMs) return false;
  return chat.endMs == null || e.ts_ms < chat.endMs;
}

/** El chat y los que retoma, del más nuevo al más viejo. */
export function chatLineage(chat: Chat, chats: Chat[]): Chat[] {
  const out = [chat];
  let cur = chat;
  while (cur.from && out.length < 20) {
    const prev = chats.find((c) => c.id === cur.from);
    if (!prev || out.includes(prev)) break;
    out.push(prev);
    cur = prev;
  }
  return out;
}

/** ¿Este instante cae en el chat o en alguno de los que retoma? */
export function inChat(lineage: Chat[], ts: number): boolean {
  return lineage.some((c) => ts >= c.startMs && (c.endMs == null || ts < c.endMs));
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

/** Los chats guardados de un proyecto (aunque no sea el abierto). */
export function loadChats(project: string | null): Chat[] {
  return load(project);
}

/** Chat que se abrirá al entrar en un proyecto (lo consume `useChats` al cargarlo). */
const pendingActive = new Map<string, string>();

/**
 * Antes de cambiar de proyecto: deja preparado el chat que se abrirá allí. Con `newTeam` crea
 * uno nuevo del equipo (y cierra el que hubiera abierto); con `chatId`, abre ese.
 * Devuelve el chat (para saber con qué conversación retomar a cada agente).
 */
export function prepareChat(project: string, opts: { chatId?: string; newTeam?: boolean }): Chat | null {
  const list = load(project);
  if (opts.newTeam) {
    const now = Date.now();
    const chat: Chat = {
      id: newId(now),
      kind: "team",
      title: DEFAULT_TITLE,
      autoTitle: true,
      startMs: now,
      createdMs: now,
    };
    save(project, [chat, ...list.map((c) => (c.kind === "team" && c.endMs == null ? { ...c, endMs: now } : c))]);
    pendingActive.set(storageKey(project), chat.id);
    return chat;
  }
  const chat = opts.chatId ? list.find((c) => c.id === opts.chatId) : currentTeamChat(list);
  if (chat) pendingActive.set(storageKey(project), chat.id);
  return chat ?? null;
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
    const want = pendingActive.get(storageKey(project));
    pendingActive.delete(storageKey(project));
    setActiveId(want && next.some((c) => c.id === want) ? want : (next[0]?.id ?? ""));
  }, [project]);

  const update = useCallback((fn: (prev: Chat[]) => Chat[]) => {
    const next = fn(ref.current);
    ref.current = next;
    setChats(next);
    save(projectRef.current, next);
  }, []);

  // Lo que vale está en disco: se junta con la copia rápida (sin perder ninguno de los dos) y,
  // si el disco aún no tenía nada, se guarda lo de aquí (la primera vez, al pasar del navegador).
  useEffect(() => {
    if (!project) return;
    let alive = true;
    chatsRead(project)
      .then((disk) => {
        if (!alive || projectRef.current !== project) return;
        synced.add(storageKey(project));
        // Sin nada en disco (la primera vez), se guarda lo de aquí; si no, los dos juntos.
        const merged = disk ? mergeChats(ref.current, disk).slice(0, MAX_CHATS) : ref.current;
        if (sameChats(merged, ref.current)) save(project, merged);
        else update(() => merged);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [project, update]);

  const active = useMemo(
    () => chats.find((c) => c.id === activeId) ?? chats[0] ?? null,
    [chats, activeId],
  );

  /** Abre un chat nuevo y cierra el anterior del mismo ámbito. */
  const create = useCallback(
    (kind: "team" | "agent", agent?: string, title?: string, from?: string): Chat => {
      const now = Date.now();
      const chat: Chat = {
        id: newId(now),
        kind,
        agent,
        title: title ?? (kind === "agent" && agent ? `Privado · ${agentLabel(agent)}` : DEFAULT_TITLE),
        autoTitle: title == null,
        startMs: now,
        createdMs: now,
        from,
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

  /** Le pone tú el nombre a un chat (ya no se sustituye con el primer mensaje). */
  const rename = useCallback(
    (id: string, title: string) => {
      const clean = title.replace(/\s+/g, " ").trim().slice(0, 80);
      if (!clean) return;
      update((prev) => prev.map((c) => (c.id === id ? { ...c, title: clean, autoTitle: false } : c)));
    },
    [update],
  );

  /** Recuerda con qué conversación trabaja un agente en un chat. */
  const setSession = useCallback(
    (id: string, agent: string, ref: string) => {
      update((prev) =>
        prev.map((c) => (c.id === id ? { ...c, sessions: { ...(c.sessions ?? {}), [agent]: ref } } : c)),
      );
    },
    [update],
  );

  /** Lista al día (también entre renders), para quien la lea fuera de React. */
  const current = useCallback(() => ref.current, []);

  const remove = useCallback(
    (id: string) => {
      const rest = ref.current.filter((c) => c.id !== id);
      const next = rest.length > 0 ? rest : bootstrap();
      update(() => next);
      setActiveId((cur) => (cur === id ? next[0].id : cur));
    },
    [update],
  );

  return { chats, active, create, openScope, select, autoTitle, rename, remove, setSession, current };
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
