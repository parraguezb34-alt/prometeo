import assert from "node:assert/strict";
import { startVisibleInterval } from "./lib/useVisibleInterval.js";

let passed = 0;
async function test(name, run) {
  await run();
  passed++;
  console.log("ok -", name);
}

class MockDocument {
  constructor(hidden = false) {
    this.hidden = hidden;
    this.listeners = new Set();
  }
  addEventListener(event, listener) {
    if (event === "visibilitychange") this.listeners.add(listener);
  }
  removeEventListener(event, listener) {
    if (event === "visibilitychange") this.listeners.delete(listener);
  }
  setVisible(visible) {
    this.hidden = !visible;
    for (const l of Array.from(this.listeners)) l();
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  await test("ejecuta periódicamente con ventana visible", async () => {
    const doc = new MockDocument(false);
    let count = 0;
    const cleanup = startVisibleInterval(() => count++, 30, null, doc);

    await sleep(75);
    cleanup();
    assert.ok(count >= 2, `Se esperaba al menos 2 ejecuciones, hubo ${count}`);
    const stoppedCount = count;
    await sleep(50);
    assert.equal(count, stoppedCount, "El cleanup debe detener el timer");
  });

  await test("pausa con ventana oculta (hiddenMs=null) y ejecuta inmediato al volver a visible", async () => {
    const doc = new MockDocument(false);
    let count = 0;
    const cleanup = startVisibleInterval(() => count++, 50, null, doc);

    // Pasa a oculto
    doc.setVisible(false);
    await sleep(110);
    assert.equal(count, 0, "No debe ejecutar mientras la ventana está oculta con hiddenMs=null");

    // Vuelve a visible
    doc.setVisible(true);
    assert.equal(count, 1, "Debe ejecutar inmediatamente al volver a visible");

    await sleep(65);
    cleanup();
    assert.ok(count >= 2, `Debe reanudar cadencia visible tras volver a visible, hubo ${count}`);
  });

  await test("espacia cadencia con ventana oculta (hiddenMs > 0) y ejecuta inmediato al volver", async () => {
    const doc = new MockDocument(false);
    let count = 0;
    // Visible: 20 ms, Oculto: 80 ms
    const cleanup = startVisibleInterval(() => count++, 20, 80, doc);

    doc.setVisible(false);
    await sleep(110);
    // En 110 ms con 80 ms de intervalo debe haber disparado 1 vez
    assert.equal(count, 1, `Debe espaciar según hiddenMs, hubo ${count}`);

    // Vuelve a visible
    doc.setVisible(true);
    assert.equal(count, 2, "Debe disparar inmediatamente al restaurar a visible");

    cleanup();
  });

  await test("limpia el listener de visibilitychange al hacer cleanup", () => {
    const doc = new MockDocument(false);
    assert.equal(doc.listeners.size, 0);
    const cleanup = startVisibleInterval(() => {}, 100, null, doc);
    assert.equal(doc.listeners.size, 1);
    cleanup();
    assert.equal(doc.listeners.size, 0, "Debe desuscribir el listener");
  });

  console.log(`${passed} pruebas de visibleinterval OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
