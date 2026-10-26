import assert from "node:assert/strict";
import { EMPTY_DISPATCH, DISPATCH_CONFIG as C, tick, isParked, retryTask, sendFailed, dispatchPrompt, remindPrompt, verdictHold, VERDICT_READ_MS, VERDICT_MAX_MS } from "./lib/dispatcher.js";

const t = (id, status = "open", owner = "", parents = []) => ({ id, title: `t${id}`, notes: "", status, owner, parents });
const a = (name, extra = {}) => ({ name, online: true, hasTerminal: true, blocked: false, lastActivityMs: 0, ...extra });
const NOW = 1_000_000;
let n = 0;
function test(name, fn) {
  fn();
  n++;
  console.log("ok -", name);
}

test("despacha la tarea lista más antigua al agente libre", () => {
  const r = tick(EMPTY_DISPATCH, { now: NOW, tasks: [t(2), t(1)], agents: [a("claude")], leader: "" });
  assert.deepEqual(r.send, { taskId: 1, agent: "claude" });
  assert.equal(r.state.pending[1].agent, "claude");
});

test("no despacha tareas bloqueadas por sus padres", () => {
  const tasks = [t(1, "claimed", "x"), t(2, "open", "", [1])];
  const r = tick(EMPTY_DISPATCH, { now: NOW, tasks, agents: [a("claude")], leader: "" });
  assert.equal(r.send, null);
});

test("sí despacha cuando el padre ya está hecho", () => {
  const tasks = [t(1, "done"), t(2, "open", "", [1])];
  const r = tick(EMPTY_DISPATCH, { now: NOW, tasks, agents: [a("claude")], leader: "" });
  assert.equal(r.send.taskId, 2);
});

test("un solo trabajo en curso por agente", () => {
  const tasks = [t(1, "claimed", "claude"), t(2)];
  const r = tick(EMPTY_DISPATCH, { now: NOW, tasks, agents: [a("claude")], leader: "" });
  assert.equal(r.send, null);
});

test("no molesta a agentes bloqueados, sin terminal, sin conexión u ocupados", () => {
  const agents = [a("b", { blocked: true }), a("c", { hasTerminal: false }), a("d", { online: false }), a("e", { lastActivityMs: NOW - 5_000 })];
  assert.equal(tick(EMPTY_DISPATCH, { now: NOW, tasks: [t(1)], agents, leader: "" }).send, null);
});

test("prefiere a los trabajadores antes que al líder", () => {
  const r = tick(EMPTY_DISPATCH, { now: NOW, tasks: [t(1)], agents: [a("lider"), a("obrero")], leader: "lider" });
  assert.equal(r.send.agent, "obrero");
  const solo = tick(EMPTY_DISPATCH, { now: NOW, tasks: [t(1)], agents: [a("lider")], leader: "lider" });
  assert.equal(solo.send.agent, "lider");
});

test("modo del líder: nunca recibe tareas, o cuenta como uno más", () => {
  const never = { ...C, leaderMode: "never" };
  const solo = tick(EMPTY_DISPATCH, { now: NOW, tasks: [t(1)], agents: [a("lider")], leader: "lider" }, never);
  assert.equal(solo.send, null);
  const otro = tick(EMPTY_DISPATCH, { now: NOW, tasks: [t(1)], agents: [a("lider"), a("obrero")], leader: "lider" }, never);
  assert.equal(otro.send.agent, "obrero");
  const any = { ...C, leaderMode: "any" };
  const s = { ...EMPTY_DISPATCH, lastSentToAgent: { obrero: NOW - 60_000 } };
  const r = tick(s, { now: NOW, tasks: [t(1)], agents: [a("obrero"), a("lider")], leader: "lider" }, any);
  assert.equal(r.send.agent, "lider"); // lleva más tiempo sin recibir nada
});

