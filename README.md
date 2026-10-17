# lienzo

Canvas infinito + terminales para orquestar agentes de IA.
Recreación **ligera y mejorada** de Deska: Tauri 2 + Rust + React (nada de Electron ni 300 MB de asar).

## Estado actual (F1) ✅

- **Lienzo infinito**: arrastra el fondo para mover, rueda del ratón para zoom al cursor, `Shift+rueda` para desplazarte en horizontal.
- **Terminales reales** (ConPTY vía `portable-pty`) como paneles:
  - Doble clic en el lienzo → nueva terminal.
  - Arrastra el título para mover, esquina inferior derecha para redimensionar.
  - El PTY se redimensiona contigo (el shell recibe `SIGWINCH` / resize real).
- **Sesiones persistentes (borrador)**: el backend Rust mantiene cada PTY vivo y guarda hasta 512 KB de scrollback. Si la interfaz se recarga, los paneles se **re-adjuntan solos** y repintan el historial.
- **Zoom semántico (LOD)**: por debajo del 35% de zoom los paneles se convierten en tarjetas de título (menos trabajo de render, navegación del conjunto).
- **Persistencia del layout**: paneles, posiciones, tamaños y vista se guardan en `localStorage`.

## Arquitectura

| Pieza | Archivo | Qué hace |
| --- | --- | --- |
| Gestor PTY (Rust) | `src-tauri/src/pty.rs` | Spawn de shell, streaming base64 por eventos `pty://data` / `pty://exit`, scrollback ring buffer |
| Registro de comandos | `src-tauri/src/lib.rs` | `term_spawn`, `term_write`, `term_resize`, `term_kill`, `term_list`, `term_scrollback` |
| Estado del lienzo | `src/store.ts` | Paneles + vista con `useSyncExternalStore` y persistencia |
| Lienzo | `src/components/Canvas.tsx` | Paneo, zoom, LOD, barra de herramientas |
| Marco de panel | `src/components/PanelFrame.tsx` | Mover, redimensionar, cerrar, traer al frente |
| Terminal | `src/components/TerminalPanel.tsx` | xterm.js + re-attach a la sesión PTY |

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
