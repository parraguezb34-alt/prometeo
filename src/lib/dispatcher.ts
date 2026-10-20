/**
 * Despachador ligero: cuando una tarea queda lista (abierta, sin dueño y con
 * todos sus padres hechos) y hay un agente libre, Prometeo le pide que la tome.
 *
 * Es lógica pura (sin Tauri ni React) para poder probarla. Los frenos copian lo
 * útil de un despachador de tableros: un solo trabajo en curso por agente, un
 * límite de fallos por tarea que la deja parada, y una pausa por agente tras
 * varios avisos seguidos sin respuesta (nada de tormentas de reintentos).
 */

export type DTask = {
  id: number;
  title: string;
  notes: string;
  status: string;
  owner: string;
  parents: number[];
  /** simple | media | dificil ("" = sin indicar). */
  level?: string;
  /** Agente al que va dirigida ("" = a quien esté libre). */
  assign?: string;
};

export type DAgent = {
  name: string;
  online: boolean;
  /** Prometeo tiene su terminal, así que puede escribirle. */
  hasTerminal: boolean;
  /** Espera tu permiso o respuesta: no se le molesta. */
  blocked: boolean;
  /** Último movimiento visible del agente (ms epoch); 0 si no hay. */
  lastActivityMs: number;
};

export type DispatchState = {
  /** Avisos en vuelo: tarea → a quién se pidió y cuándo. Esperan que la reclamen. */
  pending: Record<number, { agent: string; sentMs: number }>;
  /** Cuántas veces se avisó y nadie reclamó la tarea. */
  taskFails: Record<number, number>;
  /** Agentes que ya fallaron en cada tarea (no se les vuelve a pedir). */
  triedBy: Record<number, string[]>;
  /** Avisos seguidos sin respuesta por agente. */
  agentFails: Record<string, number>;
  agentPausedUntil: Record<string, number>;
  lastSentToAgent: Record<string, number>;
  lastSentAny: number;
};

export const EMPTY_DISPATCH: DispatchState = {
  pending: {},
  taskFails: {},
  triedBy: {},
  agentFails: {},
  agentPausedUntil: {},
  lastSentToAgent: {},
  lastSentAny: 0,
};

export type DispatchConfig = {
  /** Tiempo para que el agente reclame la tarea tras el aviso. */
  claimWaitMs: number;
  /** Fallos tras los que una tarea se queda parada hasta que la reintentes. */
  failureLimit: number;
  /** Avisos seguidos sin respuesta tras los que se pausa al agente. */
  agentFailLimit: number;
  pauseMs: number;
  /** Mínimo entre dos avisos al mismo agente. */
  agentCooldownMs: number;
  /** Mínimo entre dos avisos cualesquiera. */
  globalGapMs: number;
  /** Un agente con actividad más reciente que esto se considera ocupado. */
  idleMs: number;
  /** last = el líder solo si no hay nadie más · never = nunca · any = como uno más. */
  leaderMode: "last" | "never" | "any";
};

export const DISPATCH_CONFIG: DispatchConfig = {
  claimWaitMs: 90_000,
  failureLimit: 2,
  agentFailLimit: 3,
  pauseMs: 300_000,
  agentCooldownMs: 20_000,
  globalGapMs: 4_000,
  idleMs: 20_000,
  leaderMode: "last",
};

export type DispatchResult = {
  state: DispatchState;
  send: { taskId: number; agent: string } | null;
  /** Lo que pasó en este ciclo, para mostrarlo en el feed. */
  notes: string[];
};

/** Ids de los padres de la tarea que aún no están hechos. */
export function unmetParents(task: DTask, tasks: DTask[]): number[] {
  return task.parents.filter((id) => tasks.some((t) => t.id === id && t.status !== "done"));
}

/** Tarea lista para despachar: abierta, sin dueño y sin padres pendientes. */
export function isReady(task: DTask, tasks: DTask[]): boolean {
  return task.status === "open" && !task.owner && unmetParents(task, tasks).length === 0;
}

