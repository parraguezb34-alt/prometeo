import assert from "node:assert/strict";
import { formatQuote, truncateQuote, MAX_QUOTE_CHARS } from "./lib/quote.js";

let passed = 0;
function test(name, run) {
  run();
  passed++;
  console.log("ok -", name);
}

test("recorta a ~600 caracteres la selección citada", () => {
  const shortText = "Texto breve";
  assert.equal(truncateQuote(shortText), "Texto breve");

  const longText = "a".repeat(800);
  const truncated = truncateQuote(longText);
  assert.equal(truncated.length, MAX_QUOTE_CHARS);
  assert.equal(truncated.length, 600);
});

test("antepone cada línea de la cita con '> ' más línea en blanco antes del mensaje propio", () => {
  const singleLine = formatQuote("pregunta del agente", "mi respuesta");
  assert.equal(singleLine, "> pregunta del agente\n\nmi respuesta");

  const multiLine = formatQuote("primera línea\nsegunda línea\ntercera", "entendido");
  assert.equal(multiLine, "> primera línea\n> segunda línea\n> tercera\n\nentendido");
});

test("manejo de cita vacía o nula devuelve el mensaje original", () => {
  assert.equal(formatQuote(null, "solo mi texto"), "solo mi texto");
  assert.equal(formatQuote("", "solo mi texto"), "solo mi texto");
  assert.equal(formatQuote("   ", "solo mi texto"), "solo mi texto");
});

console.log(`${passed} pruebas de cita OK`);
