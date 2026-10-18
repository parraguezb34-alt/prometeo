# lienzo

Centro de mando con chats y terminales para orquestar agentes de IA.
Recreación **ligera y mejorada** de Deska: Tauri 2 + Rust + React (nada de Electron ni 300 MB de asar).

## ¿De qué trata?

lienzo es un **centro de mando conversacional para dirigir un equipo de agentes de IA que ya viven en tu máquina** — Claude Code, OpenCode, Codex y Antigravity — sin saltar entre cuatro terminales y cuatro contextos distintos:

- **Les hablas como a un equipo**: un chat único para pedir una misión al grupo (en modo plan o directo) o un mensaje privado a un agente concreto (`@claude`, `@opencode`…). Lo que escribes llega de verdad a su terminal.
- **Trabajan sin pisarse**: cada tarea tiene dueño y cada agente reclama los archivos que va a tocar. lienzo te enseña quién hace qué, marca los bloqueos cuando un agente espera tu respuesta y detecta *scope creep* (archivos tocados fuera de lo reclamado).
- **Las sesiones largas no se pudren**: cuando un agente va a quedarse sin contexto, guarda un **relevo con memoria** pegado a su tarea y lienzo compacta por él; quien retome el trabajo continúa con ese resumen, sin amnesia.
- **Tú mandas sobre lo que cambia**: diffs filtrados por tarea, aceptar o revertir por archivos/con bloques, commit solo bajo tu OK, y preview en vivo de los HTML/SVG/MD que producen.
- **Datos reales, nada fingido**: el termómetro de contexto (% y tokens), el feed, las tareas y los diffs salen de las fuentes locales de cada CLI (transcripts, `opencode.db`, rollouts de Codex) y de git. Si algo no se puede medir, no se inventa.

## ¿Qué se quiere lograr con la aplicación?

1. **Dirigir, no teclear**: que coordinar 2–6 agentes se sienta como hablar con un equipo — pedir un plan, repartir trabajo, desbloquear — y no como copiar y pegar entre terminales.
2. **Que los agentes no se pisen ni dupliquen trabajo**: tareas con dueño, archivos reclamados y un estado del progreso visible de un vistazo.
3. **Que las sesiones largas sobrevivan**: relevo + compactación automática para seguir trabajando más allá del límite de contexto sin empezar de cero.
4. **Que ninguna línea se te cuele**: toda edición pasa por tu revisión, por tarea, con aceptar/revertir y commit explícito.
5. **Ligera, local y tuya**: una alternativa honesta y liviana a Deska — sin Electron, sin cuentas en la nube y con tus CLIs y tus datos en tu propia máquina.

## Estado actual (F1 + Equipo) ✅

- **Centro de Mando (vista principal)** — diseño "Mesa de equipo" (paleta en tokens CSS, fuentes Manrope y JetBrains Mono incluidas en la app, iconos SVG de línea):
  - **Barra superior**: proyecto y rama, el **equipo como anillos** (cada anillo es el termómetro de contexto real del agente y un punto marca si trabaja, está libre o espera tu respuesta), aviso «N espera tu respuesta» y estado del hub. Pulsar el equipo abre un **modal** con modelo, modo, contexto exacto (`71k de 200k · 36%`), 👑 líder, Terminal, Hablar, 🔄 **relevo con memoria** y compactar de cada agente, más *Añadir agente* y *Normas del equipo*.
  - **Chats** (barra izquierda **plegable**): historial agrupado por día con búsqueda, quién participó y si es del equipo o privado. «Nuevo chat» ofrece equipo, líder, un agente en privado o retomar desde un relevo. Un chat es una ventana de tiempo sobre el feed real del hub (se guarda en `localStorage` por proyecto), así no se duplica ni se inventa nada; el primer mensaje le pone título.
  - **Escenario**: cabecera con el título del chat y el **progreso de tareas (`1/4`) siempre visible** (con aviso si algo te bloquea); cinco pestañas: `Comando` (chat con burbujas por agente; la actividad de bajo nivel se oculta con «Mostrar actividad»), `Cambios` (git status + diff con **revisión por tarea**: *Aceptar (commit)* / *Revertir*, **caja de relevo**, **Scope Creep** con *Revertir* por archivo y **+N/−M reales**, `Ver Preview` en `.html`/`.svg`/`.md`), `Preview` (se recarga sola), `Terminal` (la terminal de cada agente, con selector) y `Archivos`.
  - **Tareas, actividad y relevos** en un **panel lateral** bajo demanda: avance del equipo, filtros, bloqueos 🚨 con *Responder*, nº de archivos por tarea y ✓/↺; pestaña Actividad con el feed en vivo y pestaña Relevos con lo que los agentes guardaron con `team_handover_save` antes de compactar.
  - **Compositor flotante** con `Planificar` / `Directo` y destino `@equipo` / agentes (también valen las menciones `@…` al principio del texto). En plan la misión va **solo al líder** y nadie edita hasta tu OK (Claude arranca con `--permission-mode plan`, Antigravity con `--mode plan`). Las terminales ocultas siguen vivas (PTY + scrollback) y se re-adjuntan al abrirlas.
