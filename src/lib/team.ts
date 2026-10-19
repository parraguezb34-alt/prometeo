import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getLayout } from "../store";
import { termWrite } from "./pty";
import { agentKeyFromCmd } from "./agentKey";

export type TeamEvent = {
  seq: number;
  ts_ms: number;
  agent: string;
  session_id: string;
  kind: string;
  text: string;
  files: string[];
  to?: string | null;
  /** Tarea ligada al evento (p.ej. un relevo guardado con team_handover_save). */
  task_id?: number | null;
};

export type TeamAgent = {
  session_id: string;
  name: string;
  project: string;
  pid: number;
  last_seen_ms: number;
  online: boolean;
  /** Telemetría real reportada por el puente (Claude Code): modelo y contexto. */
  model?: string | null;
  ctx_tokens?: number | null;
  ctx_window?: number | null;
  ctx_ms?: number | null;
  /** Id de la conversación del propio CLI (Claude Code, Codex), que llega por sus hooks. */
  cli_session?: string | null;
};

export type TeamHandover = {
  text: string;
  by: string;
  ts_ms: number;
  files: string[];
};

/** Entrega al cerrar una tarea: qué se hizo, dónde y con qué prueba. */
export type TeamTaskResult = {
  summary: string;
  files: string[];
  evidence: string;
  by: string;
  ts_ms: number;
};

/** Nota en el tablón de una tarea. */
export type TeamTaskComment = { by: string; text: string; ts_ms: number };

/** Entrada de la memoria del proyecto (active = guardada, proposed = pendiente del líder). */
export type MemoryEntry = {
  id: number;
  text: string;
  kind: string;
  by: string;
  ts_ms: number;
  status: string;
};

export type TeamTask = {
  id: number;
  title: string;
  status: string; // draft | open | claimed | review | done
  owner: string;
  notes: string;
  created_ms: number;
  /** Último relevo con memoria guardado por su dueño (team_handover_save). */
  handover?: TeamHandover | null;
  /** Tareas que deben estar hechas antes de poder reclamar esta. */
  parents?: number[];
  /** Entrega al cerrarla. */
  result?: TeamTaskResult | null;
  /** Tablón de la tarea. */
  comments?: TeamTaskComment[];
  /** Dificultad: simple | media | dificil ("" = sin indicar). */
  level?: string;
  /** Agente al que va dirigida ("" = a quien esté libre). */
  assign?: string;
  /** Rondas de corrección en modo director. */
  fix_rounds?: number;
  /** Tokens gastados en la tarea por cada agente. */
  cost?: Record<string, AgentUsage>;
};

/** Ids de los padres de una tarea que aún no están hechos. */
export function waitingFor(task: TeamTask, tasks: TeamTask[]): number[] {
  return (task.parents ?? []).filter((id) => tasks.some((t) => t.id === id && t.status !== "done"));
}

export type TeamClaim = {
  path: string;
  session_id: string;
  agent: string;
  ts_ms: number;
};

export type TeamState = {
  seq: number;
  project: string | null;
  charter: string | null;
  leader: string | null;
  agents: TeamAgent[];
  events: TeamEvent[];
  tasks: TeamTask[];
  claims: TeamClaim[];
  memory?: MemoryEntry[];
  /** Mensajes sin leer del buzón de cada agente (solo los que tienen alguno). */
  inbox?: Record<string, InboxInfo>;
  /** Tokens gastados por agente desde `usage_since`. */
  usage?: Record<string, AgentUsage>;
  usage_since?: number;
  /** Modo director: el líder reparte y revisa las entregas de los demás. */
  director?: boolean;
  /** Rondas de corrección antes de que el líder asuma la tarea. */
  fix_limit?: number;
  /** Qué se le da bien a cada agente (lo escribes tú; el líder lo usa para repartir). */
  strengths?: Record<string, string>;
  /** Preguntas de los agentes al usuario (las últimas, de la más nueva a la más vieja). */
  questions?: TeamQuestion[];
  now_ms: number;
};

export type QOption = { label: string; description: string };
export type QItem = { question: string; header: string; options: QOption[]; multi: boolean };
export type QAnswer = { question: string; choices: string[]; other: string };
export type TeamQuestion = {
  id: number;
  agent: string;
  ts_ms: number;
  context: string;
  items: QItem[];
  answers: QAnswer[] | null;
  answered_ms: number;
  detached: boolean;
  dismissed: boolean;
};

