# lienzo

Canvas infinito + terminales para orquestar agentes de IA.
Recreación **ligera y mejorada** de Deska: Tauri 2 + Rust + React (nada de Electron ni 300 MB de asar).

## Estado actual (F1 + Equipo) ✅

- **Centro de Mando (vista principal)**: layout tipo estudio. **Columna izquierda** de control: cabecera `lienzo / rama` (clic para cambiar de proyecto), **Equipo activo** en tarjetas compactas (estado, 👑 líder, selector de **modelo**, alternar **modo**, `▸_` terminal, 🔄 **relevo con memoria** y 🧹 **compactar**, con el **termómetro de contexto real** `36% · 71k` en verde/ámbar/rojo alimentado de verdad por Claude Code (transcript vía hooks), **OpenCode** (`opencode.db`) y **Codex** (rollouts)), pestañas **Tareas** (filtros, bloqueos 🚨 arriba con *Responder*, nº de archivos por tarea, ✅/↺) y **Actividad en vivo** (feed compacto; clic en un agente abre su conversación), y el **compositor de misión** siempre abajo con `📋 Planificar` / `⚡ Directo` y selector de destino `@equipo` / `@lider` / `@agente` (las menciones `@…` al principio del texto también funcionan). **Escenario derecho** con cabecera de tarea (`#2 · título`) y conmutador: `💬 Comando` (chat del equipo en vivo, estilo limpio), `± Cambios` (git status + diff con **revisión por tarea**: diffs filtrados a sus archivos y botones *Aceptar (commit)* / *Revertir* con confirmación; **caja de relevo** 📝; sección **⚠️ Scope Creep** con *↺ Revertir* por archivo y **chips con +N/−M reales por archivo**; `👁 Ver Preview` en `.html`/`.svg`/`.md`), `👁 Preview` (HTML/SVG en iframe, MD/CSV como texto; se recarga solo cuando un agente guarda), `⫻ Split` (diff y preview a la vez), `▸_ Terminal` (terminal grande con selector de sesión y comandos rápidos), `📁 Archivos` (explorador + atajos a Normas y `.agents/skills`) y `📝 Memoria` (los **relevos reales** que guardan los agentes con `team_handover_save` antes de compactar: tarea, autor, cuándo y archivos clicables hacia el preview). En plan la misión va **solo al líder** y nadie edita hasta tu OK (Claude arranca con `--permission-mode plan`, Antigravity con `--mode plan`). Los **bloqueos** (agente esperando permiso o respuesta, vía hook `Notification`) aparecen arriba del equipo. El **lienzo espacial** sigue disponible como vista secundaria (`⬚ Lienzo` / `← Comando`); las terminales ocultas siguen vivas (PTY + scrollback) y se re-adjuntan al abrirlas.
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
  - **`lienzo-mcp.exe`**: puente MCP universal. Da a cualquier agente las herramientas `team_context`, `team_update`, `team_feed`, `team_message`, `team_task_*`, `team_claim_files` / `team_release_files` y **`team_handover_save`** (memoria de relevo pegada a la tarea). Para OpenCode y Codex, además, un **muestreador** lee su almacén local cada 12 s y reporta su contexto real al hub (sin ruido en el feed).
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
| API HTTP del hub | `src-tauri/src/hub/server.rs` | `127.0.0.1` puerto aleatorio + token: `/join`, `/event`, `/feed`, `/state`, `/task`, `/claim`, `/release`, `/broadcast`, `/pending`, `/charter`, `/handover` (relevo con memoria), `/ctx` (telemetría del muestreador) |
| Conectores | `src-tauri/src/hub/connectors.rs` | Detección de agentes, escritura de configs (Claude/Codex/OpenCode/Antigravity), lanzamiento (`team_open`, flag de modo plan) y **compactación de OpenCode** vía la API de su servidor local (`opencode_compact`) |
| Proyecto (Rust) | `src-tauri/src/project.rs` | Ventana a la carpeta: git status/diff, revisión por tarea (commit o revert de sus rutas), listados y lecturas con tope de tamaño (nunca sale de la raíz) |
| Puente MCP | `src-tauri/src/bin/lienzo-mcp.rs` | Servidor MCP por stdio (`team_*` + recursos `team://`), modo `hook` para Claude Code / Codex (contexto de equipo, avisos de bloqueo y telemetría de contexto desde el transcript) y muestreador de telemetría local para OpenCode (`opencode.db`) y Codex (rollouts) |
| Registro de comandos | `src-tauri/src/lib.rs` | `term_*` + `team_*` (estado, tareas, líder, detectar/conectar/lanzar agentes) + `project_*` |
| Estado del lienzo | `src/store.ts` | Paneles (terminal/equipo/progreso) + vista con `useSyncExternalStore` y persistencia |
| Lienzo | `src/components/Canvas.tsx` | Paneo, zoom, LOD, barra de herramientas |
| Marco de panel | `src/components/PanelFrame.tsx` | Mover, redimensionar, cerrar, traer al frente |
| Terminal | `src/components/TerminalPanel.tsx` | xterm.js + re-attach a la sesión PTY |
| Panel Equipo | `src/components/TeamPanel.tsx` | Actividad, tareas, agentes, prompt para todos (📣), normas y líder (también en el cajón del Centro de Mando) |
| Panel Progreso | `src/components/TasksPanel.tsx` | Barra de avance, agentes en línea y tablero compacto |
| Centro de Mando | `src/components/CommandCenter.tsx` | Vista principal tipo estudio: columna de control (equipo, tareas/actividad en vivo, compositor con destino) + escenario con pestañas (comando, cambios, preview, split, terminal, archivos, memoria) |
| Tarjeta de agente | `src/components/AgentCard.tsx` | Estado, líder, terminal y comandos rápidos por CLI (modelo, modo, relevo, compactar) |
| Pestañas de artefactos | `src/components/DiffTab.tsx`, `PreviewTab.tsx`, `FilesTab.tsx` | Cambios (git diff + revisión por tarea, +N/−M reales por archivo), preview con recarga automática y explorador del proyecto |
| Memoria (relevos) | `src/components/MemoryTab.tsx` | Los relevos reales que guardan los agentes (team_handover_save) pegados a su tarea, con archivos clicables hacia el preview |
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

