import { useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "../App.css";
import "../cc2.css";
import "../chat.css";
import { ChatView } from "../components/ChatView";
import type { LiveAgent } from "../components/ChatView";
import { DestPicker } from "../components/DestPicker";
import type { Dest } from "../components/DestPicker";
import { Icon } from "../components/Icon";
import type { TeamEvent, TeamQuestion } from "../lib/team";
import type { Skill } from "../lib/skills";
import { detectPrompt } from "../lib/prompts";

/**
 * Banco de pruebas del chat (solo en desarrollo: http://localhost:1420/chat-lab.html).
 * Una conversación de ejemplo con todo lo que el chat sabe pintar y botones para
 * simular lo que pasa en vivo, sin necesitar la app de escritorio ni agentes reales.
 */

const T0 = Date.now() - 40 * 60_000;
let seq = 1000;
const ev = (
  min: number,
  agent: string,
  kind: string,
  text: string,
  extra: Partial<TeamEvent> = {},
): TeamEvent => ({
  seq: seq++,
  ts_ms: T0 + min * 60_000,
  agent,
  session_id: "",
  kind,
  text,
  files: [],
  ...extra,
});

const FIXTURE: TeamEvent[] = [
  ev(
    0,
    "tú",
    "broadcast",
    "Haz un juego 3D de carreras de buggies en el desierto dentro de juego3d/. Nada de librerías raras.",
  ),
  ev(
    0.4,
    "antigravity",
    "update",
    "[MODO PLAN] Propuesta lista: «Sandstorm Overdrive 3D» en juego3d/. 3 tareas creadas.",
  ),
  ev(0.5, "antigravity", "task", "#11 creada: Motor base, terreno fractal y cámara"),
  ev(0.5, "antigravity", "task", "#12 creada: Física del buggy y nitro (depende de 11)"),
  ev(0.6, "antigravity", "task", "#13 creada: HUD, sonido y carrera con checkpoints"),
  ev(1, "tú", "message", "📌 Despacho: #11 «Motor base, terreno fractal y cámara»", { to: "opencode" }),
  ev(1.2, "opencode", "task", "#11 tomada por opencode"),
  ev(1.3, "opencode", "claim", "reservó 3 archivos", {
    files: ["juego3d/index.html", "juego3d/src/main.js", "juego3d/src/world/terrain.js"],
  }),
  ev(1.5, "claude", "tool", "Bash npm create vite@latest juego3d -- --template vanilla", {}),
  ev(1.7, "claude", "tool", "Write juego3d/src/vehicle/vehicle.js", {
    files: ["C:/proj/juego3d/src/vehicle/vehicle.js"],
  }),
  ev(2.1, "claude", "tool", "Edit juego3d/src/main.js", { files: ["C:/proj/juego3d/src/main.js"] }),
  ev(2.4, "claude", "tool", "Bash node --check juego3d/src/vehicle/vehicle.js"),
  ev(3.0, "claude", "tool", "Read shots/buggy-1.png", { files: ["shots/buggy-1.png"] }),
  ev(3.1, "claude", "tool", "Read shots/buggy-2.png", { files: ["shots/buggy-2.png"] }),
  ev(3.2, "claude", "tool", "Read shots/buggy-3.png", { files: ["shots/buggy-3.png"] }),
  ev(3.3, "claude", "tool", "Read shots/buggy-4.png", { files: ["shots/buggy-4.png"] }),
  ev(
    4,
    "claude",
    "reply",
    "Listo el primer pase de la física del buggy:\n\n- Suspensión independiente en las **4 ruedas** con muelle-amortiguador.\n- Derrape cuando el ángulo de deslizamiento pasa de 12°.\n- Nitro con recarga en `vehicle.js`.\n\nLo comprobé con `node --check` y una captura en `shots/buggy-4.png`.\n\n```js\nconst grip = surface.sand ? 0.62 : 0.9;\n```",
  ),
  ev(
    9,
    "opencode",
    "message",
    "Hola @antigravity, respuesta a tu pregunta sobre index.html y el terreno/cielo:\n\n✅ Mi #11 está completo y verificado en disco: 14 módulos con node --check OK. Entregado: src/core/{config,engine,time,input}.js · src/camera/cameraModes.js · src/main.js (entry que publica window.JUEGO3D).\n\n🔓 index.html es tuyo: acabo de liberar mis reservas de juego3d/**.",
    { to: "antigravity" },
  ),
  ev(9.2, "opencode", "release", "liberó 3 archivos", { files: ["juego3d/index.html"] }),
  ev(
    9.4,
    "opencode",
    "task",
    "#11 hecha por opencode: Motor base con bucle fijo a 60 Hz, terreno fractal con 6 octavas de ruido, cielo con dispersión de Rayleigh y tres cámaras (persecución, capó y libre). Todo pasa node --check y se ve en http://localhost:8123. Además dejé un servidor mínimo en servidor.mjs y un ABRIR-JUEGO.bat para Windows que lo arranca y abre el navegador.",
    {
      files: [
        "juego3d/src/main.js",
        "juego3d/src/world/terrain.js",
        "juego3d/src/world/sky.js",
        "juego3d/servidor.mjs",
        "juego3d/ABRIR-JUEGO.bat",
      ],
    },
  ),
  ev(9.5, "opencode", "update", "Tarea #11 completada: motor base, terreno y cámaras listos."),
  ev(12, "claude", "waiting", "Claude needs your permission to use Bash"),
  ev(12.5, "claude", "tool", "Bash npm run build"),
  ev(13, "", "image", "shots/final.png", { files: ["shots/final.png"] }),
  ev(
    14,
    "antigravity",
    "message",
    "¡Recibido @opencode! Excelente trabajo con la arquitectura modular de #11.",
    { to: "opencode" },
  ),
  ev(15, "tú", "message", "¿Puedes revisar que el HUD se vea bien en 1366×768?", { to: "opencode" }),
  // Tal cual lo escribió Antigravity en una prueba real: listas anidadas, código dentro de
  // listas y enlaces a archivos con la etiqueta entre comillas de código.
  ev(
    16,
    "antigravity",
    "reply",
    "He leído el mensaje **#982** de Claude en el buzón y aplicado las correcciones solicitadas para la tarea **#18**:\n\n1. **Pruebas unitarias**: Se creó [`utilidades/fecha.test.js`](file:///C:/Users/parra/OneDrive/Escritorio/Nueva%20carpeta/utilidades/fecha.test.js) con `node:assert`, validando:\n   - [`formatearFecha`](file:///C:/Users/parra/OneDrive/Escritorio/Nueva%20carpeta/utilidades/fecha.js#L11-L16) con casos de un solo dígito (ceros a la izquierda) y fecha completa.\n   - [`diasEntre`](file:///C:/Users/parra/OneDrive/Escritorio/Nueva%20carpeta/utilidades/fecha.js#L26-L31) en orden cronológico e invertido (sin signo negativo) y mismo día.\n2. **Ejecución de pruebas**:\n   ```bash\n   node utilidades/fecha.test.js\n   ```\n   **Salida**:\n   ```\n   OK: todos los tests de fecha pasaron\n   ```\n3. **Entrega y liberación**: Se volvió a cerrar la tarea con `team_task_done` (ahora en estado *en revisión*) y se liberó la reserva del archivo con `team_release_files`. No fue necesario responder por mensaje ya que la entrega cubre todos los puntos.",
  ),
  ev(
    16.2,
    "antigravity",
    "task",
    "#18 entregada por antigravity: Se creó utilidades/fecha.test.js cubriendo formatearFecha (dígitos simples con padding y casos estándar) y diasEntre (caso orden ascendente e invertido) usando node:assert sin dependencias. Todos los tests pasan correctamente.",
    { files: ["utilidades/fecha.js", "utilidades/fecha.test.js"] },
  ),
  ev(
    16.3,
    "lienzo",
    "message",
    "🔎 Revisa la entrega de #18 «utilidades/fecha.js — formatearFecha y diasEntre» de antigravity (tras la ronda 1 de correcciones): Se creó utilidades/fecha.test.js cubriendo formatearFecha (dígitos simples con padding y casos estándar) y diasEntre (caso orden ascendente e invertido) usando node:assert sin dependencias. Todos los tests pasan correctamente. · Archivos: utilidades/fecha.js, utilidades/fecha.test.js · Evidencia: node utilidades/fecha.test.js OK: todos los tests de fecha pasaron. Decide con team_task_review: verdict ok, fix (con órdenes concretas) o take (la haces tú). Los cambios van debajo: no abras los archivos salvo que te falte algo.",
    { to: "claude", files: ["utilidades/fecha.js", "utilidades/fecha.test.js"] },
  ),
  ev(
    16.6,
    "claude",
    "message",
    "🔧 Corrige #18 «utilidades/fecha.js — formatearFecha y diasEntre» (ronda 2 de 2): 1. utilidades/fecha.test.js — falta el caso de fechas con años bisiestos; añade diasEntre('2024-02-28','2024-03-01') === 2. 2. Ejecuta node utilidades/fecha.test.js y pega la salida en evidence. Es la última ronda: si no queda bien, la asumirá el líder. Al terminar, ciérrala otra vez con team_task_done (summary, files, evidence).",
    { to: "antigravity" },
  ),
  ev(
    16.8,
    "lienzo",
    "message",
    "📝 Nueva tarea #19 «Formato de moneda en facturas» del usuario: escribe su encargo con team_task_brief (notes con la plantilla, level y, si hace falta, assign). Hasta entonces no se reparte.",
    { to: "claude" },
  ),
  ev(16.9, "claude", "question", "❓ q1 · ¿Qué estilo visual quieres para la web? (+1)", { to: "tú" }),
  ev(16.95, "antigravity", "skill", "Para la web nueva nos vendría bien una guía de diseño de interfaces.", {
    files: ["https://github.com/anthropics/skills/tree/main/skills/frontend-design"],
    to: "tú",
  }),
  ev(17, "claude", "task", "#18 la asume claude (era de antigravity)"),
  ev(17.1, "claude", "tool", "Bash node utilidades/fecha.test.js"),
  ev(
    17.3,
    "claude",
    "task",
    "#18 hecha por claude: Tomada tras la ronda 1 de corrección (prueba del flujo). antigravity entregó utilidades/fecha.js (formatearFecha y diasEntre) y, tras pedírselo en la corrección",
    { files: ["utilidades/fecha.js", "utilidades/fecha.test.js"] },
  ),
  ev(
    17.4,
    "claude",
    "reply",
    "La tarea #18 está cerrada. Resumen de la prueba del flujo:\n\n1. Repartí el encargo a antigravity (solo `utilidades/fecha.js`).\n2. Entregó código correcto → en la ronda 1 le pedí con `fix` que añadiera `utilidades/fecha.test.js` con `node:assert`.\n3. Volvió a entregar con el test incluido → la tomé con `take`, verifiqué ejecutando `node utilidades/fecha.test.js` (pasó sin errores) y la cerré yo con `team_task_done`.",
  ),
];

const LAB_PROMPT = detectPrompt([
  "  △ Permission required",
  "    ← Access external directory ~/OneDrive/Escritorio/pagian3daa/src/scene",
  "",
  "  Patterns",
  "",
  "  - C:/Users/parra/OneDrive/Escritorio/pagian3daa/src/scene/*",
  "",
  "   Allow once   Always allow   Reject          ctrl+f fullscreen  ⇆ select  enter confirm",
]);

const COLORS = ["#ff9a62", "#5bb4ff", "#b9a0ff", "#4ade9a", "#fbbf4a"];
const fakeImage = async (path: string) => {
  await new Promise((r) => setTimeout(r, 300 + Math.random() * 700));
  const c = COLORS[path.length % COLORS.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1a2236"/><stop offset="1" stop-color="${c}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><path d="M0 620 Q 320 520 640 600 T 1280 560 V800 H0Z" fill="#d6a35c" opacity=".85"/><text x="60" y="110" font-family="sans-serif" font-size="56" fill="#fff">${path}</text></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
};

function Lab() {
  const [events, setEvents] = useState<TeamEvent[]>(FIXTURE);
  const [dest, setDest] = useState<Dest>({ kind: "agent", name: "antigravity" });
  const [busy, setBusy] = useState<Record<string, number>>({ claude: Date.now() - 42_000 });
  const add = (e: Partial<TeamEvent> & { agent: string; kind: string; text: string }) =>
    setEvents((cur) => [...cur, { seq: seq++, ts_ms: Date.now(), session_id: "", files: [], ...e }]);
  const [lastAction, setLastAction] = useState<Record<string, string>>({});
  const [perm, setPerm] = useState(false);
  const [questions, setQuestions] = useState<TeamQuestion[]>([
    {
      id: 1,
      agent: "claude",
      ts_ms: T0 + 16.9 * 60_000,
      context: "Antes de repartir el trabajo de la web de facturas, quiero confirmar dos cosas.",
      items: [
        {
          question: "¿Qué estilo visual quieres para la web?",
          header: "Estilo",
          multi: false,
          options: [
            { label: "Sobrio y profesional", description: "Recomendado: tonos neutros, mucho aire, ideal para facturas." },
            { label: "Moderno y colorido", description: "Degradados y acentos vivos; más llamativo." },
            { label: "Como la app actual", description: "Reutiliza los colores y fuentes de lienzo." },
          ],
        },
        {
          question: "¿Qué debe incluir la primera versión?",
          header: "Alcance",
          multi: true,
          options: [
            { label: "Lista de facturas", description: "" },
            { label: "Crear y editar", description: "" },
            { label: "Exportar a PDF", description: "" },
            { label: "Pagos online", description: "Necesita cuenta de Stripe" },
          ],
        },
      ],
      answers: null,
      answered_ms: 0,
      detached: false,
      dismissed: false,
    },
  ]);
  const [skillLib, setSkillLib] = useState<Skill[]>([]);
  const live: LiveAgent[] = useMemo(
    () =>
      Object.entries(busy).map(([name, since]) => ({
        name,
        busy: true,
        since,
        status: name === "antigravity" ? "Generating..." : name === "claude" ? "Pondering…" : "",
        lastAction: name === "opencode" ? lastAction.opencode ?? "Bash npm test" : undefined,
        hasTerminal: true,
        prompt: name === "opencode" && perm ? (LAB_PROMPT ?? undefined) : undefined,
      })),
    [busy, lastAction, perm],
  );
  const toggle = (n: string) =>
    setBusy((b) => {
      const next = { ...b };
      if (next[n]) delete next[n];
      else next[n] = Date.now();
      return next;
    });

  /** Un turno entero de OpenCode: le escribes, trabaja paso a paso, contesta y cierra la tarea. */
  const simulate = () => {
    const steps: [number, () => void][] = [
      [0, () => add({ agent: "tú", kind: "message", text: "OpenCode, añade el minimapa al HUD y comprueba que compila.", to: "opencode" })],
      [900, () => setBusy((b) => ({ ...b, opencode: Date.now() }))],
      [2200, () => tool("Read juego3d/src/hud.js", ["juego3d/src/hud.js"])],
      [3600, () => tool("Search minimap|minimapa")],
      [5000, () => tool("Write juego3d/src/hud/minimap.js", ["juego3d/src/hud/minimap.js"])],
      [6600, () => tool("Edit juego3d/src/hud.js", ["juego3d/src/hud.js"])],
      [8200, () => tool("Bash node --check juego3d/src/hud/minimap.js")],
      [10200, () => {
        setBusy((b) => {
          const next = { ...b };
          delete next.opencode;
          return next;
        });
        add({
          agent: "opencode",
          kind: "reply",
          text: "Listo el **minimapa**:\n\n1. Nuevo `juego3d/src/hud/minimap.js` con el trazado y los checkpoints.\n   - Se dibuja en un `canvas` de 160×160 en la esquina.\n   - Gira con el buggy.\n2. Conectado desde `juego3d/src/hud.js`.\n\n```\n$ node --check juego3d/src/hud/minimap.js\n(sin errores)\n```",
        });
      }],
      [11000, () =>
        add({
          agent: "opencode",
          kind: "task",
          text: "#13 hecha por opencode: Minimapa en el HUD con trazado, checkpoints y rotación con el buggy; node --check sin errores.",
          files: ["juego3d/src/hud/minimap.js", "juego3d/src/hud.js"],
        })],
    ];
    for (const [ms, fn] of steps) window.setTimeout(fn, ms);
  };
  const tool = (text: string, files: string[] = []) => {
    setLastAction((a) => ({ ...a, opencode: text }));
    add({ agent: "opencode", kind: "tool", text, files });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "var(--bg)" }}>
      <div className="lab-bar">
        <b>Banco del chat</b>
        <button onClick={simulate}>▶▶ simular turno</button>
        <button
          onClick={() => {
            setBusy((b) => ({ ...b, opencode: b.opencode ?? Date.now() }));
            setPerm(true);
          }}
        >
          + permiso en terminal
        </button>
        {["claude", "antigravity", "opencode"].map((n) => (
          <button key={n} onClick={() => toggle(n)} data-on={busy[n] ? "1" : "0"}>
            {busy[n] ? "■" : "▶"} {n}
          </button>
        ))}
        <button
          onClick={() =>
            add({
              agent: "tú",
              kind: "message",
              text: "Antigravity, ¿cómo va la integración?",
              to: "antigravity",
            })
          }
        >
          + mensaje tuyo
        </button>
        <button
          onClick={() =>
            add({ agent: "tú", kind: "broadcast", text: "Equipo: revisad el rendimiento en portátiles." })
          }
        >
          + al equipo
        </button>
        <button
          onClick={() =>
            add({
              agent: "antigravity",
              kind: "message",
              text: "Voy con ello: ajusto el **LOD** del terreno y te aviso.",
              to: "tú",
            })
          }
        >
          + respuesta
        </button>
        <button
          onClick={() =>
            add({
              agent: "opencode",
              kind: "tool",
              text: "Edit juego3d/src/hud.js",
              files: ["juego3d/src/hud.js"],
            })
          }
        >
          + acción
        </button>
        <button
          onClick={() =>
            add({
              agent: "antigravity",
              kind: "task",
              text: "#13 hecha por antigravity: HUD con velocímetro, minimapa y cronómetro.",
              files: ["juego3d/src/hud.js"],
            })
          }
        >
          + tarea hecha
        </button>
        <button
          onClick={() =>
            add({ agent: "claude", kind: "waiting", text: "Claude needs your permission to use Write" })
          }
        >
          + permiso
        </button>
      </div>
      <section className="cc-conv" style={{ flex: 1, minHeight: 0 }}>
        <ChatView
          events={events}
          resetKey="lab"
          empty={<div className="cc-empty">Vacío</div>}
          live={live}
          team={["antigravity", "claude", "opencode"]}
          terminals={["antigravity", "claude", "opencode"]}
          leader="antigravity"
          tasks={[
            { id: 11, title: "Motor base, terreno fractal y cámara", status: "done" },
            { id: 12, title: "Física del buggy y nitro", status: "claimed" },
            { id: 13, title: "HUD, sonido y carrera con checkpoints", status: "open" },
          ]}
          project="C:/proj"
          onOpenPath={(p) => console.log("abrir", p)}
          onOpenTask={(id) => console.log("tarea", id)}
          onTerminal={(a) => console.log("terminal", a)}
          onInterrupt={(a) => toggle(a)}
          loadImage={fakeImage}
          onPrompt={(a, keys) => {
            console.log("teclas para", a, JSON.stringify(keys));
            setPerm(false);
          }}
          questions={questions}
          onAnswer={async (id, answers) => {
            await new Promise((r) => setTimeout(r, 400));
            setQuestions((qs) =>
              qs.map((q) => (q.id === id ? { ...q, answers, dismissed: answers === null, answered_ms: Date.now() } : q)),
            );
          }}
          skills={skillLib}
          onSkill={async (source) => {
            await new Promise((r) => setTimeout(r, 900));
            setSkillLib([
              {
                name: "frontend-design",
                description: "Interfaces con identidad propia",
                category: "diseno",
                mode: "auto",
                enabled: true,
                builtin: false,
                locked: false,
                source,
                installed_ms: Date.now(),
              },
            ]);
          }}
        />
      </section>
      <div className="cc-comp">
        <div className="cc-cbox">
          <textarea rows={1} placeholder="Mensaje para el equipo…" />
          <div className="cc-c-row">
            <DestPicker
              dest={dest}
              names={["antigravity", "claude", "opencode"]}
              leader="antigravity"
              states={
                new Map([
                  ["antigravity", busy.antigravity ? "work" : "idle"],
                  ["claude", "blocked"],
                  ["opencode", "idle"],
                ] as const)
              }
              onChange={setDest}
            />
            <div className="cc-shoot">
              <button data-active="1">
                <Icon name="list" size={13} />
                Planificar
              </button>
              <button data-active="0">Directo</button>
            </div>
            <span className="cc-c-grow" />
            <button className="cc-send" aria-label="Enviar">
              <Icon name="send" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<Lab />);