/** ¿La tarea está parada por haber fallado demasiadas veces? */
export function isParked(state: DispatchState, taskId: number, cfg = DISPATCH_CONFIG): boolean {
  return (state.taskFails[taskId] ?? 0) >= cfg.failureLimit;
}

/** El usuario quiere volver a intentarlo: se borran los fallos de la tarea. */
export function retryTask(state: DispatchState, taskId: number): DispatchState {
  const { [taskId]: _f, ...taskFails } = state.taskFails;
  const { [taskId]: _t, ...triedBy } = state.triedBy;
  const { [taskId]: _p, ...pending } = state.pending;
  return { ...state, taskFails, triedBy, pending };
}

/**
 * ¿Puede `agent` recibir esta tarea? Si va dirigida a alguien, solo ese. En modo director
 * las difíciles son del líder y el resto de los demás (salvo que no haya nadie más).
 */
export function eligible(
  task: DTask,
  agent: string,
  ctx: { leader: string; director: boolean; hasWorkers: boolean },
  cfg = DISPATCH_CONFIG,
): boolean {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (task.assign) return same(task.assign, agent);
  const isLeader = !!ctx.leader && same(agent, ctx.leader);
  if (ctx.director && ctx.leader) {
    if (task.level === "dificil") return isLeader;
    return !isLeader || !ctx.hasWorkers;
  }
  return !(cfg.leaderMode === "never" && isLeader);
}

/** El envío a la terminal falló: cuenta como aviso sin respuesta. */
export function sendFailed(
  state: DispatchState,
  taskId: number,
  agent: string,
  now: number,
  cfg = DISPATCH_CONFIG,
): DispatchState {
  const { [taskId]: _p, ...pending } = state.pending;
  const fails = (state.agentFails[agent] ?? 0) + 1;
  const paused = fails >= cfg.agentFailLimit;
  return {
    ...state,
    pending,
    agentFails: { ...state.agentFails, [agent]: paused ? 0 : fails },
    agentPausedUntil: paused ? { ...state.agentPausedUntil, [agent]: now + cfg.pauseMs } : state.agentPausedUntil,
  };
}

/**
 * Un ciclo del despachador: resuelve los avisos pendientes y, si procede,
 * elige una tarea lista y un agente libre. Devuelve el estado nuevo y, como
 * mucho, un aviso a enviar.
 */