test("no hay dos avisos seguidos: freno global y un aviso en vuelo por agente", () => {
  const r1 = tick(EMPTY_DISPATCH, { now: NOW, tasks: [t(1), t(2)], agents: [a("x"), a("y")], leader: "" });
  assert.ok(r1.send);
  const r2 = tick(r1.state, { now: NOW + 1_000, tasks: [t(1), t(2)], agents: [a("x"), a("y")], leader: "" });
  assert.equal(r2.send, null); // globalGapMs
  const r3 = tick(r1.state, { now: NOW + C.globalGapMs + 1, tasks: [t(1), t(2)], agents: [a("x"), a("y")], leader: "" });
  assert.equal(r3.send.taskId, 2);
  assert.notEqual(r3.send.agent, r1.send.agent);
});

test("si no la reclaman a tiempo, prueba con otro agente y no repite el mismo", () => {
  const agents = [a("x"), a("y")];
  const tasks = [t(1)];
  const r1 = tick(EMPTY_DISPATCH, { now: NOW, tasks, agents, leader: "" });
  const first = r1.send.agent;
  const later = NOW + C.claimWaitMs + 1;
  const r2 = tick(r1.state, { now: later, tasks, agents, leader: "" });
  assert.equal(r2.state.taskFails[1], 1);
  assert.ok(r2.send);
  assert.notEqual(r2.send.agent, first);
});

// Simula minutos de reloj sin que nadie reclame nada.
function simulate(state, tasks, agents, fromMs, toMs, step = 10_000) {
  const sends = [];
  let s = state;
  for (let now = fromMs; now <= toMs; now += step) {
    const r = tick(s, { now, tasks, agents, leader: "" });
    s = r.state;
    if (r.send) sends.push({ ...r.send, at: now });
  }
  return { s, sends };
}

test("tras el límite de fallos la tarea se queda parada hasta reintentar", () => {
  const agents = [a("x"), a("y"), a("z")];
  const tasks = [t(1)];
  const { s, sends } = simulate(EMPTY_DISPATCH, tasks, agents, NOW, NOW + 15 * 60_000);
  assert.equal(sends.length, C.failureLimit);
  assert.equal(new Set(sends.map((x) => x.agent)).size, C.failureLimit); // agentes distintos
  assert.ok(isParked(s, 1));
  const again = retryTask(s, 1);
  assert.equal(isParked(again, 1), false);
  const r = tick(again, { now: NOW + 16 * 60_000, tasks, agents, leader: "" });
  assert.ok(r.send);
});

test("pausa al agente tras varios avisos seguidos sin respuesta", () => {
  const agents = [a("x")];
  const tasks = [t(1), t(2), t(3), t(4)];
  const { s, sends } = simulate(EMPTY_DISPATCH, tasks, agents, NOW, NOW + 8 * 60_000);
  assert.equal(sends.length, C.agentFailLimit); // la cuarta no sale: el agente está en pausa
  assert.ok((s.agentPausedUntil.x ?? 0) > NOW + 4 * 60_000);
  // Pasada la pausa vuelve a recibir avisos.
  const later = simulate(s, tasks, agents, s.agentPausedUntil.x + 1, s.agentPausedUntil.x + 60_000);
  assert.ok(later.sends.length >= 1);
});

test("un aviso que se reclama limpia los fallos del agente", () => {
  const r1 = tick(EMPTY_DISPATCH, { now: NOW, tasks: [t(1)], agents: [a("x")], leader: "" });
  const s = { ...r1.state, agentFails: { x: 2 } };
  const r2 = tick(s, { now: NOW + 5_000, tasks: [t(1, "claimed", "x")], agents: [a("x")], leader: "" });
  assert.equal(r2.state.agentFails.x, 0);
  assert.deepEqual(r2.state.pending, {});
});

test("un envío fallido cuenta como aviso sin respuesta", () => {
  let s = { ...EMPTY_DISPATCH, pending: { 1: { agent: "x", sentMs: NOW } } };
  for (let i = 0; i < C.agentFailLimit; i++) s = sendFailed(s, 1, "x", NOW);
  assert.ok((s.agentPausedUntil.x ?? 0) > NOW);
  assert.deepEqual(s.pending, {});
});

