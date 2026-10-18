import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { addAgentTerminal, removePanel, useLayout } from "../store";
import type { Panel } from "../store";
import {
  agentColor,
  agentCommands,
  agentInitial,
  agentKeyFromCmd,
  agentLabel,
  ago,
  buildPlanPrompt,
  compactOpencode,
  errMsg,
  onTeamUpdate,
  pushBroadcast,
  pushPlan,
  shortPath,
  teamAddTask,
  teamConnect,
  teamDetails,
  teamDetect,
  teamDm,
  teamLeader,
  teamModels,
  teamOpen,
  teamState,
  teamTaskOp,
} from "../lib/team";
import type { DetectResult, ModelCatalog, TeamAgent, TeamEvent, TeamState, TeamTask } from "../lib/team";
import {
  EMPTY_DISPATCH,
  dispatchPrompt,
  retryTask,
  sendFailed,
  tick as dispatchTick,
} from "../lib/dispatcher";
import type { DAgent, DispatchState } from "../lib/dispatcher";
import { loadAutoStart, loadPrefs, saveAutoStart, savePrefs } from "../lib/agentPrefs";
import type { AgentPref } from "../lib/agentPrefs";
import { termKill, termWrite } from "../lib/pty";
import { projectInfo } from "../lib/project";
import type { ProjectInfo } from "../lib/project";
import { inWindow, useChats } from "../lib/chats";
import type { Chat } from "../lib/chats";
import { GLYPHS } from "./FeedList";
import { AgentQuickCmds } from "./AgentCard";
import { ChatsSidebar } from "./ChatsSidebar";
import { DiffTab, taskPaths } from "./DiffTab";
import { FilesTab } from "./FilesTab";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { NewChatMenu } from "./NewChatMenu";
import type { NewChatChoice } from "./NewChatMenu";
import { PreviewTab } from "./PreviewTab";
import { TasksDrawer } from "./TasksDrawer";
import { TeamModal, TeamStrip, agentState } from "./TeamModal";
import type { AgentState } from "./TeamModal";
import { TeamPanel } from "./TeamPanel";
import { TerminalPanel } from "./TerminalPanel";

/** Conversation shown in the central chat: the whole team or one agent. */
type Sel = { kind: "team" } | { kind: "agent"; name: string };

/** What the stage shows for the team destination. */
type CenterView = "feed" | "diff" | "preview" | "term" | "files";

/** Mission trigger mode: plan-first or straight to execution. */
type Shoot = "plan" | "exec";

/** Ajustes del equipo (conectar CLIs, normas, proyecto). */
type Drawer = { kind: "team"; agents?: boolean } | null;

/** Capas flotantes sobre la pantalla: equipo, tareas y menú de nuevo chat. */
type Overlay = "team" | "tasks" | "newchat" | null;

const SHOOT_KEY = "lienzo.shoot.v1";
const CHATS_MIN_KEY = "lienzo.chatsmin.v1";
const ACT_KEY = "lienzo.showact.v1";
const DISPATCH_KEY = "lienzo.dispatch.v1";

/** Eventos de bajo nivel que se ocultan cuando apagas «Mostrar actividad». */
const QUIET_KINDS = new Set(["tool", "join", "leave", "claim", "release", "session", "stop", "prompt"]);

function loadFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function saveFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* sin almacenamiento: no se recordará */
  }
}

function loadShoot(): Shoot {
  try {
    return localStorage.getItem(SHOOT_KEY) === "plan" ? "plan" : "exec";
  } catch {
    return "exec";
  }
}

/** Terminal panel (if any) that belongs to a hub agent name. */
function panelForAgent(panels: Panel[], agentName: string): Panel | undefined {
  return panels.find(
    (p) => p.kind === "terminal" && !!p.cmd && agentKeyFromCmd(p.cmd) === agentName,
  );
}

/**
 * Centro de Mando: vista principal. A la izquierda el equipo (agentes con sus
 * controles, tareas y bloqueos); en el centro el espacio de artefactos (feed,
 * diffs, preview, archivos) o la conversacion con un agente; abajo el input de
 * mision con modo Planificar/Ejecutar. Las terminales viven ocultas pero vivas,
 * listas para verse bajo demanda.
 */
