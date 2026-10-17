# lienzo

Canvas infinito + terminales para orquestar agentes de IA.
Recreación **ligera y mejorada** de Deska: Tauri 2 + Rust + React (nada de Electron ni 300 MB de asar).

## Estado actual (F1 + Equipo) ✅

- **Centro de Mando (vista principal)**: los agentes viven en un **dock** compacto (qué hace cada uno *ahora mismo* y qué tarea tiene), el centro es un **escenario** con Tareas + Actividad en tiempo real, y las **terminales se abren bajo demanda en un cajón lateral** (pulsa un agente; `Esc` cierra). El **lienzo espacial** sigue disponible como vista secundaria (`⬚ Lienzo` / `← Comando`); las terminales ocultas siguen vivas (PTY + scrollback).
- **Lienzo infinito**: arrastra el fondo para mover, rueda del ratón para zoom al cursor, `Shift+rueda` para desplazarte en horizontal.
- **Terminales reales** (ConPTY vía `portable-pty`) como paneles:
  - Doble clic en el lienzo → nueva terminal.
  - Arrastra el título para mover, esquina inferior derecha para redimensionar.
  - El PTY se redimensiona contigo (el shell recibe `SIGWINCH` / resize real).
- **Sesiones persistentes (borrador)**: el backend Rust mantiene cada PTY vivo y guarda hasta 512 KB de scrollback. Si la interfaz se recarga, los paneles se **re-adjuntan solos** y repintan el historial.
- **Zoom semántico (LOD)**: por debajo del 35% de zoom los paneles se convierten en tarjetas de título (menos trabajo de render, navegación del conjunto).
- **Persistencia del layout**: paneles, posiciones, tamaños y vista se guardan en `localStorage`.
- **Capó de equipo (agentes trabajando juntos)**:
  - Panel **Equipo** en el lienzo (`+ Equipo`): actividad en vivo, tareas compartidas y conexión de agentes.
  - **`lienzo-mcp.exe`**: puente MCP universal. Da a cualquier agente las herramientas `team_context`, `team_update`, `team_feed`, `team_message`, `team_task_*`, `team_claim_files` / `team_release_files`.
  - **Conexión con 1 clic**: detecta Claude Code, Codex, OpenCode y Antigravity y escribe su configuración (`.mcp.json`, `~/.codex/config.toml`, `opencode.json`, `.agents/mcp_config.json`) + bloque de protocolo en `AGENTS.md`/`CLAUDE.md`.
  - **Reporte automático**: los hooks de Claude Code (y Codex) publican cada edición/comando en el feed y **inyectan el contexto del equipo en cada prompt** — Claude ve lo que hizo otro agente antes de responder.
  - **Sin pisarse archivos**: `team_claim_files` reserva archivos y devuelve conflictos si otro agente ya los tiene.
  - **Hub local** (Rust, `127.0.0.1` + token): descubrimiento en `%APPDATA%\lienzo\hub.json`; las terminales que abre lienzo heredan `LIENZO_HUB` / `LIENZO_TOKEN`.
- **Orquestador del equipo** 🎛️:
  - **Prompt para todos** (📣 barra arriba del panel Equipo): publica el mensaje en el feed y lo **escribe en la terminal de cada agente abierto** en el lienzo (OpenCode/Antigravity/Claude la reciben al instante), y a Claude en cualquier ventana le llega como bloque del **hook Stop** cuando termina su turno. El texto viaja **envuelto con el protocolo de equipo** (llama a `team_context`, reparte/reclama tareas, publica avances con `team_update`, reserva archivos) para que los agentes coordinen de verdad en vez de trabajar cada uno por su cuenta.
  - **Normas del equipo (system prompt global)**: texto editable en la pestaña Agentes que se inyecta a los agentes en `team_context`, en las instrucciones del MCP y en cada prompt vía hooks — saben que trabajan juntos y cómo coordinarse.
  - **Jerarquía sin peleas**: un **líder** (el primero que conecta, o el que elijas) coordina y reparte; los demás proponen y ejecutan su parte.
  - **Tareas huérfanas**: si el agente que reclamó una tarea deja de latir (su puente murió), el hub la **libera solo** — vuelve a *abierta* con un aviso `↺` en el feed. No hay tareas colgadas para siempre.
  - **Panel Progreso** (`+ Progreso`, arriba a la derecha): barra de % completado, una línea **«Ahora mismo» por agente** con su última actividad, agentes en línea con su líder y tareas pendientes/hechas de un vistazo.

## Arquitectura