test("el aviso es de una sola línea y cita la tarea", () => {
  const p = dispatchPrompt({ ...t(7), title: "Arreglar\nel login", notes: "ver\nlog" });
  assert.ok(!p.includes("\n"));
  assert.ok(p.includes("#7") && p.includes("team_task_claim") && p.includes("team_task_done"));
});

test("no reparte tareas de otros chats, pero siguen contando como padres", () => {
  const solo = tick(EMPTY_DISPATCH, { now: NOW, tasks: [t(1, "fuera")], agents: [a("x")], leader: "" });
  assert.equal(solo.send, null);
  const hija = tick(EMPTY_DISPATCH, { now: NOW, tasks: [t(1, "fuera"), t(2, "open", "", [1])], agents: [a("x")], leader: "" });
  assert.equal(hija.send, null);
});

test("un aviso cuya tarea pasa a otro chat se descarta sin contar fallo", () => {
  const r1 = tick(EMPTY_DISPATCH, { now: NOW, tasks: [t(1)], agents: [a("x")], leader: "" });
  const r2 = tick(r1.state, { now: NOW + C.claimWaitMs + 1, tasks: [t(1, "fuera")], agents: [a("x")], leader: "" });
  assert.deepEqual(r2.state.pending, {});
  assert.equal(r2.state.taskFails[1] ?? 0, 0);
  assert.equal(r2.state.agentFails.x ?? 0, 0);
});

test("una tarea dirigida solo va a su agente", () => {
  const task = { ...t(1), assign: "OpenCode" };
  const r = tick(EMPTY_DISPATCH, { now: NOW, tasks: [task], agents: [a("antigravity"), a("opencode")], leader: "" });
  assert.equal(r.send.agent, "opencode");
  const nadie = tick(EMPTY_DISPATCH, { now: NOW, tasks: [task], agents: [a("antigravity")], leader: "" });
  assert.equal(nadie.send, null);
});

test("modo director: lo difícil al líder, lo demás a los trabajadores", () => {
  const agents = [a("claude"), a("opencode")];
  const dificil = tick(EMPTY_DISPATCH, { now: NOW, tasks: [{ ...t(1), level: "dificil" }], agents, leader: "claude", director: true });
  assert.equal(dificil.send.agent, "claude");
  const simple = tick(EMPTY_DISPATCH, { now: NOW, tasks: [{ ...t(1), level: "simple" }], agents: [a("claude")], leader: "claude", director: true });
  assert.equal(simple.send.agent, "claude", "sin trabajadores, el líder la hace");
  const ocupado = tick(EMPTY_DISPATCH, {
    now: NOW,
    tasks: [t(1, "claimed", "opencode"), { ...t(2), level: "media" }],
    agents,
    leader: "claude",
    director: true,
  });
  assert.equal(ocupado.send, null, "con trabajadores ocupados, el líder no se la queda");
});

test("una entrega en revisión no se reparte y bloquea a sus hijas", () => {
  const r = tick(EMPTY_DISPATCH, { now: NOW, tasks: [t(1, "review", "opencode"), t(2, "open", "", [1])], agents: [a("x")], leader: "" });
  assert.equal(r.send, null);
});

test("un encargo largo no se teclea entero en la terminal", () => {
  const p = dispatchPrompt({ ...t(3), notes: "x".repeat(2000) });
  assert.ok(p.length < 900 && p.includes("encargo"));
});

// ---- Tareas a medias al reabrir Prometeo ----
const BOOT = NOW - 60_000; // Prometeo se abrió hace un minuto
const owned = (id, owner, extra = {}) => ({ ...t(id, "claimed", owner), ...extra });

