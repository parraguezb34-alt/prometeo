import { useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/manrope";
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
import type { TeamEvent } from "../lib/team";

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
];

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
  const live: LiveAgent[] = useMemo(
    () =>
      Object.entries(busy).map(([name, since]) => ({
        name,
        busy: true,
        since,
        status: name === "antigravity" ? "Generating..." : name === "claude" ? "Pondering…" : "",
        lastAction: name === "opencode" ? "Bash npm test" : undefined,
        hasTerminal: true,
      })),
    [busy],
  );
  const toggle = (n: string) =>
    setBusy((b) => {
      const next = { ...b };
      if (next[n]) delete next[n];
      else next[n] = Date.now();
      return next;
    });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "var(--bg)" }}>
      <div className="lab-bar">
        <b>Banco del chat</b>
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