## Relevo con memoria (compactar sin amnesia)

Cuando la barra de contexto de un agente se acerque al límite (o cuando quieras
traspasar su trabajo), pulsa el 🔄 que está **junto a la barra de contexto** (o el 🔄
de sus comandos rápidos):

1. El agente guarda su relevo con `team_handover_save`: qué hizo, decisiones tomadas,
   qué falta y qué archivos tocó. Queda **pegado a su tarea** (se ve en `± Cambios`
   junto a su diff) y anunciado en el feed.
2. En cuanto lo guarda, lienzo **compacta su contexto solo**: Claude recibe
   `/compact` con el foco de la tarea («Mantén el contexto de la tarea #X y los
   archivos Y»), Codex su `/compact`, y OpenCode se compacta vía la API de su
   servidor local (`POST /api/session/:id/compact`; la petición es duradera y se
   aplica en su siguiente límite de paso). Antigravity aún no expone compactado:
   su relevo queda igualmente guardado en la tarea.
3. La barra de contexto baja en vivo y el agente sigue con la memoria a mano, sin
   releer todo el historial.

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

**Binarios bloqueados:** si un build falla con «Acceso denegado (os error 5/32)»
porque un `.exe` está en uso (puentes MCP vivos, webviews zombie), ya no hay que
hacer nada a mano: `src-tauri/build.rs` corre antes de cada enlace y el script
`pretauri` (`scripts/unblock-bins.mjs`) al arrancar `npm run tauri …`; los binarios
bloqueados se apartan como `.locked-<ts>` y los procesos vivos siguen con su copia.

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
- **Antigravity**: su telemetría de contexto queda pendiente (almacén en protobuf sin login activo); el resto del equipo ya tiene termómetro real.
