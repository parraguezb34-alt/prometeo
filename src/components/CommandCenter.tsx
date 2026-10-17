import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addAgentTerminal, autoSpot, useLayout } from "../store";
import type { Panel } from "../store";
import {
  agentColor,
  agentCommands,
  agentKeyFromCmd,
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
  teamOpen,
  teamState,
  teamTaskOp,
} from "../lib/team";
import type { DetectResult, TeamEvent, TeamState } from "../lib/team";
import { termWrite } from "../lib/pty";
import { projectInfo } from "../lib/project";
import type { ProjectInfo } from "../lib/project";
import { GLYPHS } from "./FeedList";
import { AgentCard, AgentQuickCmds } from "./AgentCard";
import { DiffTab } from "./DiffTab";
import { FilesTab } from "./FilesTab";
import { PreviewTab } from "./PreviewTab";
import { TeamPanel } from "./TeamPanel";
import { TerminalPanel } from "./TerminalPanel";

type Mode = "command" | "canvas";

/** Conversation shown in the central chat: the whole team or one agent. */
type Sel = { kind: "team" } | { kind: "agent"; name: string };

/** What the center shows for the team destination. */
type CenterView = "feed" | "diff" | "preview" | "files";

/** Mission trigger mode: plan-first or straight to execution. */
type Shoot = "plan" | "exec";

type Drawer = { kind: "team"; agents?: boolean } | null;