test("recuerda una vez la tarea tomada antes de abrir Prometeo", () => {
  const input = { now: NOW, tasks: [owned(4, "opencode")], agents: [a("opencode")], leader: "", bootMs: BOOT };
  const r = tick(EMPTY_DISPATCH, input);
  assert.deepEqual(r.remind, { taskId: 4, agent: "opencode" });
  assert.equal(r.send, null);
  assert.equal(r.state.reminded[4], "opencode");
  const again = tick(r.state, { ...input, now: NOW + 600_000 });
  assert.equal(again.remind, null, "no se repite");
});

test("no recuerda si el agente ya trabaja en ella tras abrir", () => {
  const base = { now: NOW, tasks: [owned(4, "x")], leader: "", bootMs: BOOT };
  assert.equal(tick(EMPTY_DISPATCH, { ...base, agents: [a("x", { lastWorkMs: BOOT + 1_000 })] }).remind, null);
  assert.equal(tick(EMPTY_DISPATCH, { ...base, agents: [a("x", { busy: true })] }).remind, null);
  assert.equal(tick(EMPTY_DISPATCH, { ...base, agents: [a("x", { lastActivityMs: NOW - 5_000 })] }).remind, null);
});

test("no recuerda tareas tomadas después de abrir, ni sin bootMs, ni nada más abrir", () => {
  const agents = [a("x")];
  assert.equal(tick(EMPTY_DISPATCH, { now: NOW, tasks: [owned(4, "x", { claimedMs: BOOT + 10 })], agents, leader: "", bootMs: BOOT }).remind, null);
  assert.equal(tick(EMPTY_DISPATCH, { now: NOW, tasks: [owned(4, "x")], agents, leader: "" }).remind, null);
  assert.equal(tick(EMPTY_DISPATCH, { now: BOOT + C.remindAfterMs - 1, tasks: [owned(4, "x")], agents, leader: "", bootMs: BOOT }).remind, null);
});

test("no recuerda a un agente sin conexión, sin terminal o que te espera", () => {
  const base = { now: NOW, tasks: [owned(4, "x")], leader: "", bootMs: BOOT };
  for (const extra of [{ online: false }, { hasTerminal: false }, { blocked: true }])
    assert.equal(tick(EMPTY_DISPATCH, { ...base, agents: [a("x", extra)] }).remind, null);
});

test("el recordatorio respeta la pausa entre avisos y no estorba el reparto después", () => {
  const tasks = [owned(4, "x"), t(5)];
  const r = tick(EMPTY_DISPATCH, { now: NOW, tasks, agents: [a("x"), a("y")], leader: "", bootMs: BOOT });
  assert.equal(r.remind.taskId, 4);
  const pronto = tick(r.state, { now: NOW + 1_000, tasks, agents: [a("x"), a("y")], leader: "", bootMs: BOOT });
  assert.equal(pronto.send, null, "pausa global entre avisos");
  const luego = tick(r.state, { now: NOW + C.globalGapMs + 1, tasks, agents: [a("x"), a("y")], leader: "", bootMs: BOOT });
  assert.deepEqual(luego.send, { taskId: 5, agent: "y" }, "x sigue con su tarea; la nueva va a y");
});

test("un estado guardado sin «reminded» sigue funcionando", () => {
  const { reminded: _r, ...old } = EMPTY_DISPATCH;
  const r = tick(old, { now: NOW, tasks: [owned(4, "x")], agents: [a("x")], leader: "", bootMs: BOOT });
  assert.equal(r.remind.taskId, 4);
});

test("el recordatorio es una sola línea con el id de la tarea", () => {
  const p = remindPrompt({ ...t(9), title: "Arreglar\nel   login" });
  assert.ok(!p.includes("\n") && p.includes("#9") && p.includes("team_task_claim id 9") && p.includes("«Arreglar el login»"));
});

test("las tareas del plan sin aprobar no se reparten", () => {
  const r = tick(EMPTY_DISPATCH, { now: NOW, tasks: [t(1, "plan")], agents: [a("x")], leader: "" });
  assert.equal(r.send, null);
});

