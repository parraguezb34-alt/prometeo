import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentLabel, errMsg } from "./team";
import type { TeamEvent } from "./team";
import { chatsRead, chatsWrite, mergeChats, sameChats } from "./chatsDisk";
import { notify } from "./notify";
import { reportError } from "./errors";
import { isRemote } from "./bridge";

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
  // El navegador remoto tiene otro localStorage. No inventar un chat local que luego
  // se mezcle con el historial real del PC al terminar la lectura de disco.
  return isRemote() ? [] : bootstrap();
}

/** Proyectos cuyo disco ya se leyó: hasta entonces no se escribe en él (la copia rápida podría
 * estar vacía y pisaría los chats guardados). */
const synced = new Set<string>();

let writeSeq = 0;
// Estado de sincronización y pendientes por proyecto (clave = storageKey(project))
const projectSeqs = new Map<string, { lastSuccessfulSeq: number; lastLocalSeq: number; failedSeq: number }>();
const pendingSaves = new Map<string, { seq: number; project: string | null; chats: Chat[] }>();
const lastSavedByProject = new Map<string, number>();
let retryTimer: number | undefined;

/**
 * Reintenta el guardado para todos los proyectos que tienen escrituras pendientes.
 */
export function retrySaveChats() {
  if (pendingSaves.size === 0) return;
  const entries = Array.from(pendingSaves.values());
  for (const item of entries) {
    save(item.project, item.chats);
  }
}

function handleSaveFailure(seq: number, project: string | null, chats: Chat[], detail: string) {
  const key = storageKey(project);
  const st = projectSeqs.get(key) ?? { lastSuccessfulSeq: 0, lastLocalSeq: 0, failedSeq: 0 };

  // Si ya hubo un guardado exitoso igual o más reciente para este proyecto (seq <= lastSuccessfulSeq),
  // este fallo tardío de una petición desfasada se descarta para no pisar el estado confirmado.
  if (seq <= st.lastSuccessfulSeq) return;

  // Si una escritura más reciente ya se guardó con éxito en localStorage (seq < lastLocalSeq),
  // este fallo de una versión vieja no debe fijar una lista obsoleta como pendiente.
  if (seq < st.lastLocalSeq) return;

  // Si ya hay un fallo más reciente pendiente para este proyecto, no lo pisamos con uno desfasado.
  if (seq < st.failedSeq && pendingSaves.has(key)) return;
  st.failedSeq = seq;
  projectSeqs.set(key, st);

  pendingSaves.set(key, { seq, project, chats });
  reportError("interfaz", `Fallo al guardar chats en disco y almacenamiento local (${project ?? "sin proyecto"})`, detail);

  const lastTimeMs = lastSavedByProject.get(key);
  const lastTime = lastTimeMs
    ? new Date(lastTimeMs).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "nunca";
  notify(
    "⚠️ Error al guardar chats",
    `No se pudieron guardar los chats ni en disco ni en el navegador (último guardado con éxito: ${lastTime}). Reintentando automáticamente en segundo plano.`,
    { kind: "late" },
  );
  if (retryTimer === undefined && typeof window !== "undefined") {
    retryTimer = window.setTimeout(() => {
      retryTimer = undefined;
      retrySaveChats();
    }, 20_000);
  }
}

function onSaveSuccess(seq: number, project: string | null) {
  const key = storageKey(project);
  const st = projectSeqs.get(key) ?? { lastSuccessfulSeq: 0, lastLocalSeq: 0, failedSeq: 0 };
  if (seq > st.lastSuccessfulSeq) {
    st.lastSuccessfulSeq = seq;
    lastSavedByProject.set(key, Date.now());
  }

  // Solo se da por resuelta la sincronización de este proyecto si la escritura exitosa
  // es al menos tan reciente como la última que falló para este proyecto.
  if (seq >= st.failedSeq) {
    const hadPending = pendingSaves.has(key);
    pendingSaves.delete(key);
    st.failedSeq = 0;
    projectSeqs.set(key, st);

    // Si este proyecto tenía fallos pendientes y ahora todos los proyectos están limpios:
    if (hadPending && pendingSaves.size === 0) {
      if (retryTimer !== undefined && typeof window !== "undefined") {
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      notify("Chats guardados", "Se ha restablecido la sincronización y el guardado de chats.", { kind: "done" });
    }
  } else {
    projectSeqs.set(key, st);
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("focus", () => {
    if (pendingSaves.size > 0) retrySaveChats();
  });
}

/**
 * Guarda en disco (lo que vale) y en el navegador interno (copia rápida para abrir al instante).
 * Las escrituras a disco van en orden, así que la última siempre gana.
 */
function save(project: string | null, chats: Chat[]) {
  const key = storageKey(project);
  const seq = ++writeSeq;
  const list = chats.slice(0, MAX_CHATS);

  // Si este proyecto ya tenía un guardado pendiente de reintento, actualizamos de inmediato
  // la instantánea a la más reciente para que ningún reintento intermedio guarde datos viejos.
  if (pendingSaves.has(key)) {
    pendingSaves.set(key, { seq, project, chats: list });
    const st = projectSeqs.get(key) ?? { lastSuccessfulSeq: 0, lastLocalSeq: 0, failedSeq: 0 };
    if (seq > st.failedSeq) st.failedSeq = seq;
    projectSeqs.set(key, st);
  }

  const st = projectSeqs.get(key) ?? { lastSuccessfulSeq: 0, lastLocalSeq: 0, failedSeq: 0 };
  let localOk = false;
  let localErr = "";
  try {
    localStorage.setItem(key, JSON.stringify(list));
    localOk = true;
    if (seq > st.lastLocalSeq) st.lastLocalSeq = seq;
  } catch (e) {
    localErr = errMsg(e);
  }
  projectSeqs.set(key, st);

  if (project && synced.has(key)) {
    chatsWrite(project, list)
      .then(() => {
        onSaveSuccess(seq, project);
      })
      .catch((e) => {
        const diskErr = errMsg(e);
        reportError("historial", `Fallo al escribir chats en disco para ${project} (seq ${seq}): ${diskErr}`);
        if (!localOk || pendingSaves.has(key)) {
          handleSaveFailure(
            seq,
            project,
            list,
            `Disco: ${diskErr}${localOk ? " (localStorage OK)" : ` · LocalStorage: ${localErr}`}`,
          );
        } else {
          lastSavedByProject.set(key, Date.now());
        }
      });
  } else if (!localOk) {
    handleSaveFailure(seq, project, list, `LocalStorage: ${localErr}`);
  } else {
    onSaveSuccess(seq, project);
  }
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
        if (isRemote()) {
          // El PC es la fuente de verdad del cliente remoto. La carga inicial solo
          // hidrata estado; no debe escribirlo de vuelta ni combinar datos locales.
          const remoteChats = (disk ?? []).slice(0, MAX_CHATS);
          ref.current = remoteChats;
          setChats(remoteChats);
          const want = pendingActive.get(storageKey(project));
          pendingActive.delete(storageKey(project));
          setActiveId(want && remoteChats.some((c) => c.id === want) ? want : (remoteChats[0]?.id ?? ""));
          return;
        }
        // Sin nada en disco (la primera vez), se guarda lo de aquí; si no, los dos juntos.
        const merged = disk ? mergeChats(ref.current, disk).slice(0, MAX_CHATS) : ref.current;
        if (sameChats(merged, ref.current)) save(project, merged);
        else update(() => merged);
      })
      .catch((e) => {
        reportError("historial", `Fallo al leer chats de disco para ${project}: ${errMsg(e)}`);
      });
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