- **Terminales reales** (ConPTY vía `portable-pty`): cada agente corre en su terminal, que se ve en la pestaña `Terminal` y se redimensiona contigo (el shell recibe el resize real).
- **Sesiones persistentes (borrador)**: el backend Rust mantiene cada PTY vivo y guarda hasta 512 KB de scrollback. Si la interfaz se recarga, las terminales se **re-adjuntan solas** y repintan el historial.
- **Capó de equipo (agentes trabajando juntos)**:
  - **Equipo** (modal desde la barra superior) y **Ajustes del equipo** (⚙): actividad en vivo, tareas compartidas, conexión de agentes, normas y proyecto.
  - **`lienzo-mcp.exe`**: puente MCP universal. Da a cualquier agente las herramientas `team_context`, `team_update`, `team_feed`, `team_message`, `team_task_*`, `team_claim_files` / `team_release_files` y **`team_handover_save`** (memoria de relevo pegada a la tarea). Para OpenCode y Codex, además, un **muestreador** lee su almacén local cada 12 s y reporta su contexto real al hub (sin ruido en el feed).
  - **Conexión con 1 clic**: detecta Claude Code, Codex, OpenCode y Antigravity y escribe su configuración (`.mcp.json`, `~/.codex/config.toml`, `opencode.json`, `.agents/mcp_config.json`) + bloque de protocolo en `AGENTS.md`/`CLAUDE.md`.
  - **Reporte automático**: los hooks de Claude Code (y Codex) publican cada edición/comando en el feed y **inyectan el contexto del equipo en cada prompt** — Claude ve lo que hizo otro agente antes de responder.
  - **Sin pisarse archivos**: `team_claim_files` reserva archivos y devuelve conflictos si otro agente ya los tiene.
  - **Hub local** (Rust, `127.0.0.1` + token): descubrimiento en `%APPDATA%\lienzo\hub.json`; las terminales que abre lienzo heredan `LIENZO_HUB` / `LIENZO_TOKEN`.
