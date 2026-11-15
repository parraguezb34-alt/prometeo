import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Se prueba el guardado real con disco y reloj inyectados, sin montar React ni abrir Tauri.
function harness(outcomes) {
  const timers = new Map();
  const writes = [];
  const storage = new Map();
  let timerId = 0;
  const window = {
    addEventListener() {},
    setTimeout(fn, delay) {
      const id = ++timerId;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  const localStorage = {
    getItem(k) { return storage.get(k) ?? null; },
    setItem(k, v) { storage.set(k, v); },
  };
  const chatsWrite = (_project, chats) => {
    writes.push(chats.map((chat) => chat.id));
    return (outcomes.shift() ?? true) ? Promise.resolve() : Promise.reject(new Error("disco ocupado"));
  };
  const modules = {
    react: {},
    "./team": { errMsg: (e) => e.message ?? String(e) },
    "./chatsDisk": { chatsWrite },
    "./notify": { notify() {} },
    "./errors": { reportError() {} },
    "./bridge": { isRemote: () => false },
  };
  const source = readFileSync(join(process.cwd(), "src/lib/chats.ts"), "utf8")
    + "\nexport { save as testSave, synced as testSynced, pendingSaves as testPending, lastSavedByProject as testSaved };\n";
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  runInNewContext(code, { exports, require: (name) => modules[name] ?? {}, window, localStorage });
  return {
    ...exports,
    timers,
    writes,
    fire() {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      timer.fn();
      return timer.delay;
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const project = "C:\\Proyectos\\Chats";
const key = `lienzo.chats.v1:${project}`;
const chat = (id) => ({ id, kind: "team", title: id, autoTitle: false, startMs: 0, createdMs: 1 });

{
  const h = harness([]);
  h.testSave(project, [chat("sin leer disco")]);
  assert.equal(h.writes.length, 0);
  assert.equal(h.testSaved.has(key), false, "la copia local antes de leer disco no es un guardado confirmado");
  console.log("ok - antes de leer disco no se anuncia un guardado confirmado");
}

{
  const h = harness([false, true]);
  h.testSynced.add(key);
  h.testSave(project, [chat("primero")]);
  await tick();
  assert.equal(h.testPending.get(key).chats[0].id, "primero");
  assert.equal(h.testSaved.has(key), false, "localStorage no confirma el guardado en disco");
  assert.equal(h.fire(), 20_000);
  await tick();
  assert.deepEqual(h.writes, [["primero"], ["primero"]]);
  assert.equal(h.testPending.has(key), false);
  assert.equal(h.testSaved.has(key), true);
  console.log("ok - un fallo de disco conserva la instantánea y reintenta antes de marcar guardado");
}

{
  const h = harness([false, false, true]);
  h.testSynced.add(key);
  h.testSave(project, [chat("viejo")]);
  await tick();
  h.testSave(project, [chat("nuevo")]);
  await tick();
  assert.equal(h.testPending.get(key).chats[0].id, "nuevo");
  assert.equal(h.fire(), 20_000);
  await tick();
  assert.deepEqual(h.writes, [["viejo"], ["nuevo"], ["nuevo"]]);
  assert.equal(h.testPending.has(key), false);
  console.log("ok - el reintento usa la instantánea más reciente");
}

{
  const h = harness([false, false, true]);
  h.testSynced.add(key);
  h.testSave(project, [chat("reintento")]);
  await tick();
  assert.equal(h.fire(), 20_000);
  await tick();
  assert.equal(h.fire(), 40_000);
  await tick();
  assert.equal(h.testPending.has(key), false);
  console.log("ok - los reintentos esperan cada vez más y paran al confirmar disco");
}