| Pieza | Archivo | Qué hace |
| --- | --- | --- |
| Gestor PTY (Rust) | `src-tauri/src/pty.rs` | Spawn de shell, streaming base64 por eventos `pty://data` / `pty://exit`, scrollback ring buffer, inyecta env del hub |
| Hub de equipo (Rust) | `src-tauri/src/hub/mod.rs` | Estado compartido: agentes, feed, tareas, reservas; persistencia en `%APPDATA%\lienzo\team-state.json` |
| API HTTP del hub | `src-tauri/src/hub/server.rs` | `127.0.0.1` puerto aleatorio + token: `/join`, `/event`, `/feed`, `/state`, `/task`, `/claim`, `/release`, `/broadcast`, `/pending`, `/charter` |
| Conectores | `src-tauri/src/hub/connectors.rs` | Detección de agentes y escritura de configs (Claude/Codex/OpenCode/Antigravity) |
| Puente MCP | `src-tauri/src/bin/lienzo-mcp.rs` | Servidor MCP por stdio (`team_*` + recursos `team://`) y modo `hook` para Claude Code / Codex |
| Registro de comandos | `src-tauri/src/lib.rs` | `term_*` + `team_*` (estado, tareas, detectar/conectar agentes) |
| Estado del lienzo | `src/store.ts` | Paneles (terminal/equipo/progreso) + vista con `useSyncExternalStore` y persistencia |
| Lienzo | `src/components/Canvas.tsx` | Paneo, zoom, LOD, barra de herramientas |
| Marco de panel | `src/components/PanelFrame.tsx` | Mover, redimensionar, cerrar, traer al frente |
| Terminal | `src/components/TerminalPanel.tsx` | xterm.js + re-attach a la sesión PTY |
| Panel Equipo | `src/components/TeamPanel.tsx` | Actividad, tareas, agentes, prompt para todos (📣), normas y líder (también en el cajón del Centro de Mando) |
| Panel Progreso | `src/components/TasksPanel.tsx` | Barra de avance, agentes en línea y tablero compacto |
| Centro de Mando | `src/components/CommandCenter.tsx` | Vista principal: dock de agentes, escenario (tareas + actividad), cajón de terminal y de equipo |
| Feed compartido | `src/components/FeedList.tsx` | Lista de actividad reutilizada por el panel Equipo y el Centro de Mando |

## Conectar un agente (equipo)

1. Abre el panel **Equipo** (`+ Equipo` en la barra) → pestaña **Agentes**.
2. Escribe la carpeta del proyecto y pulsa **Guardar**.
3. Pulsa **Conectar** en el agente que quieras (Claude Code, Codex, OpenCode, Antigravity).
4. Pulsa **Abrir** para lanzarlo ya dentro del proyecto: Claude/Codex/OpenCode **y Antigravity**
   se abren en una **terminal del lienzo** (OpenCode usa su CLI v2, `mcp.servers`;
   Antigravity usa su CLI oficial `agy` — misma cuenta y misma config MCP — lanzada con
   `--dangerously-skip-permissions` para que no pida permiso en cada herramienta; quita la
   bandera en `connectors.rs` si prefieres recuperar los avisos; si `agy` no está, se abre
   su app). También puedes abrirlo tú en una terminal — ya está en el equipo:
   verás su actividad en el feed y él verá la tuya vía `team_context` / hooks.

## Orquestar al equipo

1. **Prompt para todos** (barra 📣 arriba del panel Equipo): se publica en el feed y se
   escribe en la terminal de cada agente abierto **con las instrucciones de coordinación**
   (así se conectan al equipo, reparten tareas y se hablan entre sí); a Claude le llega
   además como bloque del hook al terminar su turno. Todos responden y lo ves en Actividad.
2. **Normas + líder** (pestaña Agentes → «Normas del equipo y líder»): el texto se inyecta
   en `team_context`, en las instrucciones del MCP y en cada prompt vía hooks. El líder
   coordina y reparte; elige uno o deja que sea el primero que conecte.
3. **Panel Progreso** (`+ Progreso`): mira el avance de todos sin abrir el panel Equipo.
4. **Tareas**: crea tareas en la pestaña Tareas (o pídeselo a un agente con
   `team_task_create`); los agentes las reclaman (`team_task_claim`) y las cierran
   (`team_task_done`) — el progreso se ve en el panel.

## Si un agente no ve las herramientas del equipo

- **OpenCode**: su servicio de fondo se queda con la conexión MCP muerta si el puente
  muere de golpe (p. ej. reinicio brusco); la sesión se queda sin las `team_*`. Al pulsar
  **Abrir**, lienzo lanza solo `opencode reload` para refrescarla. A mano: ejecuta
  `opencode reload` en la carpeta del proyecto y comprueba con `opencode mcp list`.
- **Puentes y reinicios**: los puentes (`lienzo-mcp.exe`) se re-descubren solos si la app
  reinicia (leen el `hub.json` nuevo); si una sesión quedó rara, ciérrala y **vuelve a
  abrirla** desde el panel Equipo.

## Ejecutar (desarrollo)

```powershell
npm run tauri dev
```

## Compilar release

```powershell
npm run tauri build
```

## Requisitos (ya configurados en este equipo)

- **Rust** con toolchain GNU (`stable-x86_64-pc-windows-gnu`) y **WinLibs GCC** como linker
  → configurado en `~/.cargo/config.toml` (`[target.x86_64-pc-windows-gnu] linker/ar`).
- **WebView2** (incluido en Windows 11).
- Node 24 + npm.

## Roadmap

- **F2 — Daemon de sesiones**: los PTY sobreviven al **cierre total** de la app (proceso separado + IPC). El diseño actual ya separa el gestor PTY para poder extraerlo a un daemon.
- **F3 — Cola de tareas con worktrees**: cada tarea crea un `git worktree` propio, lanza el agente ahí y al terminar revisas el diff y apruebas/rechazas en bloque.
- **F4 — Productividad**: command palette (`Ctrl+K`), notificaciones cuando un agente necesita aprobación, miniaturas reales en LOD, plantillas de layout.
- **F5 — Editor y diffs**: panel de código con CodeMirror 6, visor de diffs, búsqueda con ripgrep.