- **Orquestador del equipo** 🎛️:
  - **Prompt para todos** (📣 en Ajustes del equipo): publica el mensaje en el feed y lo **escribe en la terminal de cada agente abierto** (OpenCode/Antigravity/Claude la reciben al instante), y a Claude en cualquier ventana le llega como bloque del **hook Stop** cuando termina su turno. El texto viaja **envuelto con el protocolo de equipo** (llama a `team_context`, reparte/reclama tareas, publica avances con `team_update`, reserva archivos) para que los agentes coordinen de verdad en vez de trabajar cada uno por su cuenta.
  - **Normas del equipo (system prompt global)**: texto editable en la pestaña Agentes que se inyecta a los agentes en `team_context`, en las instrucciones del MCP y en cada prompt vía hooks — saben que trabajan juntos y cómo coordinarse.
  - **Jerarquía sin peleas**: un **líder** (el primero que conecta, o el que elijas) coordina y reparte; los demás proponen y ejecutan su parte.
  - **Tareas huérfanas**: si el agente que reclamó una tarea deja de latir (su puente murió), el hub la **libera solo** — vuelve a *abierta* con un aviso `↺` en el feed. No hay tareas colgadas para siempre.

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
| Terminales vivas | `src/store.ts` | Registro de terminales de agentes (id de sesión PTY) con `useSyncExternalStore` y persistencia |
| Terminal | `src/components/TerminalPanel.tsx` | xterm.js + re-attach a la sesión PTY |
| Ajustes del equipo | `src/components/TeamPanel.tsx` | Actividad, tareas, agentes, prompt para todos (📣), normas y líder (cajón del Centro de Mando) |
| Centro de Mando | `src/components/CommandCenter.tsx` | Vista principal: barra superior con el equipo, chats a la izquierda y escenario con pestañas (comando, cambios, preview, split, terminal, archivos, memoria) más compositor |
| Equipo (modal y anillos) | `src/components/TeamModal.tsx`, `AgentCard.tsx` | Anillos de contexto en la barra superior y modal con los controles de cada agente (modelo, modo, relevo, compactar, líder) |
| Chats | `src/components/ChatsSidebar.tsx`, `NewChatMenu.tsx`, `src/lib/chats.ts` | Barra plegable con historial por día, menú de nuevo chat y ventanas de tiempo sobre el feed del hub |
| Tareas, actividad y relevos | `src/components/TasksDrawer.tsx` | Panel lateral con progreso, bloqueos, tareas, feed y relevos |
| Sistema de diseño | `src/App.css` (tokens `:root`), `src/cc2.css`, `src/components/Icon.tsx` | Paleta y tipografía en variables; estilos del Centro de Mando; iconos SVG |
| Pestañas de artefactos | `src/components/DiffTab.tsx`, `PreviewTab.tsx`, `FilesTab.tsx` | Cambios (git diff + revisión por tarea, +N/−M reales por archivo), preview con recarga automática y explorador del proyecto |
| Relevos | `src/components/MemoryTab.tsx` | Los relevos reales que guardan los agentes (team_handover_save) pegados a su tarea, con archivos clicables hacia el preview (se muestra en el panel de Tareas) |
| Feed compartido | `src/components/FeedList.tsx` | Lista de actividad reutilizada por los ajustes del equipo |

## Conectar un agente (equipo)

1. Abre los **Ajustes del equipo** (⚙ arriba a la derecha, o *Añadir agente* en el modal de Equipo) → pestaña **Agentes**.
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

1. **Prompt para todos** (barra 📣 en los Ajustes del equipo): se publica en el feed y se
   escribe en la terminal de cada agente abierto **con las instrucciones de coordinación**
   (así se conectan al equipo, reparten tareas y se hablan entre sí); a Claude le llega
   además como bloque del hook al terminar su turno. Todos responden y lo ves en Actividad.
2. **Normas + líder** (pestaña Agentes → «Normas del equipo y líder»): el texto se inyecta
   en `team_context`, en las instrucciones del MCP y en cada prompt vía hooks. El líder
   coordina y reparte; elige uno o deja que sea el primero que conecte.
3. **Progreso**: el avance (`1/4`) y los bloqueos están siempre en la cabecera; el panel de Tareas lo detalla.
4. **Tareas con dependencias y entrega**: crea tareas en el panel de Tareas (con el candado eliges de cuáles depende) o pídeselo a un agente con
   `team_task_create` y `parents`. Una tarea con padres queda **bloqueada** hasta que todos estén hechos, así lo independiente
   corre en paralelo y lo demás espera su turno. Los agentes reclaman (`team_task_claim`) y cierran (`team_task_done`);
   - **Un solo ganador**: reclamar falla si la tarea ya es de otro agente, si está hecha o si espera a sus padres.
   - **Entrega estructurada**: cerrar exige `summary` (qué hizo y decidió) y admite `files` y `evidence` (cómo lo comprobó). Se guarda en la tarea y se ve en el panel.
   - **Los dependientes la reciben**: al reclamar una tarea, el agente recibe las entregas de sus padres; `team_context` también las resume.

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
  abrirla** desde los Ajustes del equipo.

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
- **F4 — Productividad**: command palette (`Ctrl+K`), notificaciones cuando un agente necesita aprobación.
- **F5 — Editor y diffs**: panel de código con CodeMirror 6, visor de diffs, búsqueda con ripgrep.
- **Antigravity**: su telemetría de contexto queda pendiente (almacén en protobuf sin login activo); el resto del equipo ya tiene termómetro real.
