import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { addAgentTerminal, getLayout, removePanel, setRespawnResolver, useLayout } from "../store";
import type { Panel } from "../store";
import {
  agentColor,
  agentCommands,
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
  teamAgentSession,
  teamConnect,
  teamDetails,
  teamDetect,
  teamAnswer,
  teamDm,
  teamLeader,
  teamMemoryAdd,
  teamMemoryForget,
  teamMemoryResolve,
  teamModels,
  teamCharter,
  teamOpen,
  teamProjectSet,
  teamTaskComment,
  teamState,
  teamTaskOp,
} from "../lib/team";
import type { DetectResult, InboxInfo, ModelCatalog, QAnswer, TeamAgent, TeamEvent, TeamState, TeamTask } from "../lib/team";
import { findSkill, skillsInstall, skillsList, skillsSet } from "../lib/skills";
import type { Skill } from "../lib/skills";
import {
  EMPTY_DISPATCH,
  dispatchPrompt,
  remindPrompt,
  retryTask,
  sendFailed,
  tick as dispatchTick,
} from "../lib/dispatcher";
import type { DAgent, DispatchState } from "../lib/dispatcher";
import { loadApplied, loadAutoStart, loadPrefs, saveApplied, saveAutoStart, savePrefs } from "../lib/agentPrefs";
import type { AgentPref } from "../lib/agentPrefs";
import { needsLogin, tailText, termKill, termList, termScrollback, termWrite } from "../lib/pty";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { cleanFolderName, copyProjectStorage, dropProjectStorage, projectRename } from "../lib/project";
import { parentDir, projectCreateDir, projectKey, projectName } from "../lib/project";
import { projectAttachPath, projectInfo, projectRecent, projectSaveAttachment, projectSaveImage } from "../lib/project";
import { dropOwner } from "../lib/dropzone";
import { detectPrompt, detectTrust } from "../lib/prompts";
import type { TermPrompt } from "../lib/prompts";
import { readScreen } from "../lib/screens";
import { attachMeta, attachmentLine, countLines, isLongPaste, PASTED_NAME, textToBase64 } from "../lib/attach";
import type { Attachment } from "../lib/attach";
import type { ProjectInfo } from "../lib/project";
import { chatLineage, currentTeamChat, inChat, prepareChat, useChats } from "../lib/chats";
import { LATEST, resetCommand, withResume } from "../lib/resume";
import { termLastBusyMs, useTermActivity } from "../lib/activity";
import { STALL_CHECK_MS, detectStall, stallPrompt, stallText } from "../lib/stall";
import type { Stall } from "../lib/stall";
import { askPhrase, eventImages, isDispatch, isImagePath, isNotice, parseTask, samePath } from "../lib/timeline";
import { notify } from "../lib/notify";
import { dispatchConfig, getSettings, stallConfig, rememberProject, renameRecentProject, useSettings } from "../lib/settings";
import type { Chat } from "../lib/chats";
import { AgentQuickCmds, fmtTokens } from "./AgentCard";
import { ChatView } from "./ChatView";
import type { LiveAgent } from "./ChatView";
import { ChatsSidebar } from "./ChatsSidebar";
import { DestPicker } from "./DestPicker";
import { HistoryTab } from "./HistoryTab";
import { ResearchTab } from "./ResearchTab";
import { WindowControls } from "./WindowControls";
import { SlidingPill } from "./SlidingPill";
import { BrandIcon, BrandWordmark } from "./Brand";
import { LimitsChip } from "./LimitsChip";
import { fmtReset, level as limitLevel, opencodeGoUsage, parseUsagePanel, teamLimitsSet, windowLabel } from "../lib/limits";
import { InAppAvisos, Toast } from "./Avisos";
import { listen } from "@tauri-apps/api/event";
import { taskPaths } from "../lib/history";
import { appStop } from "../lib/devapp";
import { reportError, useUnseenErrors } from "../lib/errors";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { NewChatMenu } from "./NewChatMenu";
import type { NewChatChoice } from "./NewChatMenu";
import { AppTab } from "./AppTab";
import { TasksDrawer } from "./TasksDrawer";
import { TeamModal, TeamStrip, agentState } from "./TeamModal";
import type { AgentState } from "./TeamModal";
import { SettingsModal } from "./SettingsModal";
import type { SettingsSection } from "./SettingsModal";
import { TerminalPanel } from "./TerminalPanel";

/** Conversation shown in the central chat: the whole team or one agent. */
type Sel = { kind: "team" } | { kind: "agent"; name: string };

/** What the stage shows for the team destination. */
type CenterView = "feed" | "research" | "history" | "app" | "term";

/** Mission trigger mode: plan-first or straight to execution. */
type Shoot = "plan" | "exec";

/** Capas flotantes sobre la pantalla: equipo, tareas, menú de nuevo chat y ajustes. */
type Overlay = "team" | "tasks" | "newchat" | "settings" | null;

const SHOOT_KEY = "lienzo.shoot.v1";
const CHATS_MIN_KEY = "lienzo.chatsmin.v1";
const DISPATCH_KEY = "lienzo.dispatch.v1";
/** Ya se avisó de que cerrar la ventana deja Prometeo en la bandeja. */
const TRAY_KEY = "lienzo.bandeja.v1";
const NOTIFY_KEY = "lienzo.notify.v1";
/**
 * Cuándo se abrió Prometeo: lo de antes no se vio (ni el silencio ni el trabajo de los agentes).
 * Vive en la ventana para que la recarga en caliente del desarrollo no lo reinicie.
 */
const BOOT_MS: number = ((window as unknown as { __lienzoBootMs?: number }).__lienzoBootMs ??= Date.now());
/** Lo que cuenta como trabajo de un agente en el feed (entrar o abrir sesión no). */
const WORK_KINDS = new Set(["tool", "task", "update"]);

/** Cuándo tomó cada tarea su dueño, según el feed (el último «#N tomada por …»). */
function claimTimes(events: TeamEvent[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const e of events) {
    const t = parseTask(e);
    if (t?.op === "tomada" && e.ts_ms > (m.get(t.id) ?? 0)) m.set(t.id, e.ts_ms);
  }
  return m;
}

/** Ruido de conexión que no aporta a una conversación: nunca se muestra en el chat. */
const HIDDEN_KINDS = new Set(["join", "leave", "session", "stop", "prompt"]);

/** Imágenes que pueden ser capturas de los agentes. */
const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp"];
/** Adjuntos por mensaje como mucho. */
const MAX_ATTS = 10;

/** Agente que estaba trabajando cuando apareció una imagen nueva (o nadie). */
function imageOwner(events: TeamEvent[], ts: number): string {
  let best = "";
  let gap = Infinity;
  for (const e of events) {
    if (e.agent === "tú" || !e.agent) continue;
    const d = ts - e.ts_ms;
    if (d < -30_000 || d > 120_000) continue;
    if (Math.abs(d) < gap) {
      gap = Math.abs(d);
      best = e.agent;
    }
  }
  return best;
}

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
/** Tareas de un chat: las que nacieron en él (o en el que retoma) o que alguien tomó o cerró en él. */
function taskIdsOfChat(lineage: Chat[], tasks: TeamTask[], events: TeamEvent[]): Set<number> {
  const ids = new Set<number>();
  for (const t of tasks) if (inChat(lineage, t.created_ms)) ids.add(t.id);
  for (const e of events) {
    if (e.kind !== "task" || !inChat(lineage, e.ts_ms)) continue;
    const t = parseTask(e);
    if (t) ids.add(t.id);
  }
  return ids;
}