export function tick(
  prev: DispatchState,
  input: { now: number; tasks: DTask[]; agents: DAgent[]; leader: string; director?: boolean },
  cfg: DispatchConfig = DISPATCH_CONFIG,
): DispatchResult {
  const { now, tasks, agents, leader } = input;
  const director = !!input.director;
  const notes: string[] = [];
  const state: DispatchState = {
    ...prev,
    pending: { ...prev.pending },
    taskFails: { ...prev.taskFails },
    triedBy: { ...prev.triedBy },
    agentFails: { ...prev.agentFails },
    agentPausedUntil: { ...prev.agentPausedUntil },
    lastSentToAgent: { ...prev.lastSentToAgent },
  };

  // 1) Avisos pendientes: ¿la reclamaron o se agotó el plazo?
  for (const key of Object.keys(state.pending)) {
    const id = Number(key);
    const p = state.pending[id];
    const task = tasks.find((t) => t.id === id);
    // Quedó fuera del chat abierto (empezaste otro): el aviso ya no cuenta, ni como fallo.
    if (task?.status === "fuera") {
      delete state.pending[id];
      continue;
    }
    if (!task || task.status === "done" || task.owner) {
      // Reclamada (o cerrada, o desaparecida): el aviso funcionó.
      if (task && task.owner === p.agent) state.agentFails[p.agent] = 0;
      delete state.pending[id];
      continue;
    }
    if (now - p.sentMs < cfg.claimWaitMs) continue;
    delete state.pending[id];
    state.taskFails[id] = (state.taskFails[id] ?? 0) + 1;
    state.triedBy[id] = [...(state.triedBy[id] ?? []), p.agent];
    const fails = (state.agentFails[p.agent] ?? 0) + 1;
    if (fails >= cfg.agentFailLimit) {
      state.agentFails[p.agent] = 0;
      state.agentPausedUntil[p.agent] = now + cfg.pauseMs;
      notes.push(`${p.agent} no respondió a ${cfg.agentFailLimit} avisos seguidos: en pausa ${Math.round(cfg.pauseMs / 60000)} min.`);
    } else {
      state.agentFails[p.agent] = fails;
    }
    notes.push(
      state.taskFails[id] >= cfg.failureLimit
        ? `#${id} se queda parada: nadie la reclamó tras ${state.taskFails[id]} avisos.`
        : `#${id}: ${p.agent} no la reclamó; pruebo con otro agente.`,
    );
  }

  // 2) Frenos globales.
  if (now - state.lastSentAny < cfg.globalGapMs) return { state, send: null, notes };

  // 3) Tareas listas, de la más antigua a la más nueva.
  const ready = tasks
    .filter((t) => isReady(t, tasks) && !state.pending[t.id] && !isParked(state, t.id, cfg))
    .sort((a, b) => a.id - b.id);
  if (ready.length === 0) return { state, send: null, notes };

  // 4) Agentes libres: en línea, con terminal, sin trabajo en curso ni aviso en vuelo.
  const busy = new Set<string>();
  for (const t of tasks) if (t.status === "claimed" && t.owner) busy.add(t.owner);
  for (const p of Object.values(state.pending)) busy.add(p.agent);
  const free = agents.filter(
    (a) =>
      a.online &&
      a.hasTerminal &&
      !a.blocked &&
      !busy.has(a.name) &&
      now >= (state.agentPausedUntil[a.name] ?? 0) &&
      now - (state.lastSentToAgent[a.name] ?? 0) >= cfg.agentCooldownMs &&
      now - a.lastActivityMs >= cfg.idleMs,
  );
  if (free.length === 0) return { state, send: null, notes };

  // 5) Primera tarea para la que haya agente: los trabajadores antes que el líder
  //    (que coordina), y entre ellos el que lleva más tiempo sin recibir nada.
  const hasWorkers = agents.some((a) => a.online && a.hasTerminal && a.name !== leader);
  const ctx = { leader, director, hasWorkers };
  for (const task of ready) {
    const tried = state.triedBy[task.id] ?? [];
    const options = free
      .filter((a) => !tried.includes(a.name) && eligible(task, a.name, ctx, cfg))
      .sort((a, b) => {
        const lead = cfg.leaderMode === "last" ? Number(a.name === leader) - Number(b.name === leader) : 0;
        if (lead !== 0) return lead;
        return (state.lastSentToAgent[a.name] ?? 0) - (state.lastSentToAgent[b.name] ?? 0);
      });
    const pick = options[0];
    if (!pick) continue;
    state.pending[task.id] = { agent: pick.name, sentMs: now };
    state.lastSentToAgent[pick.name] = now;
    state.lastSentAny = now;
    return { state, send: { taskId: task.id, agent: pick.name }, notes };
  }
  return { state, send: null, notes };
}

/** El aviso que se escribe en la terminal del agente (una sola línea). */
export function dispatchPrompt(task: DTask): string {
  // Un encargo largo no se teclea en la terminal: llega entero al reclamar la tarea.
  const brief = task.notes.trim().replace(/\s+/g, " ");
  const notes = !brief ? "" : brief.length <= 240 ? ` Notas: ${brief}.` : " Trae un encargo detallado: síguelo al pie de la letra.";
  const title = task.title.trim().replace(/\s+/g, " ");
  return (
    `📌 Despacho de Prometeo: toma la tarea #${task.id} «${title}».${notes} ` +
    `1) Reclámala con team_task_claim (id ${task.id}); recibirás el encargo y las entregas de las tareas previas. ` +
    `2) Mira team_context y reserva con team_claim_files lo que vayas a editar. ` +
    `3) Al terminar, ciérrala con team_task_done: summary (qué hiciste), files y evidence (cómo lo comprobaste). ` +
    `Usa exactamente las rutas que indique la tarea; si no está claro dónde crear algo, pregunta con team_message antes de crear archivos.`
  );
}