test("quien tiene una entrega en revisión espera el veredicto", () => {
  const r = tick(EMPTY_DISPATCH, { now: NOW, tasks: [t(1, "review", "x"), t(2)], agents: [a("x")], leader: "" });
  assert.equal(r.send, null);
});

test("tras un veredicto no se reparte hasta que lo lees", () => {
  const r = tick(EMPTY_DISPATCH, { now: NOW, tasks: [t(1)], agents: [a("x")], leader: "", holdUntil: NOW + 1 });
  assert.equal(r.send, null);
  assert.equal(tick(EMPTY_DISPATCH, { now: NOW, tasks: [t(1)], agents: [a("x")], leader: "", holdUntil: NOW }).send.taskId, 1);
});

test("el freno del veredicto dura hasta la respuesta del líder y un margen", () => {
  const ev = (agent, kind, text, ts_ms) => ({ agent, kind, text, ts_ms });
  const ok = ev("claude", "task", "#62 aprobada por claude", NOW);
  assert.equal(verdictHold([ok], "claude", NOW + 1_000), NOW + VERDICT_MAX_MS, "sin respuesta aún: espera");
  const said = ev("claude", "reply", "He dado por buena la tarea #62", NOW + 3_000);
  assert.equal(verdictHold([said, ok], "claude", NOW + 4_000), NOW + 3_000 + VERDICT_READ_MS);
  const fix = ev("claude", "message", "🔧 Corrige #70 «Informe»", NOW);
  assert.equal(verdictHold([fix], "claude", NOW), NOW + VERDICT_MAX_MS);
  assert.equal(verdictHold([ok], "claude", NOW + VERDICT_MAX_MS + 1), 0, "un veredicto viejo no frena");
  assert.equal(verdictHold([ev("opencode", "task", "#62 aprobada por opencode", NOW)], "claude", NOW), 0);
  assert.equal(verdictHold([ok], "", NOW), 0, "sin líder no hay veredictos");
});

console.log(`\n${n} pruebas pasadas`);

{
  const { tick: t2, EMPTY_DISPATCH: E } = await import("./lib/dispatcher.js");
  const NOW2 = 10_000_000;
  const ag = (name, pace) => ({ name, online: true, hasTerminal: true, blocked: false, lastActivityMs: 0, pace });
  const hard = [{ id: 1, title: "difícil", notes: "", status: "open", owner: "", parents: [], level: "dificil" }];
  const send = (agents) => t2(E, { now: NOW2, tasks: hard, agents, leader: "claude", director: true }).send?.agent;
  assert.equal(send([ag("claude", 0), ag("codex", 0), ag("opencode", 0)]), "codex", "a igualdad, la pareja (no engorda el contexto del líder)");
  assert.equal(send([ag("claude", -20), ag("codex", 15), ag("opencode", 0)]), "claude", "el líder va mucho más holgado: la hace él");
  assert.equal(send([ag("claude", 5), ag("codex", 0)]), "codex");
  assert.equal(send([ag("claude", 0), ag("codex", Infinity)]), "claude", "Codex pasado el 80 %: al líder");
  assert.equal(send([ag("claude", 30), ag("opencode", 0)]), "claude", "sin Codex, como siempre");
  // El líder con el ritmo muy por delante no la toma aunque Codex esté ocupado: espera a Codex.
  const busyCodex = [...hard, { id: 2, title: "otra", notes: "", status: "claimed", owner: "codex", parents: [] }];
  const r = t2(E, { now: NOW2, tasks: busyCodex, agents: [ag("claude", 30), ag("codex", 0)], leader: "claude", director: true });
  assert.equal(r.send, null);
  // Lo simple sigue sin ir al líder; lo asignado, a quien diga.
  const simple = [{ ...hard[0], level: "simple" }];
  assert.notEqual(t2(E, { now: NOW2, tasks: simple, agents: [ag("claude", -50), ag("codex", 0)], leader: "claude", director: true }).send?.agent, "claude");
  console.log("ok - lo difícil se reparte entre el líder y Codex según su cuota");
}
