# Desarrollar Prometeo con Prometeo

Este repositorio es el código de Prometeo, la app con la que trabaja el equipo. **El Prometeo instalado (`%LOCALAPPDATA%\Prometeo`) es el que os coordina ahora mismo: no se toca.** Lo que cambiéis aquí no le afecta hasta que el usuario lo instale.

## Estructura
- `src-tauri/src/`: Rust. `hub/` (equipo: tareas, buzón, revisiones, conectores), `bin/lienzo-mcp.rs` (el puente MCP y los hooks de los agentes), `pty.rs` (terminales), `updater.rs`.
- `src/`: React. `components/CommandCenter.tsx` (pantalla principal), `components/command/`, `lib/` (lógica pura con pruebas).
- `src-tauri/skills/`: las guías que Prometeo instala a los agentes.
- `scripts/*.test.mjs`: pruebas del frontend.

## Comprobar un cambio
- Rust: `cd src-tauri && cargo test` (y `cargo clippy --all-targets` sin avisos nuevos).
- Frontend: `npx tsc --noEmit -p .` y `npm test`.
- Lógica nueva: con su prueba, como las que hay al lado.

## Probarlo en vivo: Prometeo Dev
- `npm run dev:app` compila la versión de desarrollo (en `src-tauri/target-dev`, varios minutos la primera vez) y la abre. `npm run dev:app -- --no-run` solo compila.
- Prometeo Dev lleva la etiqueta **DEV**, tiene sus datos en `%APPDATA%\lienzo-dev` y su propio hub. No se actualiza ni toca la configuración global de Codex o Antigravity.
- Ábrele **solo carpetas de prueba** (por ejemplo `%USERPROFILE%\Prometeo-pruebas`), nunca un proyecto del Prometeo normal. Si lo intentas, se niega a conectar los agentes.
- Lo que hay que ver con los ojos (pantallas, clics), pídeselo al usuario con `team_ask_user`.

## Lo que pide permiso del usuario (pregunta con `team_ask_user`)
- `npm run release` (crea la versión que se instala con «Actualizar»), `git push` y borrar ramas.
- Cerrar o matar procesos que no sean de `target-dev`. Nunca el `lienzo.exe` o `lienzo-mcp.exe` instalados: son los de vuestro equipo.
- Tocar `%APPDATA%\lienzo`, `%LOCALAPPDATA%\Prometeo` o las configuraciones globales de los agentes (`~/.codex`, `~/.claude`, `~/.gemini`).
- Cualquier cosa que llame en bucle a un modelo de pago.

## Estilo
- Textos de la app, comentarios y mensajes de commit en español, como el código de alrededor.
- Commits pequeños, con lo que cambia y por qué.
- El bloque «Protocolo de equipo (lienzo)» de `CLAUDE.md` y `AGENTS.md` lo escribe Prometeo al conectaros (cambia según la máquina): no lo metas en tus commits.