export type InboxInfo = { unread: number; direct?: number; last_seq: number; from: string[] };

export type AgentUsage = {
  input: number;
  output: number;
  /** Leídos de la caché del proveedor: cuestan una fracción. */
  cache_read: number;
  cache_write: number;
  turns: number;
  /** Tokens (estimados) que lienzo no inyectó porque el contexto del equipo no cambió. */
  saved_ctx: number;
  /** Contexto liberado al compactar. */
  freed: number;
  compactions: number;
};

export type TeamDetails = {
  url: string;
  token: string;
  mcp_exe: string | null;
  state_file: string;
};

export type AgentDetect = {
  id: string;
  label: string;
  cli_found: boolean;
  config_dir_found: boolean;
  connected: boolean;
  mcp_exe_ok: boolean;
};

export type DetectResult = {
  agents: AgentDetect[];
  project: string | null;
};

export type ConnectResult = {
  files: string[];
  notes: string[];
};

export type OpenResult = { kind: "pty"; cmd: string } | { kind: "app" };

/** How an agent is launched: `plan` arranca su modo de planificacion. */
export type OpenMode = "plan" | "exec";

export const teamState = () => invoke<TeamState>("team_state");
export const teamDetails = () => invoke<TeamDetails>("team_details");
export const teamDetect = () => invoke<DetectResult>("team_detect");
export const teamConnect = (agent: string, project: string | null) =>
  invoke<ConnectResult>("team_connect", { agent, project });
/** Opciones al abrir un agente: modelo, esfuerzo y retomar la conversación de la carpeta. */
export type OpenOpts = { model?: string | null; effort?: string | null; resume?: boolean };

export const teamOpen = (agent: string, mode: OpenMode = "exec", opts: OpenOpts = {}) =>
  invoke<OpenResult>("team_open", {
    agent,
    mode,
    model: opts.model ?? null,
    effort: opts.effort ?? null,
    resume: opts.resume ?? false,
  });

/** Conversación más reciente de un agente en la carpeta, si su CLI la deja leer (Antigravity). */
export const teamAgentSession = (agent: string, project: string) =>
  invoke<string | null>("team_agent_session", { agent, project });

export type ModelEntry = { id: string; label: string; efforts: string[] };

/** Lo que cada agente admite: modelos, niveles de esfuerzo y lo que tiene configurado. */
export type ModelCatalog = {
  models: ModelEntry[];
  efforts: string[];
  current: { model: string | null; effort: string | null };
  /** Se puede cambiar en caliente tecleando comandos; si no, hay que reiniciar la sesión. */
  live: boolean;
};

export const teamModels = (agent: string) => invoke<ModelCatalog>("team_models", { agent });
export const teamProjectSet = (path: string | null) =>
  invoke<void>("team_project_set", { path });
/** Send a prompt to every connected agent (feed + terminal injection). */
export const teamBroadcast = (text: string) => invoke<number>("team_broadcast", { text });
/** Mark a broadcast as already typed into the terminals of these agents. */
export const teamBroadcastAck = (agents: string[]) => invoke<void>("team_broadcast_ack", { agents });
/** Save the shared team rules and/or pick the leader. */
export const teamCharter = (charter: string | null, leader: string | null) =>
  invoke<void>("team_charter", { charter, leader });
/** Change who coordinates the team (without touching the charter). */
export const teamLeader = (leader: string | null) =>
  invoke<void>("team_leader", { leader });
export const teamAddTask = (title: string, parents: number[] = []) =>
  invoke<void>("team_add_task", { title, parents });
export const teamTaskComment = (id: number, text: string) =>
  invoke<void>("team_task_comment", { id, text });
export const teamMemoryAdd = (text: string, kind: string) =>
  invoke<void>("team_memory_add", { text, kind });
export const teamMemoryResolve = (id: number, accept: boolean, text?: string) =>
  invoke<void>("team_memory_resolve", { id, accept, text: text ?? null });
export const teamMemoryForget = (id: number) => invoke<void>("team_memory_forget", { id });
export const teamTaskOp = (id: number, op: string) =>
  invoke<void>("team_task_op", { id, op });
/** Log a direct user message to one agent in the feed (the text is typed into
 * its terminal by the caller). */
export const teamDm = (agent: string, text: string) =>
  invoke<void>("team_dm", { agent, text });