const SHOOT_KEY = "lienzo.shoot.v1";

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
export function CommandCenter({ onMode }: { onMode: (mode: Mode) => void }) {
  const layout = useLayout();
  const [state, setState] = useState<TeamState | null>(null);
  const [detect, setDetect] = useState<DetectResult | null>(null);
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [sel, setSel] = useState<Sel>({ kind: "team" });
  const [view, setView] = useState<CenterView>("feed");
  const [tab, setTab] = useState<"chat" | "term">("chat");
  const [shoot, setShoot] = useState<Shoot>(loadShoot);
  const [taskFilter, setTaskFilter] = useState<"all" | "active" | "done">("all");
  const [changeCount, setChangeCount] = useState<number | null>(null);
  const [diffTask, setDiffTask] = useState<number | null>(null);
  const [previewRel, setPreviewRel] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [taskDraft, setTaskDraft] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
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
    const interval = window.setInterval(refresh, 4000);
    return () => {
      unlisten.then((f) => f());
      window.clearInterval(interval);
      if (flashTimer.current !== undefined) window.clearTimeout(flashTimer.current);
    };
  }, [refresh, refreshDetect]);

  // Esc closes the team drawer.
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawer(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  const project = state?.project ?? null;

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
  const leader = state?.leader ?? "";
  const done = tasks.filter((t) => t.status === "done").length;
  const total = tasks.length;
  const openTasks = tasks.filter((t) => t.status !== "done").length;

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
  const msgs = useMemo(() => {
    const all = (state?.events ?? []).slice(0, 400).reverse();
    if (sel.kind === "team") return all;
    return all.filter(
      (e) =>
        (e.agent === sel.name && e.kind !== "tool") ||
        e.to === sel.name ||
        e.kind === "broadcast",
    );
  }, [state, sel]);

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
  }, [selKey, tab, view, msgs.length]);

  const selectAgent = (name: string, to: "chat" | "term" = "chat") => {
    setSel({ kind: "agent", name });
    setTab(to);
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
      const r = await teamOpen(id, shoot);
      if (r.kind === "app") {
        say(`✓ ${label} se está abriendo en su app de escritorio…`);
      } else {
        const spot = autoSpot();
        addAgentTerminal(spot.x, spot.y, label, r.cmd);
        if (opts.selectTerm) {
          selectAgent(agentKeyFromCmd(r.cmd), "term");
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
    if (p) selectAgent(name, "term");
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

    let target: Sel = sel;
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

  const mention = (key: string) => {
    setDraft((d) => {
      const stripped = d.replace(/^@[\w\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1.-]+\s+/, "");
      return `@${key} ${stripped}`;
    });
    areaRef.current?.focus();
  };

  const addTask = async () => {
    const t = taskDraft.trim();
    if (!t) return;
    try {
      await teamAddTask(t);
      setTaskDraft("");
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
        <div className="cc-msg" data-who={mine ? "me" : "agent"} key={e.seq}>
          <div className="cc-msg-head">
            <span style={{ color: mine ? undefined : agentColor(e.agent) }}>
              {mine ? "tú" : e.agent}
            </span>
            {e.to ? <span>→ {e.to}</span> : null}
            <span>{ago(e.ts_ms)}</span>
          </div>
          <div className="cc-msg-body">{e.kind === "broadcast" ? `📣 ${e.text}` : e.text}</div>
        </div>
      );
    }
    return (
      <div className="cc-sys" key={e.seq}>
        <span className="cc-sys-glyph">{GLYPHS[e.kind] ?? "•"}</span>
        <span className="cc-sys-main">
          <span style={{ color: agentColor(e.agent) }}>{e.agent}</span>
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
  const termPanel = agentView ? panelForAgent(layout.panels, agentView) : undefined;
  const termInlineId =
    sel.kind === "agent" && tab === "term" && termPanel ? termPanel.id : null;

  // Terminals not shown inline still live (mounted off-screen) so the agents
  // keep working and are ready the moment you look at them.
  const hiddenTerms = layout.panels.filter(
    (p) => p.kind === "terminal" && !!p.cmd && p.id !== termInlineId,
  );

  const filteredTasks = tasks
    .filter((t) =>
      taskFilter === "all"
        ? true
        : taskFilter === "done"
          ? t.status === "done"
          : t.status !== "done",
    )
    .slice()
    .reverse();

  const teamHead = (
    <div className="cc-chat-head">
      <div className="cc-chat-tabs cc-chat-tabs-left">
        <button data-active={view === "feed" ? "1" : "0"} onClick={() => setView("feed")}>
          💬 Feed
        </button>
        <button data-active={view === "diff" ? "1" : "0"} onClick={() => setView("diff")}>
          ± Cambios{changeCount ? ` (${changeCount})` : ""}
        </button>
        <button data-active={view === "preview" ? "1" : "0"} onClick={() => setView("preview")}>
          👁 Preview
        </button>
        <button data-active={view === "files" ? "1" : "0"} onClick={() => setView("files")}>
          📁 Archivos
        </button>
      </div>
      <span className="cc-chat-sub">
        {online.length} en línea
        {leader ? ` · líder: ${leader}` : ""}
        {project ? ` · ${shortPath(project)}` : ""}
      </span>
    </div>
  );

  const composer = (
    <div className="cc-input-wrap">
      <div className="cc-input-top">
        <div className="cc-pills">
          <button className="cc-pill" onClick={() => mention("todos")} title="Misión para todo el equipo">
            👥 Todos
          </button>
          <button
            className="cc-pill"
            disabled={!leader}
            onClick={() => mention("lider")}
            title={leader ? `Solo para el líder (${leader})` : "Elige un líder para esto"}
          >
            👑 Líder
          </button>
          {agents.map((a) => (
            <button
              className="cc-pill"
              key={a.session_id}
              onClick={() => mention(a.name)}
              title={`Solo para ${a.name}`}
            >
              @{a.name}
            </button>
          ))}
        </div>
        <div className="cc-shoot" title="Planificar = analiza y propone el reparto sin tocar código; Ejecutar = a trabajar ya">
          <button data-active={shoot === "plan" ? "1" : "0"} onClick={() => setShootMode("plan")}>
            📋 Planificar
          </button>
          <button data-active={shoot === "exec" ? "1" : "0"} onClick={() => setShootMode("exec")}>
            ⚡ Ejecutar
          </button>
        </div>
      </div>
      <div className="cc-input">
        <textarea
          ref={areaRef}
          rows={1}
          value={draft}
          placeholder={
            sel.kind === "team"
              ? shoot === "plan"
                ? "Misión en modo plan: el líder propondrá el reparto y esperará tu OK…"
                : "Misión para todo el equipo… (Enter envía, Shift+Enter salto de línea; @lider, @claude…)"
              : shoot === "plan"
                ? `Plan para ${sel.name}: analiza y propone sin editar nada…`
                : `Mensaje para ${sel.name}… (se escribe en su terminal)`
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
        <button className="agent-btn cc-send" disabled={!draft.trim()} onClick={send}>
          Enviar
        </button>
      </div>
    </div>
  );

  return (
    <div className="cc">
      <header className="cc-top">
        <div className="cc-brand">
          <span className="cc-logo">⬒</span> lienzo
        </div>
        <div className="cc-modes">
          <button data-active="1" title="Centro de mando: chat, diffs, preview y archivos">
            ◫ Comando
          </button>
          <button
            data-active="0"
            onClick={() => onMode("canvas")}
            title="Lienzo: terminales y paneles en el espacio (depuración / topología)"
          >
            ⬚ Lienzo
          </button>
        </div>
        <button
          className="cc-proj"
          data-warn={project ? "0" : "1"}
          onClick={() => openDrawer(true)}
          title={project ? `Proyecto: ${project}\nPulsa para cambiarlo` : "Elegir la carpeta del proyecto"}
        >
          {project ? `📁 ${shortPath(project)}` : "📁 sin carpeta"}
          {info?.repo ? <span className="cc-branch"> · 🌿 {info.branch || "…"}</span> : null}
        </button>
        <div className="cc-summary">
          <button
            className="cc-hub"
            data-on={hubOk ? "1" : "0"}
            onClick={() => say(hubUrl ? `Hub local: ${hubUrl}` : "Hub local: sin datos todavía.")}
            title={hubUrl ? `Hub del equipo: ${hubUrl}` : "Hub del equipo"}
          >
            ● Hub
          </button>
          <span>
            {done}/{total} tareas
          </span>
          <span>·</span>
          <span>
            {online.length} agente{online.length === 1 ? "" : "s"}
          </span>
          <button className="agent-btn" data-ghost="1" onClick={() => openDrawer(true)}>
            ⚙ Equipo
          </button>
        </div>
      </header>

      <div className="cc-main">
        <aside className="cc-side">
          <div className="cc-side-scroll">
            <button
              className="cc-dest"
              data-active={sel.kind === "team" ? "1" : "0"}
              onClick={() => setSel({ kind: "team" })}
              title="Centro de artefactos + chat del equipo"
            >
              <span>💬 Equipo</span>
              <span className="cc-dest-sub">{online.length} en línea</span>
            </button>

            {blocked.length > 0 && (
              <>
                <div className="cc-side-title">🚨 Bloqueos</div>
                {blocked.map((a) => {
                  const ev = lastByAgent.get(a.name);
                  return (
                    <div className="cc-block" key={a.session_id}>
                      <div className="cc-block-text">🚨 {ev?.text ?? "pide tu respuesta"}</div>
                      <div className="cc-block-actions">
                        <button className="task-btn" onClick={() => selectAgent(a.name)}>
                          Responder
                        </button>
                        <button className="task-btn" onClick={() => openTerm(a.name)}>
                          ▸_ Terminal
                        </button>
                      </div>
                    </div>
                  );
                })}
              </>
            )}

            <div className="cc-side-title">Agentes</div>
            {agents.length === 0 && (
              <div className="cc-side-empty">
                Sin sesiones conectadas todavía. Usa «＋ Conectar» o lanza el escuadrón.
              </div>
            )}
            {agents.map((a) => (
              <AgentCard
                key={a.session_id}
                agent={a}
                leader={leader}
                active={sel.kind === "agent" && sel.name === a.name}
                task={claimedBy.get(a.name)}
                last={lastByAgent.get(a.name)}
                onSelect={() => selectAgent(a.name)}
                onTerminal={() => openTerm(a.name)}
                onCrown={() => toggleLeader(a.name)}
                onCmd={(cmd, note) => writeAgent(a.name, cmd, note)}
              />
            ))}
            <button className="cc-side-connect" onClick={() => openDrawer(true)}>
              ＋ Conectar / abrir agentes
            </button>

            <div className="cc-side-title">
              Tareas ({openTasks} abiertas)
            </div>
            <div className="cc-filters">
              <button data-active={taskFilter === "all" ? "1" : "0"} onClick={() => setTaskFilter("all")}>
                Todas
              </button>
              <button
                data-active={taskFilter === "active" ? "1" : "0"}
                onClick={() => setTaskFilter("active")}
              >
                En curso
              </button>
              <button
                data-active={taskFilter === "done" ? "1" : "0"}
                onClick={() => setTaskFilter("done")}
              >
                Hechas
              </button>
            </div>
            {tasks.length === 0 && (
              <div className="cc-side-empty">
                Sin tareas. El equipo las crea al trabajar, o añade una aquí abajo.
              </div>
            )}
            {filteredTasks.map((t) => (
              <div
                className="cc-task"
                key={t.id}
                data-done={t.status === "done" ? "1" : "0"}
                onClick={() => {
                  if (project) {
                    setDiffTask(t.id);
                    setView("diff");
                  } else {
                    openDrawer(true);
                  }
                }}
                title={
                  project
                    ? `Ver los cambios de la tarea #${t.id} en el centro`
                    : "Elige la carpeta del proyecto para ver cambios"
                }
              >
                <span className="task-chip" data-s={t.status}>
                  #{t.id}
                </span>
                <span className="cc-task-title">{t.title}</span>
                {t.handover && (
                  <span
                    className="cc-task-handover"
                    title={`Relevo de ${t.handover.by} hace ${ago(t.handover.ts_ms)}: ${t.handover.text}`}
                  >
                    📝
                  </span>
                )}
                {t.owner && (
                  <span
                    className="cc-task-owner"
                    style={{ color: agentColor(t.owner) }}
                    title={`en manos de ${t.owner}`}
                  >
                    {t.owner}
                  </span>
                )}
                {t.status === "done" ? (
                  <button
                    className="cc-task-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      taskOp(t.id, "reopen");
                    }}
                    title="Reabrir"
                  >
                    ↺
                  </button>
                ) : (
                  <button
                    className="cc-task-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      taskOp(t.id, "done");
                    }}
                    title="Marcar hecha"
                  >
                    ✓
                  </button>
                )}
              </div>
            ))}
            <div className="team-task-add cc-task-add">
              <input
                type="text"
                value={taskDraft}
                placeholder="Nueva tarea…"
                onChange={(e) => setTaskDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addTask();
                }}
              />
              <button className="agent-btn" onClick={addTask} disabled={!taskDraft.trim()}>
                ＋
              </button>
            </div>
          </div>
        </aside>

        <section className="cc-conv">
          {sel.kind === "team" ? (
            <>
              {teamHead}
              {view === "feed" && (
                <>
                  <div className="cc-chat" ref={chatRef} onScroll={onChatScroll}>
                    {msgs.length === 0 ? (
                      online.length === 0 ? (
                        <div className="cc-empty">
                          <div className="cc-empty-title">Tu equipo, en un clic</div>
                          <div className="cc-quick">
                            <button className="cc-quick-card" onClick={launchSquad}>
                              <b>⚡ Lanzar escuadrón</b>
                              <span>Abre los agentes instalados ya dentro del proyecto (en modo plan si lo tienes puesto).</span>
                            </button>
                            <button className="cc-quick-card" onClick={() => openDrawer(true)}>
                              <b>📂 Carpeta del proyecto</b>
                              <span>Elige dónde trabajan los agentes y de dónde salen los diffs y el preview.</span>
                            </button>
                            <button className="cc-quick-card" onClick={() => openDrawer(true)}>
                              <b>📜 Normas del equipo</b>
                              <span>Ajusta el Charter, elige líder y conecta cada CLI.</span>
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="cc-empty">
                          Aquí verás todo lo que hace el equipo: mensajes, tareas, avances y avisos,
                          en vivo.
                          <br />
                          Escribe abajo una misión y se repartirá con instrucciones de coordinación.
                        </div>
                      )
                    ) : (
                      msgs.map(renderEvent)
                    )}
                  </div>
                  {composer}
                </>
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
            </>
          ) : (
            <>
              <div className="cc-chat-head">
                <span className="agent-dot" data-on={agentRow?.online ? "1" : "0"} />
                <span className="cc-chat-title" style={{ color: agentColor(sel.name) }}>
                  {sel.name}
                </span>
                {leader === sel.name && <span className="prog-lead">líder</span>}
                <span className="cc-chat-sub">
                  {agentTask
                    ? `#${agentTask.id} ${agentTask.title}`
                    : agentRow
                      ? agentRow.online
                        ? `en línea · visto hace ${ago(agentRow.last_seen_ms)}`
                        : "sin sesión viva"
                      : "sin sesión conectada"}
                </span>
                <div className="cc-chat-tabs">
                  <button data-active={tab === "chat" ? "1" : "0"} onClick={() => setTab("chat")}>
                    💬 Conversación
                  </button>
                  <button data-active={tab === "term" ? "1" : "0"} onClick={() => setTab("term")}>
                    ▸_ Terminal
                  </button>
                </div>
              </div>

              {tab === "term" ? (
                termPanel ? (
                  <div className="cc-termwrap">
                    <div className="cc-term-bar">
                      <AgentQuickCmds
                        agent={sel.name}
                        withEsc
                        onCmd={(cmd, note) => writeAgent(sel.name, cmd, note)}
                      />
                      <span className="cc-term-hint">⌨ se escribe en su terminal</span>
                    </div>
                    <div className="cc-termbox">
                      <TerminalPanel panel={termPanel} lod={false} />
                    </div>
                  </div>
                ) : (
                  <div className="cc-empty">
                    <div>
                      {sel.name} todavía no tiene terminal abierta.
                      <br />
                      Ábrela aquí y podrás verlo trabajar y escribirle directo.
                    </div>
                    <button
                      className="agent-btn"
                      disabled={opening === sel.name}
                      onClick={() => launchAgent(sel.name, sel.name)}
                    >
                      {opening === sel.name ? "Abriendo…" : "▸_ Lanzar terminal"}
                    </button>
                  </div>
                )
              ) : (
                <>
                  <div className="cc-chat" ref={chatRef} onScroll={onChatScroll}>
                    {msgs.length === 0 ? (
                      <div className="cc-empty">
                        Conversación con {sel.name}. Lo que escribas va directo a su terminal; sus
                        avances y mensajes aparecerán aquí.
                      </div>
                    ) : (
                      msgs.map(renderEvent)
                    )}
                  </div>
                  {composer}
                </>
              )}
            </>
          )}
        </section>
      </div>

      {/* Terminales ocultas pero vivas: los agentes siguen corriendo aunque no
          estés mirándolos, y aparecen al instante al abrir su pestaña. */}
      <div className="cc-hideterms" aria-hidden="true">
        {hiddenTerms.map((p) => (
          <TerminalPanel key={p.id} panel={p} lod={false} />
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
                  selectAgent(agentKeyFromCmd(p.cmd ?? ""), "term");
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