export function CommandCenter() {
  const layout = useLayout();
  const [state, setState] = useState<TeamState | null>(null);
  const [detect, setDetect] = useState<DetectResult | null>(null);
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [settingsAt, setSettingsAt] = useState<SettingsSection>("general");
  const settings = useSettings();
  const [sel, setSel] = useState<Sel>({ kind: "team" });
  /** Destinatario del compositor (independiente de lo que mires en el escenario). */
  const [dest, setDest] = useState<Sel>({ kind: "team" });
  const [view, setView] = useState<CenterView>("feed");
  const [drawerTab, setDrawerTab] = useState<"tasks" | "feed" | "handover" | "memory">("tasks");
  const [shoot, setShoot] = useState<Shoot>(loadShoot);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [chatsMin, setChatsMin] = useState(() => loadFlag(CHATS_MIN_KEY, false));
  const [termPick, setTermPick] = useState<string | null>(null);
  const [changeCount, setChangeCount] = useState<number | null>(null);
  const [diffTask, setDiffTask] = useState<number | null>(null);
  const [previewRel, setPreviewRel] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /** Adjuntos del compositor (imágenes, archivos, texto largo pegado), ya listos en disco. */
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Record<string, AgentPref>>(loadPrefs);
  const [catalogs, setCatalogs] = useState<Record<string, ModelCatalog | null | undefined>>({});
  const [autoStart, setAutoStart] = useState(loadAutoStart);
  /** Lo último que se aplicó a la sesión de cada agente (modelo y esfuerzo). */
  const appliedRef = useRef<Record<string, AgentPref | undefined>>(loadApplied());
  const markApplied = (name: string, p: AgentPref) => {
    appliedRef.current[name] = { model: p.model ?? null, effort: p.effort ?? null };
    saveApplied(appliedRef.current);
  };
  const autoRan = useRef<string | null>(null);
  /** Desde cuándo se ve la terminal de un agente sin que se haya conectado al equipo. */
  const startedAtRef = useRef<Record<string, number>>({});
  /** Lo último que muestra la terminal de un agente que aún no se conecta (qué está pidiendo). */
  const [tails, setTails] = useState<Record<string, string>>({});
  /** Agentes cuya terminal pide iniciar sesión (no pueden responder aunque estén «en línea»). */
  const [authIssues, setAuthIssues] = useState<string[]>([]);
  /** Imágenes nuevas del proyecto (capturas) como eventos sintéticos del chat. */
  const [newImages, setNewImages] = useState<TeamEvent[]>([]);
  /** Lo que muestra ahora la terminal de cada agente (trabajando o no). */
  const activity = useTermActivity();
  const [hubOk, setHubOk] = useState(true);
  const [hubUrl, setHubUrl] = useState("");
  const [flash, setFlash] = useState<{ text: string; err?: boolean } | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  // El cuadro crece con el texto (hasta un tope) también cuando el texto llega sin teclearlo.
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [draft]);

  const unseenErrors = useUnseenErrors();
  const say = useCallback((text: string, err = false) => {
    setFlash({ text, err });
    // Los avisos de error quedan también en Ajustes → Errores.
    if (err) reportError("accion", text);
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

  // Esc cierra la capa que esté arriba; Ctrl+, abre los ajustes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && overlay) setOverlay(null);
      if (e.key === "," && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setOverlay((o) => (o === "settings" ? null : "settings"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlay]);

  // Pulsaste un aviso (dentro o en la esquina de la pantalla): al chat, que es donde está.
  const openAviso = useCallback(() => {
    setOverlay(null);
    setView("feed");
  }, []);
  // La primera vez que cierras la ventana: avisa de que Prometeo sigue en la bandeja.
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const un = listen("app://bandeja", () => {
      if (loadFlag(TRAY_KEY, false)) return;
      saveFlag(TRAY_KEY, true);
      notify(
        "Prometeo sigue en segundo plano",
        "Los agentes siguen trabajando. Ábrelo con su icono junto al reloj; para salir, clic derecho → Salir.",
        { kind: "info" },
      );
    });
    return () => {
      void un.then((f) => f()).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const un = listen("aviso://open", () => openAviso());
    return () => {
      void un.then((f) => f()).catch(() => {});
    };
  }, [openAviso]);

  const project = state?.project ?? null;
  const chats = useChats(project);
  // La carpeta en uso entra en «Recientes» de Ajustes.
  useEffect(() => {
    if (project) rememberProject(project);
  }, [project]);

  /** Conversación que el chat del equipo abierto tiene apuntada para un agente (o null). */
  const sessionRef = (name: string): string | null =>
    currentTeamChat(chats.current())?.sessions?.[name] ?? null;
  // Si Prometeo se reinicia, cada agente se reabre retomando la conversación de este chat.
  setRespawnResolver((panel) => (panel.cmd ? withResume(panel.cmd, sessionRef(agentKeyFromCmd(panel.cmd))) : null));

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
  // Solo los agentes de este proyecto, uno por nombre. Otras apps (OpenCode Desktop en otra
  // carpeta, la app de escritorio de Antigravity) también se conectan al hub con su puente, y
  // sin este filtro el mismo agente salía repetido en el chat, la barra y el compositor.
  const agents = useMemo(() => {
    const all = state?.agents ?? [];
    const norm = (x: string) => x.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const proj = state?.project ? norm(state.project) : "";
    const mine = proj
      ? all.filter((a) => !a.project || norm(a.project) === proj || norm(a.project).startsWith(`${proj}/`))
      : all;
    const best = new Map<string, TeamAgent>();
    for (const a of mine) {
      const b = best.get(a.name);
      if (!b || (a.online && !b.online) || (a.online === b.online && a.last_seen_ms > b.last_seen_ms)) {
        best.set(a.name, a);
      }
    }
    return mine.filter((a) => best.get(a.name) === a);
  }, [state]);
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

  const blocked = online.filter((a) => {
    const last = lastByAgent.get(a.name);
    return last?.kind === "waiting" && !isNotice(last);
  });
  /** Preguntas de los agentes (team_ask_user) que aún esperan tu respuesta. */
  const openQuestions = (state?.questions ?? []).filter((q) => !q.answers && !q.dismissed);

  // ---- skills: la biblioteca, para las propuestas de los agentes en el chat ----------------
  const [skillLib, setSkillLib] = useState<Skill[]>([]);
  const skillEvents = (state?.events ?? []).filter((e) => e.kind === "skill").length;
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    skillsList()
      .then((l) => setSkillLib(l.skills))
      .catch(() => {});
  }, [skillEvents, overlay]);

  /** Instala (o enciende) la skill que propuso un agente desde su tarjeta del chat. */
  const skillFromChat = async (source: string, agent: string) => {
    try {
      const have = findSkill(skillLib, source);
      if (have) {
        setSkillLib((await skillsSet(have.name, { enabled: true })).skills);
        say(`Skill «${have.name}» encendida: la verán todos los agentes.`);
        return;
      }
      const r = await skillsInstall(source);
      setSkillLib(r.library.skills);
      const added = r.library.skills.filter((k) => r.installed.includes(k.name));
      if (added.length === 1) say(`Skill «${added[0].name}» instalada y encendida (la propuso ${agentLabel(agent)}).`);
      else say(`${added.length} skills añadidas, apagadas: elige cuáles encender en Ajustes → Skills.`);
    } catch (e) {
      say(`No pude instalarla: ${errMsg(e)}`, true);
    }
  };

  /** Contestas una pregunta. Si el agente ya no esperaba, se la escribe en su terminal. */
  const answerQuestion = async (id: number, answers: QAnswer[] | null) => {
    try {
      const r = await teamAnswer(id, answers);
      if (r.late) {
        const p = panelForAgent(getLayout().panels, r.agent);
        if (p?.sessionId) await termWrite(p.sessionId, `${r.late.replace(/\s*\n\s*/g, " · ")}\r`);
        else say(`Respuesta guardada: ${agentLabel(r.agent)} no tiene la terminal abierta.`, true);
      }
      refresh();
    } catch (e) {
      say(errMsg(e), true);
    }
  };

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
  // El chat y los que retoma: un chat retomado sigue mostrando la historia y las tareas del original.
  const lineage = useMemo(() => (activeChat ? chatLineage(activeChat, chats.chats) : []), [activeChat, chats.chats]);
  const inActive = (ts: number) => lineage.length === 0 || inChat(lineage, ts);

  // Las tareas son del proyecto, pero cada chat muestra las suyas: las que nacieron en él o que
  // alguien tomó o cerró en él. Las que quedaron sin terminar en chats anteriores van aparte.
  const { chatTasks, earlierTasks } = useMemo(() => {
    if (lineage.length === 0) return { chatTasks: tasks, earlierTasks: [] as TeamTask[] };
    const ids = taskIdsOfChat(lineage, tasks, state?.events ?? []);
    const mine = tasks.filter((t) => ids.has(t.id));
    const first = Math.min(...lineage.map((c) => c.startMs));
    const earlier = tasks.filter((t) => !mine.includes(t) && t.status !== "done" && t.created_ms < first);
    return { chatTasks: mine, earlierTasks: earlier };
  }, [tasks, lineage, state]);
  const done = chatTasks.filter((t) => t.status === "done").length;
  const total = chatTasks.length;

  const msgs = useMemo(() => {
    const all = (state?.events ?? []).slice().reverse();
    const base =
      sel.kind === "team"
        ? all
        : all.filter((e) => e.agent === sel.name || e.to === sel.name || (e.kind === "broadcast" && e.agent === "tú"));
    // Cada chat solo muestra su ventana de tiempo.
    const windowed = base.filter((e) => inActive(e.ts_ms));
    const list = windowed.filter((e) => !HIDDEN_KINDS.has(e.kind));
    // Capturas nuevas del proyecto que ningún evento mencionó ya.
    const extra = newImages.filter(
      (img) =>
        inActive(img.ts_ms) &&
        (sel.kind === "team" || img.agent === sel.name) &&
        !list.some((e) => eventImages(e).some((p) => samePath(p, img.files[0]))),
    );
    return extra.length > 0 ? [...list, ...extra].sort((a, b) => a.ts_ms - b.ts_ms) : list;
  }, [state, sel, lineage, newImages]); // eslint-disable-line react-hooks/exhaustive-deps

  // Imágenes nuevas en el proyecto (capturas que guardan los agentes): se miran cada poco.
  useEffect(() => {
    if (!project) {
      setNewImages([]);
      return;
    }
    let alive = true;
    const scan = () => {
      projectRecent(project, IMAGE_EXTS, 16)
        .then((files) => {
          if (!alive) return;
          const since = Date.now() - 24 * 3600_000;
          const evs = state?.events ?? [];
          setNewImages(
            files
              .filter((f) => f.mtime_ms > since)
              .map((f, i) => ({
                seq: -1 - (f.mtime_ms % 1_000_000_000) * 20 - i,
                ts_ms: f.mtime_ms,
                agent: imageOwner(evs, f.mtime_ms),
                session_id: "",
                kind: "image",
                text: f.rel,
                files: [f.rel],
              })),
          );
        })
        .catch(() => {});
    };
    scan();
    const id = window.setInterval(scan, 12_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
    // El dueño de cada imagen se recalcula en el siguiente escaneo; no hace falta reiniciar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

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

  /** Un chat del equipo nuevo empieza conversaciones nuevas: cada agente abierto limpia la suya
   * (/clear o /new en su terminal), sin cerrar la terminal. Devuelve a cuántos se lo pidió. */
  const freshConversations = async (): Promise<number> => {
    let n = 0;
    for (const p of getLayout().panels) {
      if (p.kind !== "terminal" || !p.cmd || !p.sessionId) continue;
      const name = agentKeyFromCmd(p.cmd);
      const cmd = resetCommand(name);
      if (!cmd) continue;
      try {
        // Un diálogo abierto del CLI (avisos, selectores) se comería el comando: Esc antes,
        // salvo si está trabajando, que Esc lo interrumpiría.
        if (!liveRef.current.some((l) => l.name === name && l.busy)) {
          await termWrite(p.sessionId, "\x1b");
          await new Promise((ok) => window.setTimeout(ok, 300));
        }
        await termWrite(p.sessionId, `${cmd}\r`);
        n++;
      } catch {
        /* terminal cerrada: al abrirla empezará de cero */
      }
    }
    if (n > 0) say(`Chat nuevo: ${n === 1 ? "el agente empieza" : `${n} agentes empiezan`} una conversación nueva.`);
    return n;
  };

  /** Crea el chat elegido en el menú «Nuevo chat». */
  const startChat = (choice: NewChatChoice) => {
    setOverlay(null);
    if (choice.kind === "folder") {
      void pickFolder().then((p) => {
        if (p) void switchProject(p, { newChat: true });
      });
      return;
    }
    if (choice.kind === "newproject") {
      void createProject(choice.name);
      return;
    }
    if (choice.kind === "agent") {
      chats.create("agent", choice.name);
      focusAgent(choice.name);
      return;
    }
    chats.create("team");
    void freshConversations();
    setSel({ kind: "team" });
    setDest({ kind: "team" });
    setView("feed");
    if (choice.kind === "handover") {
      setDrawerTab("handover");
      setOverlay("tasks");
    }
  };

  const toggleChats = () => {
    setChatsMin((m) => {
      saveFlag(CHATS_MIN_KEY, !m);
      return !m;
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
    opts: { selectTerm?: boolean; force?: boolean } = { selectTerm: true },
  ): Promise<boolean> => {
    // Una terminal por agente: si ya tiene una, se muestra en lugar de abrir otra.
    if (!opts.force && panelForAgent(layout.panels, id)) {
      if (opts.selectTerm) showTerminal(id);
      say(`${label} ya tiene una terminal abierta.`);
      return true;
    }
    setOpening(id);
    try {
      const det = detect?.agents.find((x) => x.id === id);
      if (!det?.connected) {
        await teamConnect(id, project);
        refreshDetect();
      }
      const p = prefs[id] ?? {};
      const r = await teamOpen(id, shoot, { model: p.model, effort: p.effort });
      markApplied(id, p);
      if (r.kind === "app") {
        say(`✓ ${label} se está abriendo en su app de escritorio…`);
      } else {
        // Si ya trabajó en este chat, retoma esa conversación; si no, empieza una nueva.
        addAgentTerminal(label, withResume(r.cmd, sessionRef(id)));
        if (opts.selectTerm) {
          showTerminal(agentKeyFromCmd(r.cmd));
          setOverlay(null);
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
        markApplied(name, p);
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
      // Un reinicio por ajustes conserva el modo con el que ya estaba el agente (plan o no), sin
      // depender del interruptor Planificar/Directo del chat, que puede estar en otro punto.
      const mode: Shoot = /(?:--mode|--permission-mode)[ =]plan/.test(panel.cmd ?? "") ? "plan" : "exec";
      const r = await teamOpen(name, mode, { model: p.model, effort: p.effort });
      // Retoma la conversación de este chat (o, si aún no se sabe cuál, la última de la carpeta).
      if (r.kind === "pty") addAgentTerminal(label, withResume(r.cmd, sessionRef(name) ?? LATEST));
      markApplied(name, p);
      say(`✓ ${label} reiniciado con los ajustes nuevos; retoma su conversación.`);
      refresh();
    } catch (e) {
      say(errMsg(e), true);
    } finally {
      setOpening(null);
    }
  };

  /** Cierra la terminal de un agente y abre otra nueva (p. ej. si se quedó sin conectar). */
  const restartAgent = async (name: string) => {
    const panel = panelForAgent(layout.panels, name);
    if (panel?.sessionId) await termKill(panel.sessionId).catch(() => {});
    if (panel) removePanel(panel.id);
    delete startedAtRef.current[name];
    await launchAgent(name, agentLabel(name), { selectTerm: true, force: true });
  };

  /**
   * Reinicia un agente que ya trabaja sin perder el hilo: cierra su terminal y abre otra con el
   * mismo modo y modelo, retomando la conversación de este chat. Sirve para que cargue las
   * herramientas y skills nuevas.
   */
  const reloadAgent = async (name: string) => {
    const label = agentLabel(name);
    const panel = panelForAgent(layout.panels, name);
    if (!panel) {
      await launchAgent(name, label, { selectTerm: false });
      return;
    }
    const p = prefs[name] ?? {};
    setOpening(name);
    try {
      if (panel.sessionId) await termKill(panel.sessionId).catch(() => {});
      removePanel(panel.id);
      const mode: Shoot = /(?:--mode|--permission-mode)[ =]plan/.test(panel.cmd ?? "") ? "plan" : "exec";
      const r = await teamOpen(name, mode, { model: p.model, effort: p.effort });
      if (r.kind === "pty") addAgentTerminal(label, withResume(r.cmd, sessionRef(name) ?? LATEST));
      say(`✓ ${label} reiniciado: retoma su conversación con las herramientas nuevas.`);
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
  const [dispatchOn, setDispatchOn] = useState(() => loadFlag(DISPATCH_KEY, true));
  const [dispatchView, setDispatchView] = useState<DispatchState>(EMPTY_DISPATCH);
  const dispatchRef = useRef<DispatchState>(EMPTY_DISPATCH);
  const dispatchBusy = useRef(false);
  /** Lo último que el ciclo necesita ver, actualizado en cada render. */
  const latestRef = useRef<{
    tasks: TeamTask[];
    agents: TeamAgent[];
    leader: string;
    director: boolean;
    blocked: string[];
    panels: Panel[];
    lastByAgent: Map<string, TeamEvent>;
    events: TeamEvent[];
    states: Map<string, AgentState>;
    inbox: Record<string, InboxInfo>;
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
        const cfg = getSettings();
        const claims = claimTimes(cur.events);
        const lastWork = new Map<string, number>();
        for (const e of cur.events)
          if (WORK_KINDS.has(e.kind) && e.ts_ms > (lastWork.get(e.agent) ?? 0)) lastWork.set(e.agent, e.ts_ms);
        for (const a of cur.agents) {
          if (cfg.skipAgents.includes(a.name)) continue;
          const prev = byName.get(a.name);
          const sid = panelForAgent(cur.panels, a.name)?.sessionId;
          byName.set(a.name, {
            name: a.name,
            online: (prev?.online ?? false) || a.online,
            hasTerminal: !!sid,
            blocked: cur.blocked.includes(a.name),
            lastActivityMs: cur.lastByAgent.get(a.name)?.ts_ms ?? 0,
            lastWorkMs: lastWork.get(a.name) ?? 0,
            busy: !!sid && now - termLastBusyMs(sid) < 5_000,
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
            level: t.level ?? "",
            assign: t.assign ?? "",
            claimedMs: claims.get(t.id) ?? 0,
          })),
          agents: [...byName.values()],
          leader: cur.leader,
          director: cur.director,
          bootMs: BOOT_MS,
        }, dispatchConfig(cfg));
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
        if (res.remind) {
          // Una tarea que se quedó a medias al cerrar Prometeo: se le recuerda a su dueño.
          const { taskId, agent } = res.remind;
          const task = cur.tasks.find((t) => t.id === taskId);
          const panel = panelForAgent(cur.panels, agent);
          try {
            if (!task || !panel?.sessionId) throw new Error("sin terminal");
            await termWrite(
              panel.sessionId,
              `${remindPrompt({
                id: task.id,
                title: task.title,
                notes: task.notes,
                status: task.status,
                owner: task.owner,
                parents: task.parents ?? [],
              })}\r`,
            );
            say(`🔁 #${taskId} seguía a medias desde antes de abrir Prometeo: se la recordé a ${agentLabel(agent)}.`);
          } catch (e) {
            say(`No pude recordarle #${taskId} a ${agentLabel(agent)}: ${errMsg(e)}`, true);
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

  /** Borra los fallos y pausas del despacho (desde Ajustes). */
  const clearDispatch = () => {
    dispatchRef.current = { ...dispatchRef.current, taskFails: {}, triedBy: {}, agentFails: {}, agentPausedUntil: {} };
    setDispatchView(dispatchRef.current);
    say("✓ Fallos y pausas del despacho borrados.");
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
      const skip = getSettings().skipAgents;
      const installed = detect.agents.filter((a) => a.cli_found && !skip.includes(a.id));
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

  // Cada pocos segundos se mira si la terminal de algún agente pide iniciar sesión: está «en
  // línea» (su puente MCP ya se unió) pero no puede contestar, y sin esto el equipo le manda tareas
  // y mensajes que se pierden.
  useEffect(() => {
    let prev: string[] = [];
    const check = async () => {
      const found: string[] = [];
      for (const p of getLayout().panels) {
        if (p.kind !== "terminal" || !p.cmd || !p.sessionId) continue;
        try {
          if (needsLogin(await termScrollback(p.sessionId))) found.push(agentKeyFromCmd(p.cmd));
        } catch {
          /* sin sesión: nada que mirar */
        }
      }
      found.sort();
      if (found.join(",") === prev.join(",")) return;
      for (const name of found) {
        if (!prev.includes(name)) {
          say(`${agentLabel(name)} no tiene la sesión iniciada: abre su terminal y escribe /login.`, true);
        }
      }
      prev = found;
      setAuthIssues(found);
    };
    void check();
    const id = window.setInterval(() => void check(), 5000);
    return () => window.clearInterval(id);
  }, [say]);

  // Cada poco se apunta en el chat del equipo abierto con qué conversación trabaja cada agente
  // que ya hizo algo en él: Claude Code y Codex la dicen por sus hooks, Antigravity en su
  // historial, y de OpenCode basta con «la última de la carpeta».
  useEffect(() => {
    const run = async () => {
      const cur = latestRef.current;
      const chat = currentTeamChat(chats.current());
      if (!cur || !chat || !project) return;
      for (const a of cur.agents) {
        if (!a.online || !panelForAgent(cur.panels, a.name)?.sessionId) continue;
        const worked = cur.events.some(
          (e) => e.agent === a.name && e.ts_ms >= chat.startMs && !HIDDEN_KINDS.has(e.kind),
        );
        if (!worked) continue;
        let ref: string | null = null;
        if (a.name === "claude" || a.name === "codex") ref = a.cli_session ?? null;
        else if (a.name === "antigravity") ref = await teamAgentSession(a.name, project).catch(() => null);
        // Sin id, solo OpenCode puede retomar «la última de la carpeta» (ver withResume).
        if (a.name === "opencode") ref ??= chat.sessions?.[a.name] ? null : LATEST;
        if (ref && chat.sessions?.[a.name] !== ref) chats.setSession(chat.id, a.name, ref);
      }
    };
    void run();
    const id = window.setInterval(() => void run(), 10_000);
    return () => window.clearInterval(id);
    // chats.current y chats.setSession son estables; el objeto chats cambia en cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats.current, chats.setSession, project]);

  // Con el modal abierto, se lee el final de la terminal de los agentes que aún no se unen al
  // equipo: casi siempre esperan que confirmes algo (confiar en la carpeta, aprobar el MCP…).
  const startingKey = roster
    .filter((a) => !a.online && !!panelForAgent(layout.panels, a.name)?.sessionId)
    .map((a) => a.name)
    .join(",");
  useEffect(() => {
    if (overlay !== "team" || !startingKey) return;
    const names = startingKey.split(",");
    const read = async () => {
      const next: Record<string, string> = {};
      for (const name of names) {
        const sid = panelForAgent(getLayout().panels, name)?.sessionId;
        if (!sid) continue;
        try {
          next[name] = tailText(await termScrollback(sid));
        } catch {
          /* sin sesión: no hay nada que mostrar */
        }
      }
      setTails(next);
    };
    void read();
    const id = window.setInterval(() => void read(), 3000);
    return () => window.clearInterval(id);
  }, [overlay, startingKey]);

  // Una terminal de un agente que ya no está instalado (o que nunca funcionó) no se puede
  // reparar: se cierra para que no se quede en «Conectando…» para siempre.
  useEffect(() => {
    if (!detect) return;
    for (const p of getLayout().panels) {
      const key = agentKeyFromCmd(p.cmd ?? "");
      const found = detect.agents.find((d) => d.id === key);
      if (found && !found.cli_found) {
        if (p.sessionId) termKill(p.sessionId).catch(() => {});
        removePanel(p.id);
      }
    }
  }, [detect]);

  // Barrido de terminales huérfanas: si la interfaz se recarga mientras se abre un agente,
  // puede quedar una sesión viva que ningún panel recuerda. Se cierran a los pocos segundos
  // (solo si todos los paneles ya tienen su sesión guardada, para no matar una recién creada).
  useEffect(() => {
    const t = window.setTimeout(() => {
      const panels = getLayout().panels;
      if (panels.some((p) => !p.sessionId)) return;
      const known = new Set(panels.map((p) => p.sessionId));
      termList()
        .then((live) => {
          for (const sess of live) {
            if (sess.running && !known.has(sess.id)) termKill(sess.id).catch(() => {});
          }
        })
        .catch(() => {});
    }, 10_000);
    return () => window.clearTimeout(t);
  }, []);

  // Al abrir el modal de equipo se carga el catálogo de modelos de cada agente.
  useEffect(() => {
    if (overlay !== "team" && overlay !== "settings") return;
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
    const skip = getSettings().skipAgents;
    const list = (detect?.agents ?? []).filter((a) => (a.cli_found || a.config_dir_found) && !skip.includes(a.id));
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

  /** Relevo con memoria: cuando un agente guarda su handover, Prometeo compacta
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
    // Los adjuntos viajan como rutas: el agente los abre con su herramienta de leer archivos.
    if (attaching) return;
    const att = attachmentLine(atts);
    const raw = [draft.trim(), att].filter(Boolean).join("\n");
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
    if (chat && chat.endMs != null) {
      chat = chats.create(chat.kind, chat.agent);
      // Un chat del equipo nuevo: los agentes limpian su conversación antes de recibir el mensaje.
      if (chat.kind === "team" && (await freshConversations()) > 0) {
        await new Promise((r) => window.setTimeout(r, 1200));
      }
    }
    if (chat) chats.autoTitle(chat.id, flat);

    const clear = () => {
      setDraft("");
      setAtts([]);
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

  /** Adjuntos que aún se están guardando: el mensaje espera a que estén en disco. */
  const [attaching, setAttaching] = useState(0);
  const addAtt = (a: Attachment) =>
    setAtts((cur) => (cur.some((x) => samePath(x.path, a.path)) ? cur : [...cur, a].slice(0, MAX_ATTS)));
  const saving = async (fn: () => Promise<void>) => {
    setAttaching((n) => n + 1);
    try {
      await fn();
    } finally {
      setAttaching((n) => n - 1);
    }
  };

  /** Archivos pegados o elegidos con el clip: llegan sin ruta, así que se guardan en el proyecto. */
  const attachFiles = async (files: File[]) => {
    if (files.length === 0) return;
    if (!project) {
      say("Elige antes la carpeta del proyecto: los adjuntos se guardan en ella.", true);
      return;
    }
    if (files.length > MAX_ATTS) say(`Como mucho ${MAX_ATTS} adjuntos por mensaje.`, true);
    for (const f of files.slice(0, MAX_ATTS)) {
      const image = f.type.startsWith("image/");
      if (f.size > (image ? 12 : 25) * 1024 * 1024) {
        say(`${f.name || "El archivo"} es demasiado grande (máx. ${image ? 12 : 25} MB).`, true);
        continue;
      }
      await saving(async () => {
        try {
          const url = await new Promise<string>((ok, ko) => {
            const r = new FileReader();
            r.onload = () => ok(String(r.result));
            r.onerror = () => ko(r.error);
            r.readAsDataURL(f);
          });
          const data = url.slice(url.indexOf(",") + 1);
          if (image) {
            const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
            const path = await projectSaveImage(project, data, ext);
            addAtt({ kind: "image", path, name: f.name || "captura", size: f.size, preview: url });
          } else {
            const path = await projectSaveAttachment(project, f.name || "adjunto", data);
            addAtt({ kind: "file", path, name: f.name || "adjunto", size: f.size });
          }
        } catch (e) {
          say(`No pude adjuntar ${f.name || "el archivo"}: ${errMsg(e)}`, true);
        }
      });
    }
  };

  /** Un texto largo pegado va como archivo, para no llenar el cuadro ni la terminal del agente. */
  const attachText = async (text: string) => {
    if (!project) return;
    await saving(async () => {
      try {
        const path = await projectSaveAttachment(project, PASTED_NAME, textToBase64(text));
        addAtt({
          kind: "text",
          path,
          name: "Texto pegado",
          size: new TextEncoder().encode(text).length,
          lines: countLines(text),
          preview: text.slice(0, 600),
          text,
        });
      } catch (e) {
        say(`No pude adjuntar el texto; lo dejo en el cuadro. (${errMsg(e)})`, true);
        setDraft((d) => d + text);
      }
    });
  };

  /** Devuelve un texto pegado al cuadro, por si lo querías escrito en el mensaje. */
  const inlineText = (a: Attachment) => {
    setAtts((cur) => cur.filter((x) => x.path !== a.path));
    setDraft((d) => (d && !/\s$/.test(d) ? `${d}\n` : d) + (a.text ?? ""));
    areaRef.current?.focus();
  };

  // Arrastrar a la ventana: Tauri entrega las rutas reales. Lo que ya está en el proyecto va
  // por su ruta; un archivo de fuera se copia a `.lienzo/adjuntos/` (ver project_attach_path).
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const un = getCurrentWebview().onDragDropEvent((ev) => {
      const t = ev.payload.type;
      if (t === "enter" || t === "over") setDragOver(true);
      else if (t === "leave") setDragOver(false);
      else if (t === "drop") {
        setDragOver(false);
        const paths = ev.payload.paths;
        // Otra pantalla (Ajustes → Skills) se queda con lo que sueltes.
        const owner = dropOwner();
        if (owner) {
          owner(paths);
          return;
        }
        if (paths.length > MAX_ATTS) say(`Como mucho ${MAX_ATTS} adjuntos por mensaje.`, true);
        for (const src of paths.slice(0, MAX_ATTS)) {
          const image = isImagePath(src);
          if (!project) {
            if (!image) {
              say("Elige antes la carpeta del proyecto para adjuntar archivos.", true);
              continue;
            }
            invoke<string>("image_data", { path: src, project: null })
              .then((preview) => addAtt({ kind: "image", path: src, name: src, size: 0, preview }))
              .catch(() => say(`No pude abrir ${src}`, true));
            continue;
          }
          void saving(async () => {
            try {
              const a = await projectAttachPath(project, src);
              if (image) {
                const preview = await invoke<string>("image_data", { path: a.path, project: null });
                addAtt({ kind: "image", path: a.path, name: a.name, size: a.size, preview });
              } else {
                addAtt({ kind: a.dir ? "dir" : "file", path: a.path, name: a.name, size: a.size });
              }
            } catch (e) {
              say(`No pude adjuntar ${src}: ${errMsg(e)}`, true);
            }
          });
        }
      }
    });
    return () => {
      void un.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [say, project]);

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

  const openSettings = (at: SettingsSection = "general") => {
    setSettingsAt(at);
    setOverlay("settings");
  };

  /** Carpeta del equipo (desde Ajustes): se guarda en el hub y se apunta como reciente. */
  const saveProject = async (path: string | null) => {
    try {
      await teamProjectSet(path);
      if (path) rememberProject(path);
      refresh();
      refreshDetect();
      say(path ? `✓ Carpeta del equipo: ${path}` : "Carpeta del equipo borrada.");
    } catch (e) {
      say(errMsg(e), true);
    }
  };

  // ---- proyectos: una carpeta por proyecto, cada uno con sus chats, tareas, memoria y normas --

  const [switching, setSwitching] = useState(false);
  const recentProjects = useSettings().recentProjects;
  /** Los otros proyectos: los que el hub tiene guardados y los usados hace poco, sin repetir. */
  const otherProjects = useMemo(() => {
    const out: { path: string; openTasks?: number }[] = [];
    const seen = new Set(project ? [projectKey(project)] : []);
    for (const p of state?.projects ?? []) {
      if (seen.has(projectKey(p.path))) continue;
      seen.add(projectKey(p.path));
      out.push({ path: p.path, openTasks: p.open_tasks });
    }
    for (const path of recentProjects) {
      if (seen.has(projectKey(path))) continue;
      seen.add(projectKey(path));
      out.push({ path });
    }
    return out;
  }, [state?.projects, recentProjects, project]);

  /**
   * Cambia el equipo a otra carpeta. El hub aparta lo del proyecto actual y trae lo del nuevo;
   * los agentes abiertos se conectan allí (sus guías, MCP y skills) y se reabren en esa carpeta,
   * retomando la conversación que tenían en el chat que se abre (o empezando de cero si es nuevo).
   */
  const switchProject = async (path: string, opts: { chatId?: string; newChat?: boolean } = {}) => {
    const target = path.trim();
    if (!target || switching) return;
    if (project && projectKey(project) === projectKey(target)) {
      if (opts.chatId) chats.select(opts.chatId);
      else if (opts.newChat) startChat({ kind: "team" });
      return;
    }
    setSwitching(true);
    setOverlay(null);
    const name = projectName(target);
    say(`📁 Cambiando a «${name}»…`);
    try {
      const chat = prepareChat(target, { chatId: opts.chatId, newTeam: opts.newChat });
      const sessions = chat?.sessions ?? {};
      const running = getLayout()
        .panels.filter((p) => p.kind === "terminal" && !!p.cmd)
        .map((p) => ({ panel: p, name: agentKeyFromCmd(p.cmd ?? "") }));
      // Fuera de la carpeta vieja: se cierran sus terminales.
      for (const { panel } of running) {
        if (panel.sessionId) await termKill(panel.sessionId).catch(() => {});
        removePanel(panel.id);
      }
      // La app en vivo era la del proyecto viejo.
      await appStop().catch(() => {});
      setPreviewRel(null);
      setDiffTask(null);
      await teamProjectSet(target);
      rememberProject(target);
      let reopened = 0;
      for (const { panel, name: agent } of running) {
        try {
          await teamConnect(agent, target);
          const pref = prefs[agent] ?? {};
          const mode: Shoot = /(?:--mode|--permission-mode)[ =]plan/.test(panel.cmd ?? "") ? "plan" : "exec";
          const r = await teamOpen(agent, mode, { model: pref.model, effort: pref.effort });
          if (r.kind === "pty") {
            addAgentTerminal(agentLabel(agent), withResume(r.cmd, sessions[agent]));
            reopened++;
          }
        } catch (e) {
          say(`${agentLabel(agent)}: ${errMsg(e)}`, true);
        }
      }
      setSel({ kind: "team" });
      setDest({ kind: "team" });
      setView("feed");
      refresh();
      refreshDetect();
      say(
        reopened > 0
          ? `📁 Ahora en «${name}»: ${reopened === 1 ? "1 agente reabierto" : `${reopened} agentes reabiertos`} en esa carpeta.`
          : `📁 Ahora en «${name}». Abre a los agentes cuando quieras: arrancarán en esa carpeta.`,
      );
    } catch (e) {
      say(errMsg(e), true);
    } finally {
      setSwitching(false);
    }
  };

  /** Elige una carpeta en el explorador de Windows. */
  const pickFolder = async (): Promise<string | null> => {
    try {
      const r = await openDialog({
        directory: true,
        multiple: false,
        title: "Elige la carpeta del proyecto",
        defaultPath: project ? parentDir(project) : undefined,
      });
      return typeof r === "string" ? r : null;
    } catch (e) {
      say(errMsg(e), true);
      return null;
    }
  };

  /** Crea un proyecto nuevo (carpeta vacía junto a la actual) y se cambia a él con un chat nuevo. */
  const createProject = async (name: string) => {
    let parent = project ? parentDir(project) : null;
    if (!parent) parent = await pickFolder();
    if (!parent) return;
    try {
      const path = await projectCreateDir(parent, name);
      await switchProject(path, { newChat: true });
    } catch (e) {
      say(errMsg(e), true);
    }
  };

  /**
   * Renombra la carpeta del proyecto abierto en el disco. Windows no deja renombrar una carpeta
   * en uso, así que se cierran sus terminales y la app en vivo; después cada agente se vuelve a
   * conectar en la ruta nueva y se reabre retomando su conversación.
   */
  const renameProject = async (name: string) => {
    const old = project;
    const clean = cleanFolderName(name);
    if (!old || !clean || switching || clean === projectName(old)) return;
    setSwitching(true);
    setOverlay(null);
    say(`📁 Renombrando «${projectName(old)}» a «${clean}»…`);
    const sessions = currentTeamChat(chats.current())?.sessions ?? {};
    const running = getLayout()
      .panels.filter((p) => p.kind === "terminal" && !!p.cmd)
      .map((p) => ({ panel: p, name: agentKeyFromCmd(p.cmd ?? "") }));
    // Los chats ya en la ruta nueva antes de que el hub avise del cambio (si no, se verían vacíos).
    const guess = `${parentDir(old)}\\${clean}`;
    copyProjectStorage(old, guess, false);
    let target = old;
    try {
      for (const { panel } of running) {
        if (panel.sessionId) await termKill(panel.sessionId).catch(() => {});
        removePanel(panel.id);
      }
      await appStop().catch(() => {});
      setPreviewRel(null);
      // Las terminales tardan un momento en soltar la carpeta.
      await new Promise((r) => window.setTimeout(r, 600));
      target = await projectRename(old, clean);
      if (projectKey(target) !== projectKey(guess)) {
        copyProjectStorage(old, target, false);
        dropProjectStorage(guess);
      }
      copyProjectStorage(old, target, true);
      renameRecentProject(old, target);
      rememberProject(target);
      say(`📁 La carpeta ahora se llama «${projectName(target)}».`);
    } catch (e) {
      if (projectKey(guess) !== projectKey(old)) dropProjectStorage(guess);
      say(errMsg(e), true);
    }
    // Con el nombre nuevo (o el de siempre si falló), cada agente vuelve a su terminal.
    let reopened = 0;
    for (const { panel, name: agent } of running) {
      try {
        await teamConnect(agent, target);
        const pref = prefs[agent] ?? {};
        const mode: Shoot = /(?:--mode|--permission-mode)[ =]plan/.test(panel.cmd ?? "") ? "plan" : "exec";
        const r = await teamOpen(agent, mode, { model: pref.model, effort: pref.effort });
        if (r.kind === "pty") {
          addAgentTerminal(agentLabel(agent), withResume(r.cmd, sessions[agent]));
          reopened++;
        }
      } catch (e) {
        say(`${agentLabel(agent)}: ${errMsg(e)}`, true);
      }
    }
    if (reopened > 0) say(`📁 ${reopened === 1 ? "1 agente reabierto" : `${reopened} agentes reabiertos`} en «${projectName(target)}».`);
    refresh();
    refreshDetect();
    setSwitching(false);
  };

  /** (Re)escribe la configuración de un agente en la carpeta del proyecto. */
  const connectAgent = async (id: string) => {
    try {
      const res = await teamConnect(id, project);
      refreshDetect();
      refresh();
      const lines = [`✓ ${agentLabel(id)} conectado.`];
      if (res.files.length) lines.push("Archivos escritos:", ...res.files);
      say([...lines, ...res.notes].join("\n"));
    } catch (e) {
      say(errMsg(e), true);
    }
  };

  const saveTeamRules = async (charter: string | null, lead: string | null) => {
    await teamCharter(charter, lead);
    refresh();
  };
  const onDiffCount = useCallback((n: number) => setChangeCount(n), []);

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
      const hasTerminal = !!panelForAgent(layout.panels, a.name)?.sessionId;
      let s = agentState(a, blockedNames.includes(a.name), claimedBy.has(a.name), hasTerminal);
      if ((s === "idle" || s === "work") && authIssues.includes(a.name)) s = "login";
      if (s === "starting") startedAtRef.current[a.name] ??= Date.now();
      else delete startedAtRef.current[a.name];
      m.set(a.name, s);
    }
    return m;
  }, [roster, blockedNames, claimedBy, layout.panels, authIssues]);

  // El despacho automático solo reparte las tareas del chat del equipo que está abierto: las
  // abiertas de otros chats se le pasan como «fuera», para que sigan contando como padres
  // sin terminar pero nunca se pidan.
  const dispatchTasks = useMemo(() => {
    const open = currentTeamChat(chats.chats);
    const ids = open ? taskIdsOfChat(chatLineage(open, chats.chats), tasks, state?.events ?? []) : new Set<number>();
    return tasks.map((t) => (t.status === "open" && !ids.has(t.id) ? { ...t, status: "fuera" } : t));
  }, [tasks, chats.chats, state]);

  latestRef.current = {
    tasks: dispatchTasks,
    agents,
    leader,
    director: !!state?.director,
    // Un agente sin sesión iniciada no puede tomar tareas: el despachador lo trata como ocupado.
    blocked: [...blockedNames, ...authIssues],
    events: state?.events ?? [],
    states,
    inbox: state?.inbox ?? {},
    panels: layout.panels,
    lastByAgent,
  };

  // Quién trabaja ahora (por su terminal o por sus acciones recientes): su «pensando…» en el chat.
  // Si alguien no contesta, lo dice el acuse de tu mensaje (ChatView).
  // Preguntas en la pantalla de cada agente (permisos, confirmaciones): se contestan desde el chat.
  const [termPrompts, setTermPrompts] = useState<Record<string, TermPrompt>>({});
  const promptKeyRef = useRef("");
  // «¿Confías en esta carpeta?» al abrir un agente en el proyecto: la carpeta ya la elegiste tú,
  // así que se contesta sola (una vez por terminal y pantalla).
  const projectRef = useRef(project);
  projectRef.current = project;
  const trustedRef = useRef(new Map<string, number>());
  useEffect(() => {
    const scan = () => {
      const next: Record<string, TermPrompt> = {};
      for (const p of getLayout().panels) {
        if (p.kind !== "terminal" || !p.cmd || !p.sessionId) continue;
        const screen = readScreen(p.sessionId);
        const trust = detectTrust(screen, projectRef.current);
        if (trust) {
          const at = trustedRef.current.get(p.sessionId) ?? 0;
          if (Date.now() - at > 4000) {
            trustedRef.current.set(p.sessionId, Date.now());
            void termWrite(p.sessionId, trust).catch(() => {});
          }
          continue;
        }
        const found = detectPrompt(screen);
        if (found) next[agentKeyFromCmd(p.cmd)] = found;
      }
      const key = Object.entries(next)
        .map(([a, q]) => `${a}:${q.key}`)
        .sort()
        .join("\n");
      if (key === promptKeyRef.current) return;
      // Avisa de las nuevas (no de las que ya estaban).
      const before = promptKeyRef.current;
      promptKeyRef.current = key;
      setTermPrompts(next);
      if (loadFlag(NOTIFY_KEY, true) && getSettings().notify.ask) {
        for (const [a, q] of Object.entries(next)) {
          if (!before.includes(`${a}:${q.key}`))
            notify(`${agentLabel(a)} necesita tu permiso`, [q.title, ...q.detail].join(" · ").slice(0, 180), {
              agent: a,
              kind: "ask",
            });
        }
      }
    };
    const id = window.setInterval(scan, 1000);
    return () => window.clearInterval(id);
  }, []);

  /** Contesta desde el chat la pregunta que un agente tiene en su terminal. */
  const answerPrompt = async (agent: string, keys: string) => {
    const p = panelForAgent(getLayout().panels, agent);
    if (!p?.sessionId) return;
    setTermPrompts((cur) => {
      const next = { ...cur };
      delete next[agent];
      return next;
    });
    promptKeyRef.current = "";
    await termWrite(p.sessionId, keys).catch((e) => say(errMsg(e), true));
  };

  const live = useMemo<LiveAgent[]>(() => {
    const out: LiveAgent[] = [];
    const evs = state?.events ?? [];
    const now = Date.now();
    for (const a of roster) {
      if (sel.kind === "agent" && sel.name !== a.name) continue;
      const p = panelForAgent(layout.panels, a.name);
      const act = p?.sessionId ? activity.get(p.sessionId) : undefined;
      const lastTool = evs.find((e) => e.agent === a.name && e.kind === "tool");
      const toolAge = lastTool ? now - lastTool.ts_ms : Infinity;
      // Si ya cerró su turno (o contestó) después de su última acción, no sigue trabajando.
      const ended = evs.find((e) => e.agent === a.name && (e.kind === "stop" || e.kind === "reply"));
      const finished = !!ended && !!lastTool && ended.seq > lastTool.seq;
      // La terminal tarda unos segundos en quedarse quieta tras el fin de turno: si el turno
      // acaba de cerrarse después de que empezara la racha, ya no está trabajando.
      const justEnded = !!ended && now - ended.ts_ms < 6_000 && (act?.since ?? 0) <= ended.ts_ms;
      const prompt = termPrompts[a.name];
      const busy = (!!act?.busy && !justEnded) || (toolAge < 20_000 && !finished) || !!prompt;
      if (!busy) continue;
      // Sin terminal que mirar, la racha empieza en la primera acción seguida (sin pausas largas).
      let streak = lastTool?.ts_ms ?? now;
      for (const e of evs) {
        if (e.agent !== a.name || e.kind !== "tool" || e.ts_ms > streak) continue;
        if (streak - e.ts_ms > 90_000) break;
        streak = e.ts_ms;
      }
      out.push({
        name: a.name,
        busy,
        since: act?.busy ? act.since : streak,
        status: act?.status ?? "",
        lastAction: toolAge < 120_000 ? lastTool?.text : undefined,
        hasTerminal: !!p?.sessionId,
        prompt,
      });
    }
    return out;
  }, [roster, activity, state, layout.panels, sel, termPrompts]);

  // ---- Avisos de Windows (solo si Prometeo no está delante) ------------------------------
  const [notifyOn, setNotifyOn] = useState(() => loadFlag(NOTIFY_KEY, true));
  const notifSeq = useRef<number | null>(null);
  const lateWarned = useRef<Set<number>>(new Set());
  const liveRef = useRef(live);
  liveRef.current = live;

  // ---- Agentes colgados: con una tarea tomada y sin señales (un latido cada 30 s). -------
  const [stalls, setStalls] = useState<Record<string, Stall>>({});
  const stallInRef = useRef({ prompts: termPrompts, notifyOn });
  stallInRef.current = { prompts: termPrompts, notifyOn };
  const stallWarned = useRef(new Set<string>());
  useEffect(() => {
    const check = () => {
      const cur = latestRef.current;
      if (!cur) return;
      const now = Date.now();
      const cfg = stallConfig(getSettings());
      const claims = claimTimes(cur.events);
      const next: Record<string, Stall> = {};
      for (const t of cur.tasks) {
        if (t.status !== "claimed" || !t.owner || next[t.owner]) continue;
        // Solo se vigila a quien tiene su terminal aquí: es a quien se le puede preguntar.
        const sid = panelForAgent(cur.panels, t.owner)?.sessionId;
        if (!sid || !cur.agents.some((a) => a.name === t.owner && a.online)) continue;
        const s = detectStall(
          {
            now,
            agent: t.owner,
            taskId: t.id,
            events: cur.events,
            termBusyMs: termLastBusyMs(sid),
            waiting: cur.blocked.includes(t.owner) || !!stallInRef.current.prompts[t.owner],
            claimedMs: claims.get(t.id) ?? 0,
            fromMs: BOOT_MS,
          },
          cfg,
        );
        if (s) next[t.owner] = s;
      }
      setStalls((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      for (const s of Object.values(next)) {
        // Un aviso por episodio: si vuelve a dar señales y se cuelga otra vez, se avisa de nuevo.
        const k = `${s.agent}|${s.taskId}|${s.reason}|${s.sinceMs}`;
        if (stallWarned.current.has(k)) continue;
        stallWarned.current.add(k);
        if (stallInRef.current.notifyOn)
          notify(`${agentLabel(s.agent)} parece colgado`, `${stallText(s)} en la tarea #${s.taskId}. Abre el equipo para preguntarle o interrumpirlo.`, {
            agent: s.agent,
            kind: "late",
          });
      }
    };
    const first = window.setTimeout(check, 5_000);
    const id = window.setInterval(check, STALL_CHECK_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, []);

  /** «Preguntarle»: una línea en su terminal pidiéndole un team_update de cómo va. */
  const askStalled = async (name: string) => {
    const s = stalls[name];
    const p = panelForAgent(getLayout().panels, name);
    if (!s || !p?.sessionId) return;
    try {
      await termWrite(p.sessionId, `${stallPrompt(s)}\r`);
      say(`Le pregunté a ${agentLabel(name)} cómo va con #${s.taskId}.`);
    } catch (e) {
      say(errMsg(e), true);
    }
  };

  // ---- Límites de uso: Claude los manda solo (su barra de estado); aquí OpenCode Go y Antigravity.
  const hasOpenCode = roster.some((a) => a.name.toLowerCase().includes("opencode"));
  useEffect(() => {
    if (!hasOpenCode || !("__TAURI_INTERNALS__" in window)) return;
    const check = () =>
      void opencodeGoUsage()
        .then((u) => {
          if (u.active) void teamLimitsSet("opencode", u.windows, false, "estimado (Go)").catch(() => {});
        })
        .catch(() => {});
    check();
    const id = window.setInterval(check, 60_000);
    return () => window.clearInterval(id);
  }, [hasOpenCode]);

  const [usageScreens, setUsageScreens] = useState<Record<string, string>>({});
  /** Antigravity solo lo dice con /usage: se le pide, se lee de su pantalla y se cierra el panel. */
  const readUsage = async (agent: string) => {
    const p = panelForAgent(getLayout().panels, agent);
    if (!p?.sessionId) {
      say(`Abre la terminal de ${agentLabel(agent)} para leer su límite.`, true);
      return;
    }
    if (liveRef.current.some((l) => l.name === agent && l.busy)) {
      say(`${agentLabel(agent)} está trabajando: lee su límite cuando termine.`, true);
      return;
    }
    const sid = p.sessionId;
    await termWrite(sid, "/usage\r").catch(() => {});
    await new Promise((r) => window.setTimeout(r, 2500));
    const screen = readScreen(sid);
    const windows = parseUsagePanel(screen);
    await termWrite(sid, "\x1b").catch(() => {});
    // Lo leído tal cual, para comprobarlo en el panel de límites.
    setUsageScreens((cur) => ({ ...cur, [agent]: (screen ?? []).map((l) => l.trimEnd()).filter(Boolean).join("\n") }));
    if (windows.length === 0) {
      say(`No encontré porcentajes en el /usage de ${agentLabel(agent)}. Míralo en su terminal.`, true);
      return;
    }
    await teamLimitsSet(agent, windows, false, "leído de /usage").catch((e) => say(errMsg(e), true));
    say(`Límite de ${agentLabel(agent)} actualizado.`);
  };

  // Aviso al pasar del 70 % y del 90 % en cualquier ventana (una vez por nivel).
  const limitLevels = useRef<Map<string, string>>(new Map());
  const limitSeen = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    for (const [agent, l] of Object.entries(state?.limits ?? {})) {
      // Solo una lectura nueva puede avisar (el estado llega una y otra vez con la misma).
      if (limitSeen.current.get(agent) === l.ts_ms) continue;
      limitSeen.current.set(agent, l.ts_ms);
      l.windows.forEach((w, i) => {
        // Por posición: dos ventanas con el mismo nombre no se pisan.
        const k = `${agent}|${i}|${w.key}`;
        const lv = limitLevel(w.used_pct);
        const before = limitLevels.current.get(k);
        limitLevels.current.set(k, lv);
        if (before === undefined || lv === "ok" || lv === before || (before === "crit" && lv === "warn")) return;
        notify(
          `${agentLabel(agent)}: ${windowLabel(w, i)} al ${Math.round(w.used_pct)}%`,
          w.resets_at ? `Se reinicia ${fmtReset(w.resets_at)}. Reparte lo que queda entre los demás.` : "Reparte lo que queda entre los demás.",
          { agent, kind: lv === "crit" ? "ask" : "late" },
        );
      });
    }
  }, [state?.limits]);

  const setNotify = (on: boolean) => {
    setNotifyOn(on);
    saveFlag(NOTIFY_KEY, on);
    say(on ? "Avisos de Windows activados: te aviso si un agente te necesita." : "Avisos de Windows desactivados.");
  };
  const toggleNotify = () => setNotify(!notifyOn);

  // Lo nuevo del feed: alguien pide permiso, termina una tarea o te responde.
  useEffect(() => {
    const evs = state?.events ?? [];
    const top = evs[0]?.seq ?? 0;
    // Lo que ya había al abrir Prometeo no se avisa.
    if (notifSeq.current === null || !notifyOn) {
      if (evs.length > 0) notifSeq.current = top;
      return;
    }
    const since = notifSeq.current;
    notifSeq.current = Math.max(since, top);
    const team = new Set(roster.map((a) => a.name));
    const want = getSettings().notify;
    for (const e of evs.filter((x) => x.seq > since).reverse()) {
      if (e.agent === "tú" || !team.has(e.agent)) continue;
      const who = agentLabel(e.agent);
      if (e.kind === "waiting" && !isNotice(e)) {
        if (want.ask) notify(`${who} necesita tu respuesta`, `Pide ${askPhrase(e.text)}.`, { agent: e.agent, kind: "ask" });
      } else if (e.kind === "question") {
        if (want.ask) notify(`${who} te pregunta`, e.text.replace(/^❓ q\d+ · /, ""), { agent: e.agent, kind: "ask" });
      } else if (e.kind === "skill") {
        if (want.ask) notify(`${who} propone una skill`, e.text.slice(0, 160), { agent: e.agent, kind: "ask" });
      } else if (e.kind === "task") {
        const t = parseTask(e);
        if (want.done && t?.op === "hecha")
          notify(`${who} terminó la tarea #${t.id}`, t.detail || "Tarea hecha.", { agent: e.agent, kind: "done" });
        if (want.done && t?.op === "aprobada")
          notify(`${who} aprobó la tarea #${t.id}`, "Revisada y cerrada.", { agent: e.agent, kind: "done" });
      } else if (e.kind === "reply" || (e.kind === "message" && e.to === "tú")) {
        if (want.reply) notify(`${who} respondió`, e.text.replace(/\s+/g, " ").slice(0, 160), { agent: e.agent, kind: "reply" });
      }
    }
  }, [state, notifyOn, roster]);

  // Tu último mensaje a un agente lleva unos minutos sin respuesta y el agente no está trabajando.
  const lateMin = settings.notify.lateMin;
  useEffect(() => {
    if (!notifyOn || lateMin <= 0) return;
    const id = window.setInterval(() => {
      const evs = latestRef.current?.events ?? [];
      const mine = evs.find((e) => e.agent === "tú" && e.kind === "message" && !!e.to && !isDispatch(e));
      if (!mine || lateWarned.current.has(mine.seq)) return;
      const age = Date.now() - mine.ts_ms;
      if (age < lateMin * 60_000 || age > Math.max(30, lateMin * 3) * 60_000) return;
      const a = mine.to as string;
      if (evs.some((e) => e.agent === a && e.seq > mine.seq)) return;
      if (liveRef.current.some((l) => l.name === a && l.busy)) return;
      lateWarned.current.add(mine.seq);
      notify(`${agentLabel(a)} no ha respondido`, `Lleva ${lateMin} minutos sin contestar a tu mensaje. Mira su terminal en Prometeo.`, {
        agent: a,
        kind: "late",
      });
    }, 30_000);
    return () => window.clearInterval(id);
  }, [notifyOn, lateMin]);

  // ---- Buzón: un agente libre con mensajes de otro sin leer recibe una línea en su terminal.
  // Claude los recibe también al acabar su turno (hook); OpenCode y Antigravity, solo así o al
  // usar una herramienta del equipo.
  const relayed = useRef<Record<string, number>>({});
  const relayAt = useRef<Record<string, number>>({});
  useEffect(() => {
    const id = window.setInterval(() => {
      const cur = latestRef.current;
      if (!cur || !getSettings().team.relayInbox) return;
      const now = Date.now();
      for (const [agent, info] of Object.entries(cur.inbox)) {
        // Los mensajes a todo el equipo no despiertan a nadie: cada aviso le cuesta un turno entero.
        if (!info.direct) continue;
        if ((relayed.current[agent] ?? 0) >= info.last_seq) continue;
        if (now - (relayAt.current[agent] ?? 0) < 60_000) continue;
        // Un momento de margen: quizá lo lee él solo con la siguiente herramienta.
        const msg = cur.events.find((e) => e.seq === info.last_seq);
        if (msg && now - msg.ts_ms < 8_000) continue;
        if (cur.blocked.includes(agent) || getSettings().skipAgents.includes(agent)) continue;
        if (liveRef.current.some((l) => l.name === agent && l.busy)) continue;
        if (now - (cur.lastByAgent.get(agent)?.ts_ms ?? 0) < 15_000) continue;
        const panel = panelForAgent(cur.panels, agent);
        if (!panel?.sessionId) continue;
        relayed.current[agent] = info.last_seq;
        relayAt.current[agent] = now;
        const from = info.from.map(agentLabel).join(", ");
        const n = info.unread === 1 ? "1 mensaje" : `${info.unread} mensajes`;
        void termWrite(
          panel.sessionId,
          `📬 Tienes ${n} de ${from} en tu buzón: léelos con team_inbox y responde solo si hace falta.\r`,
        ).catch(() => {});
      }
    }, 5000);
    return () => window.clearInterval(id);
  }, []);

  // ---- Modo director: el líder empieza cada misión con el contexto limpio. Cada revisión le
  // hace releer su conversación entera; lo que hizo el equipo queda en el tablero y la memoria.
  // Solo Claude Code (con /clear) y solo si está libre y su contexto ya pesa.
  const cleanKey = `lienzo.leaderClean:${project ?? "-"}`;
  const cleanRef = useRef<{ key: string; doneUpTo: number; pending: boolean }>({ key: "", doneUpTo: -1, pending: false });
  const directorOn = state ? !!state.director : null;
  const prevDirector = useRef<boolean | null>(null);
  useEffect(() => {
    // Al activar el modo director (no al abrir Prometeo con él ya activo) también se empieza limpio.
    if (directorOn && prevDirector.current === false) cleanRef.current.pending = true;
    if (directorOn !== null) prevDirector.current = directorOn;
  }, [directorOn]);
  useEffect(() => {
    const id = window.setInterval(() => {
      const cur = latestRef.current;
      const c = cleanRef.current;
      if (!cur?.director || !getSettings().team.leaderClean || cur.leader !== "claude") return;
      if (c.key !== cleanKey) {
        // Por proyecto: lo ya limpiado no se vuelve a limpiar al reabrir Prometeo.
        let saved = -1;
        try {
          saved = Number(localStorage.getItem(cleanKey) ?? "-1");
        } catch {
          /* sin almacenamiento: se empieza de cero */
        }
        const maxDone = Math.max(0, ...cur.tasks.filter((t) => t.status === "done").map((t) => t.id));
        Object.assign(c, { key: cleanKey, doneUpTo: saved >= 0 ? saved : maxDone });
      }
      const active = cur.tasks.some((t) => ["open", "claimed", "review", "draft"].includes(t.status));
      const maxDone = Math.max(0, ...cur.tasks.filter((t) => t.status === "done").map((t) => t.id));
      const missionOver = !active && maxDone > c.doneUpTo;
      if (!missionOver && !(c.pending && !active)) return;
      const ctx = Math.max(0, ...cur.agents.filter((a) => a.name === cur.leader).map((a) => a.ctx_tokens ?? 0));
      if (ctx < 30_000) {
        c.pending = false;
        return;
      }
      const now = Date.now();
      if (liveRef.current.some((l) => l.name === cur.leader && l.busy)) return;
      if (now - (cur.lastByAgent.get(cur.leader)?.ts_ms ?? 0) < 60_000) return;
      if ((cur.inbox[cur.leader]?.unread ?? 0) > 0) return;
      const panel = panelForAgent(cur.panels, cur.leader);
      if (!panel?.sessionId) return;
      c.pending = false;
      c.doneUpTo = maxDone;
      try {
        localStorage.setItem(cleanKey, String(maxDone));
      } catch {
        /* sin almacenamiento: puede repetirse al reabrir */
      }
      void termWrite(panel.sessionId, "/clear\r")
        .then(() => say(`🧹 Contexto del líder limpio (${fmtTokens(ctx)}): la próxima misión empieza ligera.`))
        .catch(() => {});
    }, 10_000);
    return () => window.clearInterval(id);
  }, [cleanKey, say]);

  /** Abre un archivo que sale en el chat: en el preview si es del proyecto. */
  const openPath = (path: string) => {
    const norm = path.replace(/\\/g, "/");
    const root = (project ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    let rel = norm;
    if (/^([A-Za-z]:)?\//.test(norm)) {
      if (!root || !norm.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
        say(`Está fuera del proyecto: ${path}`);
        return;
      }
      rel = norm.slice(root.length + 1);
    }
    setPreviewRel(rel.replace(/^\.\//, ""));
    setView("app");
  };

  /** Detiene lo que esté haciendo un agente (Esc en su terminal; OpenCode pide dos). */
  const interrupt = async (name: string) => {
    const p = panelForAgent(layout.panels, name);
    if (!p?.sessionId) return;
    try {
      await termWrite(p.sessionId, "\x1b");
      if (name.includes("opencode")) {
        window.setTimeout(() => void termWrite(p.sessionId as string, "\x1b").catch(() => {}), 150);
      }
      say(`Detenido: ${agentLabel(name)}`);
    } catch (e) {
      say(errMsg(e), true);
    }
  };

  const VIEWS: { id: CenterView; label: string; icon: IconName; title: string }[] = [
    { id: "feed", label: "Comando", icon: "msg", title: "Chat y actividad del equipo" },
    { id: "research", label: "Investigar", icon: "search", title: "Investigación en la web con el equipo, con fuentes" },
    { id: "history", label: "Historial", icon: "history", title: "Qué cambió cada tarea, para verlo y deshacerlo" },
    { id: "app", label: "App", icon: "app", title: "Tu proyecto arrancado y a la vista" },
    { id: "term", label: "Terminal", icon: "term", title: "Terminal de cada agente a pantalla completa" },
  ];
  const stageTask =
    view === "history" && diffTask != null ? tasks.find((t) => t.id === diffTask) : undefined;

  /** Progreso de tareas siempre a la vista; abre el panel lateral. */
  const tasksBtn = (
    <button
      className="cc-tasks-btn"
      onClick={() => {
        setDrawerTab("tasks");
        setOverlay("tasks");
      }}
      title={
        total
          ? `Tareas de este chat: ${done} de ${total} hechas. También actividad, relevos y memoria.`
          : "Tareas de este chat, actividad, relevos y memoria"
      }
    >
      <Icon name="list" size={14} />
      Tareas
      {total > 0 && (
        <>
          <span className="cc-meter sm">
            <i style={{ width: `${Math.round((done / total) * 100)}%` }} />
          </span>
          <span className="cc-tasks-n">
            {done}/{total}
          </span>
        </>
      )}
      {blocked.length > 0 && (
        <span className="cc-warnmark">
          <Icon name="warn" size={14} />
        </span>
      )}
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
          {tasksBtn}
        </div>
      </div>
      <div className="cc-vtabs" role="tablist" data-pill="1">
        <SlidingPill active={view} />
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
            {v.id === "history" && changeCount ? <span className="cc-count">{changeCount}</span> : null}
          </button>
        ))}
      </div>
    </>
  );

  /**
   * Retomar un chat cerrado con su memoria: abre un chat nuevo que lo continúa y reabre a cada
   * agente con la conversación que tenía en él (los que no estuvieron, empiezan de cero).
   */
  const resumeChat = async (old: Chat) => {
    const chat = chats.create("team", undefined, `↩ ${old.title.replace(/^↩\s*/, "")}`, old.id);
    const refs = old.sessions ?? {};
    for (const [name, ref] of Object.entries(refs)) chats.setSession(chat.id, name, ref);
    let resumed = 0;
    for (const p of getLayout().panels) {
      if (p.kind !== "terminal" || !p.cmd) continue;
      const name = agentKeyFromCmd(p.cmd);
      const ref = refs[name];
      if (ref) {
        // Se cierra su terminal y se abre otra retomando la conversación de aquel chat.
        if (p.sessionId) await termKill(p.sessionId).catch(() => {});
        removePanel(p.id);
        addAgentTerminal(agentLabel(name), withResume(p.cmd, ref));
        resumed++;
      } else if (p.sessionId) {
        const reset = resetCommand(name);
        if (reset) await termWrite(p.sessionId, `${reset}\r`).catch(() => {});
      }
    }
    setSel({ kind: "team" });
    setDest({ kind: "team" });
    setView("feed");
    say(
      resumed > 0
        ? `↩ Retomado «${old.title}»: ${resumed === 1 ? "1 agente vuelve" : `${resumed} agentes vuelven`} a su conversación de entonces.`
        : "Ese chat no tiene conversaciones guardadas de los agentes; empiezan de cero.",
    );
  };

  /** Barra sobre el compositor cuando miras un chat del equipo ya cerrado. */
  const closedBar =
    view === "feed" && sel.kind === "team" && activeChat?.kind === "team" && activeChat.endMs != null ? (
      <div className="cc-closed">
        <Icon name="book" size={14} />
        <span>
          Este chat está cerrado. Si escribes, se abre uno nuevo
          {Object.keys(activeChat.sessions ?? {}).length > 0 ? "; o retómalo con la memoria que tenían los agentes." : "."}
        </span>
        {Object.keys(activeChat.sessions ?? {}).length > 0 && (
          <button className="cc-btn" onClick={() => void resumeChat(activeChat)}>
            <Icon name="refresh" size={13} />
            Retomar con su memoria
          </button>
        )}
      </div>
    ) : null;

  const composer = (
    <div className="cc-comp">
      <div
        className="cc-cbox"
        data-drop={dragOver ? "1" : "0"}
        onDragOver={(e) => {
          // En la app de escritorio el arrastre lo recibe Tauri (con rutas); esto sirve en el navegador.
          if ([...e.dataTransfer.items].some((i) => i.kind === "file")) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          setDragOver(false);
          const files = [...e.dataTransfer.files];
          if (files.length > 0) {
            e.preventDefault();
            void attachFiles(files);
          }
        }}
      >
        {(atts.length > 0 || attaching > 0) && (
          <div className="cc-shots">
            {atts.map((a) => {
              const drop = (
                <button
                  className="cc-att-x"
                  onClick={() => setAtts((cur) => cur.filter((x) => x.path !== a.path))}
                  aria-label={`Quitar ${a.name}`}
                  title="Quitar"
                >
                  <Icon name="x" size={11} />
                </button>
              );
              if (a.kind === "image") {
                return (
                  <span className="cc-shot" key={a.path} title={a.path}>
                    <img src={a.preview} alt="" />
                    {drop}
                  </span>
                );
              }
              return (
                <span className="cc-att" key={a.path} data-kind={a.kind} title={a.kind === "text" ? undefined : a.path}>
                  <span className="cc-att-ic">
                    <Icon name={a.kind === "dir" ? "folder" : "file"} size={15} />
                  </span>
                  <span className="cc-att-tx">
                    <b>{a.name}</b>
                    {a.kind === "text" && a.preview && <code>{a.preview}</code>}
                    <small>
                      {attachMeta(a)}
                      {a.kind === "text" && a.text != null && (
                        <button className="cc-att-in" onClick={() => inlineText(a)} title="Quitar el adjunto y poner el texto en el cuadro">
                          Ponerlo en el cuadro
                        </button>
                      )}
                    </small>
                  </span>
                  {drop}
                </span>
              );
            })}
            {attaching > 0 && (
              <span className="cc-att" data-kind="busy">
                <span className="cc-att-ic">
                  <span className="cv-pulse" />
                </span>
                <span className="cc-att-tx">
                  <b>Preparando…</b>
                </span>
              </span>
            )}
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void attachFiles([...(e.currentTarget.files ?? [])]);
            e.currentTarget.value = "";
          }}
        />
        <textarea
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length > 0) {
              e.preventDefault();
              void attachFiles(files);
              return;
            }
            const text = e.clipboardData.getData("text/plain");
            if (project && isLongPaste(text)) {
              e.preventDefault();
              void attachText(text);
            }
          }}
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
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="cc-c-row">
          <button
            className="cc-clip"
            onClick={() => fileRef.current?.click()}
            aria-label="Adjuntar archivos"
            title="Adjuntar archivos o imágenes (también puedes pegarlos o arrastrarlos)"
          >
            <Icon name="clip" size={15} />
          </button>
          <DestPicker dest={dest} names={destNames} leader={leader} states={states} onChange={setDest} />
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
          <span className="cc-c-grow" />
          <button className="cc-send" disabled={(!draft.trim() && atts.length === 0) || attaching > 0} onClick={send} aria-label="Enviar" title="Enviar">
            <Icon name="send" />
          </button>
        </div>
      </div>
    </div>
  );

  // Agentes que esperan algo de ti: un permiso en su terminal (aunque no haya avisado el hub).
  const waiting = blocked.length + Object.keys(termPrompts).filter((a) => !blocked.some((b) => b.name === a)).length;

  return (
    <div className="cc">
      <header className="cc-top" data-tauri-drag-region>
        <div
          className="cc-projwrap"
          onClick={() => openSettings("general")}
          title={
            project
              ? `Proyecto: ${project}\nPulsa para cambiarlo`
              : "Elegir la carpeta del proyecto"
          }
        >
          <BrandIcon size={28} />
          <BrandWordmark height={20} />
          <span className="cc-slash">/</span>
          <span className="cc-branch-name" data-warn={project ? "0" : "1"}>
            {info?.repo ? info.branch || "…" : project ? shortPath(project) : "sin carpeta"}
          </span>
        </div>

        <TeamStrip agents={roster} states={states} onOpen={() => setOverlay("team")} />
        {waiting + openQuestions.length > 0 && (
          <button
            className="cc-alert"
            onClick={() => {
              // Las preguntas se contestan en el chat; los permisos, en su terminal (tareas).
              if (openQuestions.length > 0 || Object.keys(termPrompts).length > 0) {
                setOverlay(null);
                setView("feed");
              } else {
                setDrawerTab("tasks");
                setOverlay("tasks");
              }
            }}
          >
            <Icon name={openQuestions.length > 0 ? "msg" : "warn"} size={14} />
            {openQuestions.length > 0 && waiting === 0
              ? openQuestions.length === 1
                ? "Una pregunta para ti"
                : `${openQuestions.length} preguntas para ti`
              : waiting + openQuestions.length === 1
                ? "1 espera tu respuesta"
                : `${waiting + openQuestions.length} esperan tu respuesta`}
          </button>
        )}

        <div className="cc-top-r" data-tauri-drag-region>
          <button
            className="cc-hub"
            data-on={hubOk ? "1" : "0"}
            onClick={() => say(hubUrl ? `Hub local: ${hubUrl}` : "Hub local: sin datos todavía.")}
            title={hubUrl ? `Hub del equipo: ${hubUrl}` : "Hub del equipo"}
          >
            <span className="cc-dot" />
            {hubOk ? "Hub conectado" : "Hub sin conexión"}
          </button>
          <LimitsChip
            limits={state?.limits}
            canRead={roster
              .map((a) => a.name)
              .filter((n) => /antigravity|agy/i.test(n) && !!panelForAgent(layout.panels, n)?.sessionId)}
            onRead={(a) => void readUsage(a)}
            screens={usageScreens}
          />
          <div className="cc-modes">
            <button
              onClick={toggleNotify}
              data-off={notifyOn ? "0" : "1"}
              title={
                notifyOn
                  ? "Avisos de Windows activados: te aviso si un agente pide permiso, termina o te responde (pulsa para silenciar)"
                  : "Avisos de Windows silenciados (pulsa para activarlos)"
              }
              aria-label={notifyOn ? "Silenciar avisos" : "Activar avisos"}
            >
              <Icon name={notifyOn ? "bell" : "belloff"} size={15} />
            </button>
            <button
              onClick={() => openSettings(unseenErrors > 0 ? "errors" : "general")}
              title={unseenErrors > 0 ? `Ajustes · ${unseenErrors} error${unseenErrors === 1 ? "" : "es"} nuevo${unseenErrors === 1 ? "" : "s"}` : "Ajustes (Ctrl+,)"}
              aria-label="Ajustes"
              className="cc-gear"
            >
              <Icon name="settings" size={15} />
              {unseenErrors > 0 && <span className="cc-gear-dot" aria-hidden="true" />}
            </button>
          </div>
          <WindowControls />
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
          onRename={(c, t) => chats.rename(c.id, t)}
          project={project}
          otherProjects={otherProjects}
          switching={switching}
          onSwitchProject={(p, chatId) => void switchProject(p, { chatId })}
          onOpenFolder={() =>
            void pickFolder().then((p) => {
              if (p) void switchProject(p);
            })
          }
          onCreateProject={(n) => void createProject(n)}
          onRenameProject={(n) => void renameProject(n)}
        />

        <section className="cc-conv">
          {stageHead}

          {/* Cada pestaña entra con un leve deslizamiento (motion.css). */}
          <div className="cc-view" key={view}>
          {view === "feed" && (
            <ChatView
              events={msgs}
              resetKey={`${selKey}|${activeChat?.id ?? ""}`}
              live={live}
              team={(agentView ? [agentView] : online.map((a) => a.name)).filter((n) => !!n)}
              terminals={layout.panels
                .filter((p) => p.kind === "terminal" && !!p.cmd && !!p.sessionId)
                .map((p) => agentKeyFromCmd(p.cmd ?? ""))}
              leader={leader}
              tasks={tasks}
              project={project}
              onOpenTask={(id) => {
                setDiffTask(id);
                setView("history");
              }}
              onOpenPath={openPath}
              onTerminal={openTerm}
              onInterrupt={(n) => void interrupt(n)}
              questions={state?.questions}
              onAnswer={answerQuestion}
              onPrompt={(a, keys) => void answerPrompt(a, keys)}
              skills={skillLib}
              onSkill={skillFromChat}
              empty={
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
                      <button className="cc-quick-card" onClick={() => openSettings("general")}>
                        <b>Carpeta del proyecto</b>
                        <span>Elige la carpeta donde trabajan los agentes.</span>
                      </button>
                      <button className="cc-quick-card" onClick={() => openSettings("team")}>
                        <b>Normas del equipo</b>
                        <span>Escribe las normas del equipo y elige quién lo lidera.</span>
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
              }
            />
          )}

          {view === "research" && (
            <ResearchTab
              project={project}
              tasks={tasks}
              online={online.filter((a) => !!panelForAgent(layout.panels, a.name)?.sessionId).map((a) => a.name)}
              leader={leader}
              dispatchOn={dispatchOn}
              onDispatchOn={() => toggleDispatch(true)}
              onSay={say}
              onAsk={(text) => {
                setDraft(text);
                setView("feed");
              }}
            />
          )}

          {view === "history" && (
            <HistoryTab
              project={project}
              tasks={tasks}
              events={state?.events ?? []}
              focusTask={diffTask}
              onFocusTask={setDiffTask}
              onCount={onDiffCount}
              onSay={say}
              onTaskNote={(id, text) => void teamTaskComment(id, text).then(refresh).catch(() => {})}
              onOpenFile={(rel) => {
                setPreviewRel(rel);
                setView("app");
              }}
            />
          )}

          {view === "app" && (
            <AppTab
              project={project}
              events={state?.events ?? []}
              openRel={previewRel}
              onChooseProject={() => openSettings("general")}
              onSay={say}
              onAsk={(text) => {
                // Al compositor, para que lo revises y elijas a quién mandarlo.
                setDraft(text);
                setView("feed");
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
                  <TerminalPanel key={teamTermPanel.id} panel={teamTermPanel} />
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
                  <button className="agent-btn" onClick={() => openSettings("agents")}>
                    Conectar / abrir agentes
                  </button>
                )}
              </div>
            ))}
          </div>

          {closedBar}
          {view !== "research" && composer}
        </section>
      </div>

      {overlay === "newchat" && (
        <NewChatMenu
          agents={agents}
          leader={leader}
          collapsed={chatsMin}
          project={project}
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
            void launchAgent(name, agentLabel(name), { selectTerm: true });
          }}
          onRestart={(name) => {
            void restartAgent(name);
          }}
          onReload={(name) => void reloadAgent(name)}
          startedAt={startedAtRef.current}
          tails={tails}
          onAutoStart={toggleAutoStart}
          onSettings={() => openSettings("team")}
          usage={state?.usage}
          inbox={state?.inbox}
          onUsage={() => openSettings("usage")}
          limits={state?.limits}
          onReadUsage={(n) => void readUsage(n)}
          stalls={stalls}
          onAskStalled={(n) => void askStalled(n)}
          onInterrupt={(n) => void interrupt(n)}
        />
      )}

      {overlay === "tasks" && (
        <TasksDrawer
          tasks={chatTasks}
          earlier={earlierTasks}
          allTasks={tasks}
          chatTitle={activeChat?.title ?? "Conversación del equipo"}
          events={(state?.events ?? []).filter((e) => !HIDDEN_KINDS.has(e.kind) && inActive(e.ts_ms))}
          onOpenPath={(p) => {
            setOverlay(null);
            openPath(p);
          }}
          agentNames={agents.map((a) => a.name)}
          blocked={blockedNames}
          lastByAgent={lastByAgent}
          taskFileCount={taskFileCount}
          activeTaskId={view === "history" ? diffTask : null}
          hasProject={!!project}
          initialTab={drawerTab}
          memory={state?.memory ?? []}
          leader={leader}
          onComment={async (id, text) => {
            try {
              await teamTaskComment(id, text);
              refresh();
            } catch (e) {
              say(errMsg(e), true);
            }
          }}
          onMemoryAdd={async (text, kind) => {
            try {
              await teamMemoryAdd(text, kind);
              refresh();
            } catch (e) {
              say(errMsg(e), true);
            }
          }}
          onMemoryResolve={async (id, accept, text) => {
            try {
              await teamMemoryResolve(id, accept, text);
              refresh();
            } catch (e) {
              say(errMsg(e), true);
            }
          }}
          onMemoryForget={async (id) => {
            try {
              await teamMemoryForget(id);
              refresh();
            } catch (e) {
              say(errMsg(e), true);
            }
          }}
          dispatch={{ enabled: dispatchOn, state: dispatchView, onToggle: toggleDispatch, onRetry: retryDispatch }}
          onPreview={(rel) => {
            setPreviewRel(rel);
            setView("app");
            setOverlay(null);
          }}
          onClose={() => setOverlay(null)}
          onOpenTask={(id) => {
            if (!project) {
              openSettings("general");
              return;
            }
            setDiffTask(id);
            setView("history");
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

      <Toast flash={flash} onDismiss={() => setFlash(null)} />
      <InAppAvisos onOpen={openAviso} />

      {overlay === "settings" && (
        <SettingsModal
          initial={settingsAt}
          state={state}
          detect={detect}
          info={info}
          hubOk={hubOk}
          catalogs={catalogs}
          prefs={prefs}
          opening={opening}
          autoStart={autoStart}
          shoot={shoot}
          chatsMin={chatsMin}
          dispatchOn={dispatchOn}
          dispatchState={dispatchView}
          notifyOn={notifyOn}
          onClose={() => setOverlay(null)}
          say={say}
          onPref={setPref}
          onAutoStart={toggleAutoStart}
          onShoot={setShootMode}
          onChatsMin={(m) => {
            setChatsMin(m);
            saveFlag(CHATS_MIN_KEY, m);
          }}
          onDispatch={toggleDispatch}
          onDispatchClear={clearDispatch}
          onNotify={setNotify}
          onProject={(p) => (p ? switchProject(p) : saveProject(null))}
          onConnect={connectAgent}
          onOpenAgent={(id) => {
            void launchAgent(id, agentLabel(id), { selectTerm: false });
          }}
          onTeamRules={saveTeamRules}
        />
      )}
    </div>
  );
}