export function CommandCenter() {
  const layout = useLayout();
  const [state, setState] = useState<TeamState | null>(null);
  const [detect, setDetect] = useState<DetectResult | null>(null);
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [sel, setSel] = useState<Sel>({ kind: "team" });
  /** Destinatario del compositor (independiente de lo que mires en el escenario). */
  const [dest, setDest] = useState<Sel>({ kind: "team" });
  const [view, setView] = useState<CenterView>("feed");
  const [drawerTab, setDrawerTab] = useState<"tasks" | "feed" | "memory">("tasks");
  const [shoot, setShoot] = useState<Shoot>(loadShoot);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [chatsMin, setChatsMin] = useState(() => loadFlag(CHATS_MIN_KEY, false));
  const [showAct, setShowAct] = useState(() => loadFlag(ACT_KEY, true));
  const [termPick, setTermPick] = useState<string | null>(null);
  const [changeCount, setChangeCount] = useState<number | null>(null);
  const [diffTask, setDiffTask] = useState<number | null>(null);
  const [previewRel, setPreviewRel] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Record<string, AgentPref>>(loadPrefs);
  const [catalogs, setCatalogs] = useState<Record<string, ModelCatalog | null | undefined>>({});
  const [autoStart, setAutoStart] = useState(loadAutoStart);
  /** Lo último que se aplicó a la sesión de cada agente (modelo y esfuerzo). */
  const appliedRef = useRef<Record<string, AgentPref | undefined>>({});
  const autoRan = useRef<string | null>(null);
  const [hubOk, setHubOk] = useState(true);
  const [hubUrl, setHubUrl] = useState("");
  const [flash, setFlash] = useState<{ text: string; err?: boolean } | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);
  const chatRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const stickRef = useRef(true);

  const say = useCallback((text: string, err = false) => {
    setFlash({ text, err });
    if (flashTimer.current !== undefined) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 8000);
  }, []);

  const refresh = useCallback(() => {
    teamState()
      .then((s) => {
        setState(s);
        setHubOk(true);
      })
      .catch(() => setHubOk(false));
  }, []);

  const refreshDetect = useCallback(() => {
    teamDetect().then(setDetect).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    refreshDetect();
    teamDetails().then((d) => setHubUrl(d.url)).catch(() => {});
    const unlisten = onTeamUpdate(refresh);
    // El estado del equipo se refresca cada 4 s; los CLIs instalados, cada ~30 s.
    let tick = 0;
    const interval = window.setInterval(() => {
      refresh();
      tick += 1;
      if (tick % 8 === 0) refreshDetect();
    }, 4000);
    return () => {
      unlisten.then((f) => f());
      window.clearInterval(interval);
      if (flashTimer.current !== undefined) window.clearTimeout(flashTimer.current);
    };
  }, [refresh, refreshDetect]);

  // Esc cierra la capa que esté arriba: primero las flotantes, luego los ajustes.
  useEffect(() => {
    if (!drawer && !overlay) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (overlay) setOverlay(null);
      else setDrawer(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer, overlay]);

  const project = state?.project ?? null;
  const chats = useChats(project);

  // Rama git del proyecto, para la barra superior.
  useEffect(() => {
    let alive = true;
    if (!project) {
      setInfo(null);
      return;
    }
    projectInfo(project)
      .then((i) => alive && setInfo(i))
      .catch(() => alive && setInfo(null));
    return () => {
      alive = false;
    };
  }, [project]);

  const tasks = state?.tasks ?? [];
  const agents = state?.agents ?? [];
  const online = agents.filter((a) => a.online);

  // «Equipo activo» muestra a todos los agentes instalados, estén o no en marcha:
  // los que aún no tienen sesión aparecen sin conexión, con un botón para iniciarlos.
  const roster = useMemo(() => {
    const list: TeamAgent[] = [...agents];
    for (const d of detect?.agents ?? []) {
      if (!d.cli_found || list.some((a) => a.name === d.id)) continue;
      list.push({
        session_id: `det:${d.id}`,
        name: d.id,
        project: "",
        pid: 0,
        last_seen_ms: 0,
        online: false,
      });
    }
    return list;
  }, [agents, detect]);
  const leader = state?.leader ?? "";
  const done = tasks.filter((t) => t.status === "done").length;
  const total = tasks.length;

  // Latest activity per agent (joins/leaves aside) → cards + bloqueos.
  const lastByAgent = useMemo(() => {
    const m = new Map<string, TeamEvent>();
    for (const e of state?.events ?? []) {
      if (e.kind === "join" || e.kind === "leave") continue;
      const prev = m.get(e.agent);
      if (!prev || e.seq > prev.seq) m.set(e.agent, e);
    }
    return m;
  }, [state]);

  const blocked = online.filter((a) => lastByAgent.get(a.name)?.kind === "waiting");

  // Task each agent is currently holding (claimed).
  const claimedBy = useMemo(() => {
    const m = new Map<string, { id: number; title: string }>();
    for (const t of tasks) {
      if (t.status === "claimed" && t.owner) m.set(t.owner, { id: t.id, title: t.title });
    }
    return m;
  }, [tasks]);

  const selKey = sel.kind === "team" ? "team" : sel.name;

  // Messages of the open conversation, oldest → newest (the hub sends the feed
  // newest first). Agent chats show that agent's events; the team chat is the
  // whole feed (messages as bubbles, the rest as system lines).
  const activeChat = chats.active;
  const msgs = useMemo(() => {
    const all = (state?.events ?? []).slice(0, 400).reverse();
    const base =
      sel.kind === "team"
        ? all
        : all.filter(
            (e) =>
              (e.agent === sel.name && e.kind !== "tool") ||
              e.to === sel.name ||
              e.kind === "broadcast",
          );
    // Cada chat solo muestra su ventana de tiempo; «Mostrar actividad» apaga el ruido.
    const windowed = activeChat ? base.filter((e) => inWindow(activeChat, e)) : base;
    return showAct ? windowed : windowed.filter((e) => !QUIET_KINDS.has(e.kind));
  }, [state, sel, activeChat, showAct]);

  // Stick to the bottom while the user is reading the latest (like a chat).
  const onChatScroll = () => {
    const el = chatRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  };

  useEffect(() => {
    stickRef.current = true;
  }, [selKey]);

  useEffect(() => {
    const el = chatRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [selKey, view, msgs.length]);

  /** Enfoca la conversación con un agente sin tocar la lista de chats. */
  const focusAgent = (name: string) => {
    setSel({ kind: "agent", name });
    setDest({ kind: "agent", name });
    setView("feed");
    setOverlay(null);
  };

  /** Habla con un agente: abre (o retoma) su chat privado. */
  const selectAgent = (name: string) => {
    focusAgent(name);
    chats.openScope("agent", name);
  };

  /** Muestra la terminal de un agente en la pestaña Terminal. */
  const showTerminal = (name: string) => {
    setTermPick(name);
    setView("term");
    setOverlay(null);
  };

  /** Vuelve a la conversación del equipo. */
  const selectTeam = () => {
    setSel({ kind: "team" });
    setDest({ kind: "team" });
    setView("feed");
    chats.openScope("team");
  };

  /** Abre un chat de la barra lateral. */
  const activateChat = (c: Chat) => {
    chats.select(c.id);
    if (c.kind === "team") {
      setSel({ kind: "team" });
      setDest({ kind: "team" });
      setView("feed");
    } else if (c.agent) {
      focusAgent(c.agent);
    }
  };

  /** Crea el chat elegido en el menú «Nuevo chat». */
  const startChat = (choice: NewChatChoice) => {
    setOverlay(null);
    if (choice.kind === "agent") {
      chats.create("agent", choice.name);
      focusAgent(choice.name);
      return;
    }
    chats.create("team");
    setSel({ kind: "team" });
    setDest({ kind: "team" });
    setView("feed");
    if (choice.kind === "handover") {
      setDrawerTab("memory");
      setOverlay("tasks");
    }
  };

  const toggleChats = () => {
    setChatsMin((m) => {
      saveFlag(CHATS_MIN_KEY, !m);
      return !m;
    });
  };

  const toggleAct = () => {
    setShowAct((on) => {
      saveFlag(ACT_KEY, !on);
      return !on;
    });
  };

  const setShootMode = (m: Shoot) => {
    setShoot(m);
    try {
      localStorage.setItem(SHOOT_KEY, m);
    } catch {
      /* storage unavailable: mode won't persist */
    }
  };

  /** Connect (if needed) and launch an agent. Returns whether it worked. */
  const launchAgent = async (
    id: string,
    label: string,
    opts: { selectTerm?: boolean } = { selectTerm: true },
  ): Promise<boolean> => {
    setOpening(id);
    try {
      const det = detect?.agents.find((x) => x.id === id);
      if (!det?.connected) {
        await teamConnect(id, project);
        refreshDetect();
      }
      const p = prefs[id] ?? {};
      const r = await teamOpen(id, shoot, { model: p.model, effort: p.effort });
      appliedRef.current[id] = { model: p.model ?? null, effort: p.effort ?? null };
      if (r.kind === "app") {
        say(`✓ ${label} se está abriendo en su app de escritorio…`);
      } else {
        addAgentTerminal(label, r.cmd);
        if (opts.selectTerm) {
          showTerminal(agentKeyFromCmd(r.cmd));
          setDrawer(null);
        }
        say(`✓ ${label} lanzado${shoot === "plan" ? " en modo plan" : ""}.`);
      }
      refresh();
      return true;
    } catch (e) {
      say(errMsg(e), true);
      return false;
    } finally {
      setOpening(null);
    }
  };

  /** Guarda el modelo o esfuerzo elegido para un agente (se usa al abrirlo o reiniciarlo). */
  const setPref = (name: string, patch: AgentPref) => {
    setPrefs((prev) => {
      const next = { ...prev, [name]: { ...(prev[name] ?? {}), ...patch } };
      savePrefs(next);
      return next;
    });
  };

  /** Aplica el modelo y esfuerzo elegidos a un agente que ya está en marcha.
   * Claude Code lo admite en caliente (/model y /effort); el resto se reinicia
   * con las flags nuevas retomando la conversación de la carpeta. */
  const applyAgent = async (name: string) => {
    const p = prefs[name] ?? {};
    const label = agentLabel(name);
    const panel = panelForAgent(layout.panels, name);
    setOpening(name);
    try {
      if (name === "claude" && panel?.sessionId) {
        if (p.model) await termWrite(panel.sessionId, `/model ${p.model}\r`);
        if (p.effort) {
          if (p.model) await new Promise((r) => window.setTimeout(r, 900));
          await termWrite(panel.sessionId, `/effort ${p.effort}\r`);
        }
        appliedRef.current[name] = { model: p.model ?? null, effort: p.effort ?? null };
        say(`✓ ${label}: ajustes escritos en su terminal.`);
        return;
      }
      if (!panel) {
        await launchAgent(name, label, { selectTerm: false });
        return;
      }
      // Reinicio: se cierra su terminal y se abre otra con las flags nuevas.
      if (panel.sessionId) await termKill(panel.sessionId).catch(() => {});
      removePanel(panel.id);
      const r = await teamOpen(name, shoot, { model: p.model, effort: p.effort, resume: true });
      if (r.kind === "pty") addAgentTerminal(label, r.cmd);
      appliedRef.current[name] = { model: p.model ?? null, effort: p.effort ?? null };
      say(`✓ ${label} reiniciado con los ajustes nuevos; retoma su conversación.`);
      refresh();
    } catch (e) {
      say(errMsg(e), true);
    } finally {
      setOpening(null);
    }
  };

  const toggleAutoStart = (on: boolean) => {
    setAutoStart(on);
    saveAutoStart(on);
  };

  // ---- Despachador ligero: pide a los agentes libres que tomen las tareas listas.
  const [dispatchOn, setDispatchOn] = useState(() => loadFlag(DISPATCH_KEY, false));
  const [dispatchView, setDispatchView] = useState<DispatchState>(EMPTY_DISPATCH);
  const dispatchRef = useRef<DispatchState>(EMPTY_DISPATCH);
  const dispatchBusy = useRef(false);
  /** Lo último que el ciclo necesita ver, actualizado en cada render. */
  const latestRef = useRef<{
    tasks: TeamTask[];
    agents: TeamAgent[];
    leader: string;
    blocked: string[];
    panels: Panel[];
    lastByAgent: Map<string, TeamEvent>;
  } | null>(null);

  useEffect(() => {
    if (!dispatchOn) return;
    const run = async () => {
      const cur = latestRef.current;
      if (!cur || dispatchBusy.current) return;
      dispatchBusy.current = true;
      try {
        const now = Date.now();
        const byName = new Map<string, DAgent>();
        for (const a of cur.agents) {
          const prev = byName.get(a.name);
          byName.set(a.name, {
            name: a.name,
            online: (prev?.online ?? false) || a.online,
            hasTerminal: !!panelForAgent(cur.panels, a.name)?.sessionId,
            blocked: cur.blocked.includes(a.name),
            lastActivityMs: cur.lastByAgent.get(a.name)?.ts_ms ?? 0,
          });
        }
        const res = dispatchTick(dispatchRef.current, {
          now,
          tasks: cur.tasks.map((t) => ({
            id: t.id,
            title: t.title,
            notes: t.notes,
            status: t.status,
            owner: t.owner,
            parents: t.parents ?? [],
          })),
          agents: [...byName.values()],
          leader: cur.leader,
        });
        let next = res.state;
        for (const note of res.notes) say(note, true);
        if (res.send) {
          const { taskId, agent } = res.send;
          const task = cur.tasks.find((t) => t.id === taskId);
          const panel = panelForAgent(cur.panels, agent);
          try {
            if (!task || !panel?.sessionId) throw new Error("sin terminal");
            await termWrite(
              panel.sessionId,
              `${dispatchPrompt({
                id: task.id,
                title: task.title,
                notes: task.notes,
                status: task.status,
                owner: task.owner,
                parents: task.parents ?? [],
              })}\r`,
            );
            await teamDm(agent, `📌 Despacho: #${taskId} «${task.title}»`);
            say(`📌 #${taskId} pedida a ${agentLabel(agent)}.`);
          } catch (e) {
            next = sendFailed(next, taskId, agent, now);
            say(`No pude avisar a ${agentLabel(agent)}: ${errMsg(e)}`, true);
          }
        }
        dispatchRef.current = next;
        setDispatchView(next);
      } finally {
        dispatchBusy.current = false;
      }
    };
    const id = window.setInterval(() => {
      void run();
    }, 3000);
    void run();
    return () => window.clearInterval(id);
  }, [dispatchOn, say]);

  const toggleDispatch = (on: boolean) => {
    setDispatchOn(on);
    saveFlag(DISPATCH_KEY, on);
    if (!on) {
      // Los avisos en vuelo no deben contar como fallos mientras está apagado.
      dispatchRef.current = { ...dispatchRef.current, pending: {} };
      setDispatchView(dispatchRef.current);
    }
  };

  const retryDispatch = (id: number) => {
    dispatchRef.current = retryTask(dispatchRef.current, id);
    setDispatchView(dispatchRef.current);
  };

  // Al abrir la app (y al elegir un proyecto): conecta los agentes instalados y
  // abre los que no estén en marcha, para que aparezcan en «Equipo activo».
  useEffect(() => {
    if (!autoStart || !state || !detect || !project || autoRan.current === project) return;
    autoRan.current = project;
    void (async () => {
      const installed = detect.agents.filter((a) => a.cli_found);
      let connected = 0;
      let opened = 0;
      for (const a of installed) {
        if (a.connected) continue;
        try {
          await teamConnect(a.id, project);
          connected += 1;
        } catch (e) {
          say(`No pude conectar ${a.label}: ${errMsg(e)}`, true);
        }
      }
      if (connected > 0) refreshDetect();
      for (const a of installed) {
        const running = state.agents.some((x) => x.name === a.id && x.online);
        if (running || panelForAgent(layout.panels, a.id)) continue;
        if (await launchAgent(a.id, a.label, { selectTerm: false })) opened += 1;
        await new Promise((r) => window.setTimeout(r, 600));
      }
      if (connected + opened > 0) {
        say(`Equipo listo: ${connected} conectado(s), ${opened} abierto(s).`);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, state, detect, project]);

  // Al abrir el modal de equipo se carga el catálogo de modelos de cada agente.
  useEffect(() => {
    if (overlay !== "team") return;
    for (const a of roster) {
      if (catalogs[a.name] !== undefined) continue;
      setCatalogs((prev) => ({ ...prev, [a.name]: null }));
      teamModels(a.name)
        .then((c) => setCatalogs((prev) => ({ ...prev, [a.name]: c })))
        .catch(() =>
          setCatalogs((prev) => ({
            ...prev,
            [a.name]: { models: [], efforts: [], current: { model: null, effort: null }, live: false },
          })),
        );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay, roster]);

  /** One click: connect + launch every agent CLI found on this machine. */
  const launchSquad = async () => {
    const list = (detect?.agents ?? []).filter((a) => a.cli_found || a.config_dir_found);
    if (list.length === 0) {
      say("No encontré CLIs de agentes (claude, opencode, codex, agy) en este equipo.", true);
      return;
    }
    let ok = 0;
    for (const a of list) {
      const launched = await launchAgent(a.id, a.label, { selectTerm: false });
      if (launched) ok += 1;
    }
    say(`⚡ Escuadrón: ${ok} de ${list.length} agentes en marcha${shoot === "plan" ? " (modo plan)" : ""}.`);
  };

  /** Open the selected agent's terminal tab, or launch it if it has none. */
  const openTerm = (name: string) => {
    const p = panelForAgent(layout.panels, name);
    if (p) showTerminal(name);
    else launchAgent(name, name).catch(() => {});
  };

  /** Type a command/keystroke into an agent terminal (model, compact, Esc…). */
  const writeAgent = async (name: string, data: string, note: string) => {
    const p = panelForAgent(layout.panels, name);
    if (!p?.sessionId) {
      say(`${name} no tiene terminal abierta: dale a ▸_ para poder mandarle «${note}».`, true);
      return;
    }
    try {
      await termWrite(p.sessionId, data);
      say(`⌨ ${note} → ${name}`);
    } catch (e) {
      say(errMsg(e), true);
    }
  };

  /** Relevo con memoria: cuando un agente guarda su handover, lienzo compacta
   * su contexto — Claude/Codex por su terminal, OpenCode por su API local. */
  const autoCompact = async (e: TeamEvent) => {
    const name = e.agent;
    const now = Date.now();
    if (now - (compactedAt.current.get(name) ?? 0) < 30_000) return;
    compactedAt.current.set(name, now);
    const task = tasks.find((t) => t.id === e.task_id);
    const files = (e.files ?? []).slice(0, 6);
    const focus = task
      ? `Mantén el contexto de la tarea #${task.id} y los archivos ${files.join(", ") || "que tocaste"}`
      : "Mantén el contexto de tu tarea en curso y el hilo de trabajo";
    const low = name.toLowerCase();
    if (low === "opencode") {
      const proj = agents.find((a) => a.name === name)?.project;
      if (!proj) {
        say(`🔄 Relevo de ${name} guardado (sin carpeta conocida para compactar vía API).`, true);
        return;
      }
      try {
        await compactOpencode(proj);
        say(`🧠 Relevo de ${name} guardado · contexto compactado (API de OpenCode).`);
      } catch (err) {
        say(`🔄 Relevo de ${name} guardado, pero no pude compactar: ${errMsg(err)}`, true);
      }
      return;
    }
    const cmds = agentCommands(name);
    if (cmds.compact) {
      const text = low === "claude" ? `${cmds.compact} ${focus}` : cmds.compact;
      say(`🧠 Relevo de ${name} guardado · compactando su contexto…`);
      window.setTimeout(() => {
        writeAgent(name, `${text}\r`, "compactar con memoria").catch(() => {});
      }, 1200);
    } else {
      say(`🧠 Relevo de ${name} guardado (su CLI no tiene compactar conocido).`);
    }
  };

  const handoverSeq = useRef<number | null>(null);
  const compactedAt = useRef(new Map<string, number>());
  useEffect(() => {
    const hs = (state?.events ?? []).filter((e) => e.kind === "handover");
    const max = hs.reduce((m, e) => Math.max(m, e.seq), 0);
    if (handoverSeq.current === null) {
      handoverSeq.current = max; // al abrir, no compactar relevos viejos
      return;
    }
    for (const e of hs) {
      if (e.seq <= handoverSeq.current) continue;
      handoverSeq.current = Math.max(handoverSeq.current, e.seq);
      void autoCompact(e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const toggleLeader = async (name: string) => {
    try {
      await teamLeader(leader === name ? null : name);
      refresh();
    } catch (e) {
      say(errMsg(e), true);
    }
  };

  /** Send the composer. Supports mentions (@todos, @lider, @agente) and the
   * Planificar / Ejecutar trigger. */
  const send = async () => {
    const raw = draft.trim();
    if (!raw) return;

    let target: Sel = dest;
    let body = raw;
    const m = /^@([\w\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1.-]+)\s+([\s\S]+)$/.exec(raw);
    if (m) {
      const key = m[1].toLowerCase();
      if (["todos", "equipo", "all"].includes(key)) {
        target = { kind: "team" };
      } else if (["lider", "líder", "leader"].includes(key)) {
        if (leader) target = { kind: "agent", name: leader };
        else say("No hay líder elegido; lo mando al equipo entero.", true);
      } else {
        const found = agents.find((a) => a.name.toLowerCase() === key);
        if (!found) {
          say(`No conozco a «${m[1]}» — usa @todos, @lider o el nombre de un agente.`, true);
          return;
        }
        target = { kind: "agent", name: found.name };
      }
      body = m[2];
    }
    const flat = body.replace(/\s*\n+\s*/g, " ");

    // Si estás viendo un chat cerrado, lo que escribas abre uno nuevo del mismo
    // ámbito; el primer mensaje le da título.
    let chat = chats.active;
    if (chat && chat.endMs != null) chat = chats.create(chat.kind, chat.agent);
    if (chat) chats.autoTitle(chat.id, flat);

    const clear = () => {
      setDraft("");
      if (areaRef.current) areaRef.current.style.height = "auto";
    };

    try {
      if (target.kind === "team") {
        if (shoot === "plan" && leader) {
          // Modo plan con líder: solo el líder recibe la misión (y no toca nada).
          const p = panelForAgent(layout.panels, leader);
          if (p?.sessionId) {
            await termWrite(p.sessionId, `${buildPlanPrompt(flat, leader)}\r`);
          }
          await teamDm(leader, `📋 (modo plan) ${body}`);
          clear();
          refresh();
          say(
            p?.sessionId
              ? `📋 Plan pedido a ${leader} (líder). Propondrá el reparto sin editar nada.`
              : `📋 Guardado para ${leader}; abre su terminal para que lo reciba.`,
          );
        } else if (shoot === "plan") {
          const typed = await pushPlan(flat, "");
          clear();
          refresh();
          say(
            typed > 0
              ? `📋 Plan pedido a ${typed} terminal(es): nadie edita hasta tu OK.`
              : "📋 Publicado en el feed (sin terminales de agentes abiertas).",
          );
        } else {
          const typed = await pushBroadcast(flat, leader);
          clear();
          refresh();
          say(
            typed > 0
              ? `📣 Misión escrita en ${typed} terminal(es), con instrucciones de coordinación.`
              : "📣 Publicada en el feed (sin terminales de agentes abiertas ahora).",
          );
        }
        return;
      }

      // Mensaje directo a un agente.
      const name = target.name;
      const prompt = shoot === "plan" ? buildPlanPrompt(flat, leader) : flat;
      const p = panelForAgent(layout.panels, name);
      if (p?.sessionId) await termWrite(p.sessionId, `${prompt}\r`);
      await teamDm(name, shoot === "plan" ? `📋 (modo plan) ${body}` : body);
      clear();
      refresh();
      say(
        p?.sessionId
          ? `✉ Enviado a ${name}${shoot === "plan" ? " (modo plan: propone sin editar)" : ""}.`
          : `✉ Guardado en el feed; abre su terminal para que ${name} lo reciba.`,
      );
    } catch (e) {
      say(errMsg(e), true);
    }
  };

  /** Opciones del selector de destino del compositor (@equipo, líder y agentes). */
  const destNames = useMemo(() => {
    const names: string[] = [];
    if (leader) names.push(leader);
    for (const a of agents) if (a.name !== leader) names.push(a.name);
    if (dest.kind === "agent" && !names.includes(dest.name)) names.unshift(dest.name);
    return names;
  }, [agents, leader, dest]);

  const addTask = async (title: string, parents: number[] = []) => {
    try {
      await teamAddTask(title, parents);
      refresh();
    } catch (e) {
      say(errMsg(e), true);
    }
  };

  const taskOp = async (id: number, op: string) => {
    try {
      await teamTaskOp(id, op);
      refresh();
    } catch (e) {
      say(errMsg(e), true);
    }
  };

  const openDrawer = (agents = true) => setDrawer({ kind: "team", agents });
  const onDiffCount = useCallback((n: number) => setChangeCount(n), []);

  const renderEvent = (e: TeamEvent) => {
    const mine = e.agent === "tú";
    if (e.kind === "message" || (mine && e.kind === "broadcast")) {
      return (
        <div
          className="cc-msg"
          data-who={mine ? "me" : "agent"}
          key={e.seq}
          style={{ "--ac": mine ? "var(--accent)" : agentColor(e.agent) } as CSSProperties}
        >
          <div className="cc-msg-av">{mine ? "Tú" : agentInitial(e.agent)}</div>
          <div className="cc-msg-card">
            <div className="cc-msg-head">
              <b>{mine ? "Tú" : agentLabel(e.agent)}</b>
              {e.to ? <span className="cc-msg-tag">→ {e.to}</span> : null}
              {e.kind === "broadcast" ? <span className="cc-msg-tag">@equipo</span> : null}
              <time>{ago(e.ts_ms)}</time>
            </div>
            <div className="cc-msg-body">{e.text}</div>
          </div>
        </div>
      );
    }
    return (
      <div className="cc-sys" key={e.seq}>
        <span className="cc-sys-glyph">{GLYPHS[e.kind] ?? "•"}</span>
        <span className="cc-sys-main">
          <span style={{ color: agentColor(e.agent) }}>{e.agent === "tú" ? "Tú" : agentLabel(e.agent)}</span>
          {e.to ? <span> → {e.to}</span> : null}
          <span data-weak={e.kind === "tool" ? "1" : "0"}> {e.text}</span>
          {e.files.length > 0 && (
            <span className="feed-files"> · {e.files.map(shortPath).join(", ")}</span>
          )}
        </span>
        <span className="feed-time">{ago(e.ts_ms)}</span>
      </div>
    );
  };

  const agentView = sel.kind === "agent" ? sel.name : null;
  const agentRow = agentView ? agents.find((a) => a.name === agentView) : undefined;
  const agentTask = agentView ? claimedBy.get(agentView) : undefined;

  // Pestaña Terminal: sesiones PTY abiertas. Por defecto, la del agente con el
  // que estás hablando, o la primera que haya.
  const termPanels = layout.panels.filter((p) => p.kind === "terminal" && !!p.cmd);
  const teamTermName =
    termPick ??
    (agentView && panelForAgent(layout.panels, agentView)
      ? agentView
      : termPanels[0]
        ? agentKeyFromCmd(termPanels[0].cmd ?? "")
        : null);
  const teamTermPanel = teamTermName
    ? termPanels.find((p) => agentKeyFromCmd(p.cmd ?? "") === teamTermName)
    : undefined;

  // La terminal que se está viendo inline (no duplicar montajes de xterm).
  const termInlineId = view === "term" && teamTermPanel ? teamTermPanel.id : null;

  // Terminals not shown inline still live (mounted off-screen) so the agents
  // keep working and are ready the moment you look at them.
  const hiddenTerms = layout.panels.filter(
    (p) => p.kind === "terminal" && !!p.cmd && p.id !== termInlineId,
  );

  // Archivos ligados a cada tarea (reclamos + avisos de su dueño desde que nació).
  const taskFileCount = useMemo(() => {
    const m = new Map<number, number>();
    const evs = state?.events ?? [];
    const cls = state?.claims ?? [];
    for (const t of tasks) m.set(t.id, taskPaths(t, evs, cls).length);
    return m;
  }, [tasks, state]);

  // Estado de cada agente para los anillos de la barra superior y el modal.
  const blockedNames = useMemo(() => blocked.map((a) => a.name), [blocked]);
  const states = useMemo(() => {
    const m = new Map<string, AgentState>();
    for (const a of roster) {
      m.set(a.name, agentState(a, blockedNames.includes(a.name), claimedBy.has(a.name)));
    }
    return m;
  }, [roster, blockedNames, claimedBy]);

  latestRef.current = {
    tasks,
    agents,
    leader,
    blocked: blockedNames,
    panels: layout.panels,
    lastByAgent,
  };

  const VIEWS: { id: CenterView; label: string; icon: IconName; title: string }[] = [
    { id: "feed", label: "Comando", icon: "msg", title: "Chat y actividad del equipo" },
    { id: "diff", label: "Cambios", icon: "diff", title: "Revisar los cambios en git" },
    { id: "preview", label: "Preview", icon: "eye", title: "Vista previa de html/svg/md en vivo" },
    { id: "term", label: "Terminal", icon: "term", title: "Terminal de cada agente a pantalla completa" },
    { id: "files", label: "Archivos", icon: "folder", title: "Explorar los archivos del proyecto" },
  ];
  const stageTask =
    view === "diff" && diffTask != null ? tasks.find((t) => t.id === diffTask) : undefined;

  /** Progreso de tareas siempre a la vista; abre el panel lateral. */
  const tasksBtn = (
    <button
      className="cc-tasks-btn"
      onClick={() => {
        setDrawerTab("tasks");
        setOverlay("tasks");
      }}
      title="Tareas, actividad y relevos del equipo"
    >
      <Icon name="list" size={14} />
      Tareas
      <span className="cc-meter sm">
        <i style={{ width: total ? `${Math.round((done / total) * 100)}%` : "0%" }} />
      </span>
      <span className="cc-tasks-n">
        {done}/{total}
      </span>
      {blocked.length > 0 && (
        <span className="cc-warnmark">
          <Icon name="warn" size={14} />
        </span>
      )}
    </button>
  );

  const actToggle = (
    <button
      className="cc-toggle"
      aria-pressed={showAct}
      onClick={toggleAct}
      title="Muestra u oculta herramientas, reservas y otros avisos de bajo nivel"
    >
      <span className="cc-sw" />
      Mostrar actividad
    </button>
  );

  const stageHead = (
    <>
      <div className="cc-stage-head">
        {agentView && (
          <button
            className="cc-icon-btn"
            onClick={selectTeam}
            title="Volver a la conversación del equipo"
            aria-label="Volver al equipo"
          >
            <Icon name="users" />
          </button>
        )}
        <div className="cc-stage-l">
          <h2 style={agentView && !stageTask ? { color: agentColor(agentView) } : undefined}>
            {stageTask
              ? `#${stageTask.id} · ${stageTask.title}`
              : agentView
                ? agentLabel(agentView)
                : (activeChat?.title ?? "Comando")}
            {agentView && !stageTask && leader === agentView && (
              <span className="cc-lead">
                <Icon name="crown" size={13} />
                Líder
              </span>
            )}
          </h2>
          <div className="cc-stage-sub">
            <span
              className="cc-dot"
              data-on={(agentView ? agentRow?.online : online.length > 0) ? "1" : "0"}
            />
            {agentView
              ? agentTask
                ? `#${agentTask.id} ${agentTask.title}`
                : agentRow
                  ? agentRow.online
                    ? `en línea · visto hace ${ago(agentRow.last_seen_ms)}`
                    : "sin sesión viva"
                  : "sin sesión conectada"
              : `${online.length} en línea${leader ? ` · líder ${agentLabel(leader)}` : ""}`}
          </div>
        </div>
        <div className="cc-stage-r">
          {view === "feed" && actToggle}
          {tasksBtn}
        </div>
      </div>
      <div className="cc-vtabs" role="tablist">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            role="tab"
            aria-selected={view === v.id}
            onClick={() => setView(v.id)}
            title={v.title}
          >
            <Icon name={v.icon} size={14} />
            {v.label}
            {v.id === "diff" && changeCount ? <span className="cc-count">{changeCount}</span> : null}
          </button>
        ))}
      </div>
    </>
  );

  const composer = (
    <div className="cc-comp">
      <div className="cc-cbox">
        <textarea
          ref={areaRef}
          rows={1}
          value={draft}
          placeholder={
            dest.kind === "team"
              ? shoot === "plan"
                ? "Misión en modo plan: nadie edita hasta tu OK…"
                : "Pídele algo al equipo o escribe @agente… (Enter envía, Shift+Enter salto)"
              : shoot === "plan"
                ? `Plan para ${agentLabel(dest.name)}: analiza y propone sin editar nada…`
                : `Mensaje para ${agentLabel(dest.name)}… (se escribe en su terminal)`
          }
          onChange={(e) => {
            setDraft(e.target.value);
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="cc-c-row">
          <div
            className="cc-shoot"
            title="Planificar = analiza y propone sin tocar código; Directo = a trabajar ya"
          >
            <button data-active={shoot === "plan" ? "1" : "0"} onClick={() => setShootMode("plan")}>
              <Icon name="list" size={13} />
              Planificar
            </button>
            <button data-active={shoot === "exec" ? "1" : "0"} onClick={() => setShootMode("exec")}>
              Directo
            </button>
          </div>
          <button
            className="cc-dest"
            data-active={dest.kind === "team" ? "1" : "0"}
            onClick={() => setDest({ kind: "team" })}
            title="La misión va al equipo (o al líder en modo plan)"
          >
            @equipo
          </button>
          {destNames.map((n) => (
            <button
              key={n}
              className="cc-dest"
              data-active={dest.kind === "agent" && dest.name === n ? "1" : "0"}
              style={{ "--ac": agentColor(n) } as CSSProperties}
              onClick={() => setDest({ kind: "agent", name: n })}
              title={`Mensaje directo a ${n}${n === leader ? " (líder)" : ""}`}
            >
              <span className="cc-dot" />
              {n === leader && <Icon name="crown" size={12} />}
              {agentLabel(n)}
            </button>
          ))}
          <button className="cc-send" disabled={!draft.trim()} onClick={send} aria-label="Enviar" title="Enviar">
            <Icon name="send" />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="cc">
      <header className="cc-top">
        <div
          className="cc-projwrap"
          onClick={() => openDrawer(true)}
          title={
            project
              ? `Proyecto: ${project}\nPulsa para cambiarlo`
              : "Elegir la carpeta del proyecto"
          }
        >
          <span className="cc-logobox">L</span>
          <span className="cc-brandname">lienzo</span>
          <span className="cc-slash">/</span>
          <span className="cc-branch-name" data-warn={project ? "0" : "1"}>
            {info?.repo ? info.branch || "…" : project ? shortPath(project) : "sin carpeta"}
          </span>
        </div>

        <TeamStrip agents={roster} states={states} onOpen={() => setOverlay("team")} />
        {blocked.length > 0 && (
          <button
            className="cc-alert"
            onClick={() => {
              setDrawerTab("tasks");
              setOverlay("tasks");
            }}
          >
            <Icon name="warn" size={14} />
            {blocked.length === 1 ? "1 espera tu respuesta" : `${blocked.length} esperan tu respuesta`}
          </button>
        )}

        <div className="cc-top-r">
          <button
            className="cc-hub"
            data-on={hubOk ? "1" : "0"}
            onClick={() => say(hubUrl ? `Hub local: ${hubUrl}` : "Hub local: sin datos todavía.")}
            title={hubUrl ? `Hub del equipo: ${hubUrl}` : "Hub del equipo"}
          >
            <span className="cc-dot" />
            {hubOk ? "Hub conectado" : "Hub sin conexión"}
          </button>
          <div className="cc-modes">
            <button
              onClick={() => openDrawer(true)}
              title="Ajustes del equipo: agentes, normas y proyecto"
              aria-label="Ajustes del equipo"
            >
              <Icon name="settings" size={15} />
            </button>
          </div>
        </div>
      </header>

      <div className="cc-main">
        <ChatsSidebar
          chats={chats.chats}
          activeId={activeChat?.id ?? ""}
          events={state?.events ?? []}
          collapsed={chatsMin}
          newChatOpen={overlay === "newchat"}
          onToggle={toggleChats}
          onNew={() => setOverlay("newchat")}
          onSelect={activateChat}
          onRemove={(c) => chats.remove(c.id)}
        />

        <section className="cc-conv">
          {stageHead}

          {view === "feed" && (
            <div className="cc-chat" ref={chatRef} onScroll={onChatScroll}>
              {msgs.length === 0 ? (
                agentView ? (
                  <div className="cc-empty">
                    Conversación con {agentLabel(agentView)}. Lo que escribas va directo a su terminal; sus
                    avances y mensajes aparecerán aquí.
                  </div>
                ) : online.length === 0 ? (
                  <div className="cc-empty">
                    <div className="cc-empty-title">Tu equipo, en un clic</div>
                    <div className="cc-quick">
                      <button className="cc-quick-card" onClick={launchSquad}>
                        <b>Lanzar escuadrón</b>
                        <span>Abre los agentes instalados ya dentro del proyecto (en modo plan si lo tienes puesto).</span>
                      </button>
                      <button className="cc-quick-card" onClick={() => openDrawer(true)}>
                        <b>Carpeta del proyecto</b>
                        <span>Elige dónde trabajan los agentes y de dónde salen los diffs y el preview.</span>
                      </button>
                      <button className="cc-quick-card" onClick={() => openDrawer(true)}>
                        <b>Normas del equipo</b>
                        <span>Ajusta el Charter, elige líder y conecta cada CLI.</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="cc-empty">
                    Aquí verás todo lo que hace el equipo: mensajes, tareas, avances y avisos, en vivo.
                    <br />
                    Escribe abajo una misión y se repartirá con instrucciones de coordinación.
                  </div>
                )
              ) : (
                msgs.map(renderEvent)
              )}
            </div>
          )}

          {view === "diff" && (
            <DiffTab
              project={project}
              onChooseProject={() => openDrawer(true)}
              onCount={onDiffCount}
              tasks={tasks}
              events={state?.events ?? []}
              claims={state?.claims ?? []}
              taskId={diffTask}
              onTaskChange={setDiffTask}
              onSay={say}
              onPreview={(rel) => {
                setPreviewRel(rel);
                setView("preview");
              }}
            />
          )}

          {view === "preview" && (
            <PreviewTab
              project={project}
              events={state?.events ?? []}
              openRel={previewRel}
              onChooseProject={() => openDrawer(true)}
            />
          )}

          {view === "files" && (
            <FilesTab
              project={project}
              onChooseProject={() => openDrawer(true)}
              onCharter={() => openDrawer(true)}
              onPreview={(rel) => {
                setPreviewRel(rel);
                setView("preview");
              }}
            />
          )}

          {view === "term" &&
            (teamTermPanel ? (
              <div className="cc-termwrap">
                <div className="cc-term-bar">
                  <span className="cc-term-pick-label">Terminal de</span>
                  <select
                    className="cc-mini-select"
                    value={teamTermName ?? ""}
                    onChange={(e) => setTermPick(e.target.value)}
                  >
                    {termPanels.map((p) => (
                      <option key={p.id} value={agentKeyFromCmd(p.cmd ?? "")}>
                        {agentLabel(agentKeyFromCmd(p.cmd ?? ""))}
                      </option>
                    ))}
                  </select>
                  <AgentQuickCmds
                    agent={teamTermName ?? ""}
                    withEsc
                    onCmd={(cmd, note) => {
                      if (teamTermName) writeAgent(teamTermName, cmd, note);
                    }}
                  />
                  <span className="cc-term-hint">se escribe en su terminal</span>
                </div>
                <div className="cc-termbox">
                  <TerminalPanel panel={teamTermPanel} />
                </div>
              </div>
            ) : (
              <div className="cc-empty">
                <div>
                  {teamTermName
                    ? `${agentLabel(teamTermName)} todavía no tiene terminal abierta.`
                    : "Sin terminales abiertas todavía."}
                  <br />
                  Ábrela aquí y podrás verlo trabajar y escribirle directo.
                </div>
                {teamTermName ? (
                  <button
                    className="agent-btn"
                    disabled={opening === teamTermName}
                    onClick={() => launchAgent(teamTermName, agentLabel(teamTermName))}
                  >
                    {opening === teamTermName ? "Abriendo…" : "Lanzar terminal"}
                  </button>
                ) : (
                  <button className="agent-btn" onClick={() => openDrawer(true)}>
                    Conectar / abrir agentes
                  </button>
                )}
              </div>
            ))}

          {composer}
        </section>
      </div>

      {overlay === "newchat" && (
        <NewChatMenu
          agents={agents}
          leader={leader}
          collapsed={chatsMin}
          onPick={startChat}
          onClose={() => setOverlay(null)}
        />
      )}

      {overlay === "team" && (
        <TeamModal
          agents={roster}
          states={states}
          leader={leader}
          claimedBy={claimedBy}
          lastByAgent={lastByAgent}
          onClose={() => setOverlay(null)}
          onTalk={(name) => selectAgent(name)}
          onTerminal={(name) => {
            setOverlay(null);
            openTerm(name);
          }}
          onCrown={(name) => {
            void toggleLeader(name);
          }}
          onCmd={(name, cmd, note) => {
            void writeAgent(name, cmd, note);
          }}
          catalogs={catalogs}
          prefs={prefs}
          applied={appliedRef.current}
          busy={opening}
          autoStart={autoStart}
          onPref={setPref}
          onApply={(name) => {
            void applyAgent(name);
          }}
          onStart={(name) => {
            void launchAgent(name, agentLabel(name), { selectTerm: false });
          }}
          onAutoStart={toggleAutoStart}
          onSettings={() => {
            setOverlay(null);
            openDrawer(true);
          }}
        />
      )}

      {overlay === "tasks" && (
        <TasksDrawer
          tasks={tasks}
          events={state?.events ?? []}
          agentNames={agents.map((a) => a.name)}
          blocked={blockedNames}
          lastByAgent={lastByAgent}
          taskFileCount={taskFileCount}
          activeTaskId={view === "diff" ? diffTask : null}
          hasProject={!!project}
          initialTab={drawerTab}
          dispatch={{ enabled: dispatchOn, state: dispatchView, onToggle: toggleDispatch, onRetry: retryDispatch }}
          onPreview={(rel) => {
            setPreviewRel(rel);
            setView("preview");
            setOverlay(null);
          }}
          onClose={() => setOverlay(null)}
          onOpenTask={(id) => {
            if (!project) {
              setOverlay(null);
              openDrawer(true);
              return;
            }
            setDiffTask(id);
            setView("diff");
            setSel({ kind: "team" });
            setOverlay(null);
          }}
          onTaskOp={(id, op) => {
            void taskOp(id, op);
          }}
          onAddTask={addTask}
          onAnswer={(name) => selectAgent(name)}
          onTerminal={(name) => {
            setOverlay(null);
            openTerm(name);
          }}
          onSelectAgent={(name) => selectAgent(name)}
        />
      )}

      {/* Terminales ocultas pero vivas: los agentes siguen corriendo aunque no
          estés mirándolos, y aparecen al instante al abrir su pestaña. */}
      <div className="cc-hideterms" aria-hidden="true">
        {hiddenTerms.map((p) => (
          <TerminalPanel key={p.id} panel={p} />
        ))}
      </div>

      {flash && (
        <div className="cc-toast" data-err={flash.err ? "1" : undefined}>
          {flash.text}
        </div>
      )}

      {drawer && (
        <>
          <div className="cc-backdrop" onClick={() => setDrawer(null)} />
          <aside className="cc-drawer">
            <div className="cc-drawer-head">
              <span className="cc-drawer-title">Equipo — agentes, normas y proyecto</span>
              <button className="panel-close" onClick={() => setDrawer(null)} title="Cerrar (Esc)">
                ✕
              </button>
            </div>
            <div className="cc-drawer-body">
              <TeamPanel
                initialTab={drawer.agents ? "agents" : "feed"}
                launchMode={shoot}
                onTerminalOpen={(p) => {
                  showTerminal(agentKeyFromCmd(p.cmd ?? ""));
                  setDrawer(null);
                }}
              />
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