/** Contesta la pregunta de un agente (`null` = descartarla). `late`: el texto que hay que
 * escribirle en la terminal porque su herramienta ya no esperaba. */
export const teamAnswer = (id: number, answers: QAnswer[] | null) =>
  invoke<{ agent: string; late: string | null }>("team_answer", { id, answers });
/** Empieza a contar el consumo de tokens desde cero. */
export const teamUsageReset = () => invoke<void>("team_usage_reset");
/** Modo director: el líder reparte, revisa y manda corregir (como mucho `fixLimit` rondas). */
export const teamDirector = (enabled: boolean, fixLimit?: number) =>
  invoke<void>("team_director", { enabled, fixLimit: fixLimit ?? null });
export const teamStrengths = (agent: string, text: string) => invoke<void>("team_strengths", { agent, text });

/** Compacta la sesión de OpenCode de un proyecto con la API de su servidor
 * local (sin teclear en la TUI: la vía fiable para el relevo con memoria). */
export const compactOpencode = (project: string) =>
  invoke<string>("opencode_compact", { project });

/** Live updates pushed by the hub whenever team state changes. */
export const onTeamUpdate = (fn: () => void) =>
  listen("team://update", () => fn()).catch(() => () => {});

export function ago(ts: number): string {
  const seconds = Math.max(0, (Date.now() - ts) / 1000);
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

const PALETTE = [
  "#7aa2f7",
  "#9ece6a",
  "#f7768e",
  "#e0af68",
  "#bb9af7",
  "#7dcfff",
  "#ff9e64",
];

/** Identidad fija de los agentes conocidos (tokens de App.css). */
const IDENTITY: [string, string][] = [
  ["claude", "var(--c-claude)"],
  ["opencode", "var(--c-opencode)"],
  ["codex", "var(--c-codex)"],
  ["antigravity", "var(--c-antigravity)"],
  ["agy", "var(--c-antigravity)"],
];

export function agentColor(name: string): string {
  const low = name.toLowerCase();
  for (const [key, color] of IDENTITY) if (low.includes(key)) return color;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** Nombre para mostrar: «Claude Code», «OpenCode»… (el hub guarda el id en minúsculas). */
export function agentLabel(name: string): string {
  const low = name.toLowerCase();
  if (low.includes("claude")) return "Claude Code";
  if (low.includes("opencode")) return "OpenCode";
  if (low.includes("codex")) return "Codex";
  if (low.includes("antigravity") || low === "agy") return "Antigravity";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Letra del avatar: C Claude, O OpenCode, X Codex, A Antigravity. */
export function agentInitial(name: string): string {
  const low = name.toLowerCase();
  if (low.includes("claude")) return "C";
  if (low.includes("opencode")) return "O";
  if (low.includes("codex")) return "X";
  if (low.includes("antigravity") || low === "agy") return "A";
  return (name.trim()[0] ?? "?").toUpperCase();
}

export function errMsg(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}

/** "C:\a\b\src\main.rs" -> "src/main.rs" */
export function shortPath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/") : path;
}

export { agentKeyFromCmd };

/** Wrap the user's message with the team protocol before typing it into each
 * agent terminal. Single line on purpose: it is submitted as-is into their
 * prompt box, and without this agents tend to just work alone. */
export function buildBroadcastPrompt(text: string, leader: string): string {
  return (
    "📣 MENSAJE DEL USUARIO PARA TODO EL EQUIPO — varios agentes trabajáis juntos en este " +
    "proyecto mediante el MCP «lienzo-team». Petición: «" +
    text +
    "». Antes de empezar, llama a team_context para ver compañeros, tareas y reservas. " +
    (leader ? `Líder del equipo: ${leader}; respeta su reparto. ` : "") +
    "Descompón el trabajo: crea tareas con team_task_create o reclama las abiertas con " +
    "team_task_claim; publica tu plan y cada avance con team_update; reserva los archivos " +
    "con team_claim_files antes de editarlos; y usa team_message para coordinarte con los " +
    "demás agentes. Al terminar tu parte, publica un resumen con team_update."
  );
}

/** Wrap a request in "plan first" mode: analyze, propose tasks, touch nothing. */
export function buildPlanPrompt(text: string, leader: string): string {
  return (
    "📋 MODO PLAN (el usuario aprueba antes de tocar código) — petición: «" +
    text +
    "». " +
    (leader ? `Líder del equipo: ${leader}; reparte tú. ` : "") +
    "Analiza el proyecto (team_context, team_feed, los archivos) y NO edites ni reserves archivos " +
    "todavía. Descompón el trabajo en tareas claras con team_task_create (una por parte, con título " +
    "accionable) y publica tu plan con team_update: qué tarea, qué agente debería llevarla y en qué " +
    "orden. Si la petición nombra una carpeta o archivos, escribe en cada tarea la ruta completa " +
    "(absoluta) para que todos trabajen en el mismo sitio. ANTES de proponer nada, si la petición deja " +
    "decisiones abiertas (alcance, estilo, tecnología, prioridades, qué incluir), pregúntaselas al " +
    "usuario con team_ask_user: varias preguntas con opciones concretas, para no trabajar a ciegas. " +
    "Espera la aprobación del usuario para empezar."
  );
}

/** Publish a plan request to the whole team: nobody edits until the user says so. */
export function pushPlan(text: string, leader: string): Promise<number> {
  return pushPrompt(text, buildPlanPrompt(text, leader));
}

/** Type a raw prompt into every open agent terminal (publishes `text` on the
 * feed too, and acks the delivery so hooks don't repeat it). Returns how many
 * agents got it directly in their terminal. */
export async function pushPrompt(text: string, prompt: string): Promise<number> {
  await teamBroadcast(text);
  const panels = getLayout().panels.filter(
    (p) => p.kind === "terminal" && !!p.sessionId && !!p.cmd,
  );
  const agentsTyped = new Set<string>();
  for (const p of panels) {
    try {
      await termWrite(p.sessionId!, `${prompt}\r`);
      agentsTyped.add(agentKeyFromCmd(p.cmd ?? ""));
    } catch {
      /* session may have died; the feed still has the message */
    }
  }
  if (agentsTyped.size > 0) {
    // Typed = delivered for those agents; skip duplicate hook delivery.
    await teamBroadcastAck([...agentsTyped]).catch(() => {});
  }
  return agentsTyped.size;
}

/** Publish a prompt to the whole team: feed + typed into every open agent
 * terminal (wrapped with the coordination protocol). Returns how many agents
 * received it directly in their terminal. */
export function pushBroadcast(text: string, leader: string): Promise<number> {
  return pushPrompt(text, buildBroadcastPrompt(text, leader));
}

/** Relevo con memoria: el agente guarda su resumen pegado a la tarea y lienzo
 * compacta su contexto después (sin amnesia). */
export const HANDOVER_SAVE_PROMPT =
  "🔄 MEMORIA ANTES DE COMPACTAR: guarda ya tu relevo con la herramienta team_handover_save " +
  "(task_id de tu tarea actual si la tienes; summary con: qué hiciste, decisiones tomadas y qué " +
  "falta; files con lo que tocaste). En cuanto lo guardes, lienzo compactará tu contexto " +
  "automáticamente: no hagas /compact tú, solo guarda el relevo y sigue.";

export type AgentCommands = {
  /** Slash commands to switch model (or open its picker). */
  model: { label: string; cmd: string }[];
  /** Keystroke that cycles its mode (Plan / permisos) in the TUI. */
  modeSeq: string | null;
  /** Command that compacts its context. */
  compact: string | null;
};

/** What we know how to inject into each agent CLI (conservative: only what is
 * verified for that CLI; unknown commands would end up as a prompt). */
export function agentCommands(agent: string): AgentCommands {
  switch (agent.toLowerCase()) {
    case "claude":
      return {
        model: [
          { label: "Abrir selector (/model)", cmd: "/model" },
          { label: "Opus", cmd: "/model opus" },
          { label: "Sonnet", cmd: "/model sonnet" },
          { label: "Haiku", cmd: "/model haiku" },
          { label: "Predeterminado", cmd: "/model default" },
        ],
        modeSeq: "\x1b[Z",
        compact: "/compact",
      };
    case "opencode":
      return {
        model: [{ label: "Abrir selector (/models)", cmd: "/models" }],
        modeSeq: "\t",
        compact: null,
      };
    case "codex":
      return {
        model: [{ label: "Abrir selector (/model)", cmd: "/model" }],
        modeSeq: null,
        compact: "/compact",
      };
    case "antigravity":
      return {
        model: [{ label: "Abrir selector (/model)", cmd: "/model" }],
        modeSeq: null,
        compact: null,
      };
    default:
      return { model: [], modeSeq: null, compact: null };
  }
}
