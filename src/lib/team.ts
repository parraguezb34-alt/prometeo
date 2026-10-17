import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getLayout } from "../store";
import { termWrite } from "./pty";

export type TeamEvent = {
  seq: number;
  ts_ms: number;
  agent: string;
  session_id: string;
  kind: string;
  text: string;
  files: string[];
  to?: string | null;
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
};

export type TeamTask = {
  id: number;
  title: string;
  status: string; // open | claimed | done
  owner: string;
  notes: string;
  created_ms: number;
};

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
  now_ms: number;
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
export const teamOpen = (agent: string, mode: OpenMode = "exec") =>
  invoke<OpenResult>("team_open", { agent, mode });
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
export const teamAddTask = (title: string) =>
  invoke<void>("team_add_task", { title });
export const teamTaskOp = (id: number, op: string) =>
  invoke<void>("team_task_op", { id, op });
/** Log a direct user message to one agent in the feed (the text is typed into
 * its terminal by the caller). */
export const teamDm = (agent: string, text: string) =>
  invoke<void>("team_dm", { agent, text });

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

export function agentColor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function errMsg(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}

/** "C:\a\b\src\main.rs" -> "src/main.rs" */
export function shortPath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/") : path;
}

/** Map a terminal launch command to the agent id used by the hub. */
export function agentKeyFromCmd(cmd: string): string {
  const c = cmd.toLowerCase();
  if (c.includes("opencode")) return "opencode";
  if (c.includes("agy") || c.includes("antigravity")) return "antigravity";
  if (c.includes("claude")) return "claude";
  if (c.includes("codex")) return "codex";
  return c.split(/[\\/]/).pop()?.replace(/\.(exe|cmd|bat|ps1)$/i, "") || "agente";
}

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
    "orden. Espera la aprobación del usuario para empezar."
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

/** Prompt asking an agent for a handover summary before compacting/relaying. */
export const HANDOVER_PROMPT =
  "Publica un relevo compacto con team_update: qué has hecho, qué falta, decisiones tomadas y " +
  "dónde lo dejaste (para poder continuar después, incluso tras compactar).";

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
