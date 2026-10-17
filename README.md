# lienzo

Canvas infinito + terminales para orquestar agentes de IA.
Recreación **ligera y mejorada** de Deska: Tauri 2 + Rust + React (nada de Electron ni 300 MB de asar).

## Estado actual (F1 + Equipo) ✅

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

## Arquitectura

| Pieza | Archivo | Qué hace |
| --- | --- | --- |
| Gestor PTY (Rust) | `src-tauri/src/pty.rs` | Spawn de shell, streaming base64 por eventos `pty://data` / `pty://exit`, scrollback ring buffer, inyecta env del hub |
| Hub de equipo (Rust) | `src-tauri/src/hub/mod.rs` | Estado compartido: agentes, feed, tareas, reservas; persistencia en `%APPDATA%\lienzo\team-state.json` |
| API HTTP del hub | `src-tauri/src/hub/server.rs` | `127.0.0.1` puerto aleatorio + token: `/join`, `/event`, `/feed`, `/state`, `/task`, `/claim`, `/release` |
| Conectores | `src-tauri/src/hub/connectors.rs` | Detección de agentes y escritura de configs (Claude/Codex/OpenCode/Antigravity) |
| Puente MCP | `src-tauri/src/bin/lienzo-mcp.rs` | Servidor MCP por stdio (`team_*` + recursos `team://`) y modo `hook` para Claude Code / Codex |
| Registro de comandos | `src-tauri/src/lib.rs` | `term_*` + `team_*` (estado, tareas, detectar/conectar agentes) |
| Estado del lienzo | `src/store.ts` | Paneles (terminal/equipo) + vista con `useSyncExternalStore` y persistencia |
| Lienzo | `src/components/Canvas.tsx` | Paneo, zoom, LOD, barra de herramientas |
| Marco de panel | `src/components/PanelFrame.tsx` | Mover, redimensionar, cerrar, traer al frente |
| Terminal | `src/components/TerminalPanel.tsx` | xterm.js + re-attach a la sesión PTY |
| Panel Equipo | `src/components/TeamPanel.tsx` | Actividad, tareas, agentes, proyecto del equipo |

## Conectar un agente (equipo)

1. Abre el panel **Equipo** (`+ Equipo` en la barra) → pestaña **Agentes**.
2. Escribe la carpeta del proyecto y pulsa **Guardar**.
3. Pulsa **Conectar** en el agente que quieras (Claude Code, Codex, OpenCode, Antigravity).
4. Abre el agente (por ejemplo `claude`) en una terminal — ya está en el equipo:
   verás su actividad en el feed y él verá la tuya vía `team_context` / hooks.

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
