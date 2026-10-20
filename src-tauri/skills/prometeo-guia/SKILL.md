---
name: prometeo-guia
description: Cómo explicar Prometeo al usuario y ayudarle a pedir trabajo con claridad. Úsala cuando pregunte cómo usar la app, dónde está algo, qué son el modo plan o el modo director, o cuando su petición sea vaga y haya que convertirla en preguntas concretas.
---

# Guía de Prometeo para el usuario

Prometeo es la app donde el usuario dirige al equipo; lienzo es su sistema de coordinación. Varios CLIs (Claude Code, OpenCode, Antigravity) trabajan en la misma carpeta y se coordinan con las herramientas `team_*`. Lo que publicáis le aparece en su chat.

## Qué ve el usuario
**Arriba:** el proyecto, **Equipo** (una tarjeta por agente con dos barras: contexto y uso; ahí se abren, cambian de modelo y se elige líder), el aviso «N esperan tu respuesta», **Hub conectado**, el chip de **límites de uso** (sesión de 5 h y semana de cada agente), la campana de avisos y **Ajustes** (Ctrl+,). La barra hace de barra de ventana: minimizar, maximizar y cerrar.

**Izquierda:** el proyecto (cambiar de carpeta, abrir otra, crear uno nuevo o **Renombrar carpeta…**), **Nuevo chat** (con todo el equipo o privado con un agente), el buscador y la lista de chats (se renombran con el lápiz, doble clic o F2). Debajo, «Otros proyectos».

**Pestañas del centro:**
| Pestaña | Para qué |
|---|---|
| Comando | El chat con el equipo. Abajo: «Para» (todo el equipo o un agente), **Planificar / Directo** y adjuntar archivos. |
| Investigar | Búsqueda en la web con fuentes: **Rápida** (un agente por rondas) o **Profunda** (plan → partes en paralelo → verificación → informe). Queda en `.lienzo/investigaciones/`. |
| Historial | Qué cambió cada tarea, con su diff, y deshacer o rehacer por tarea. |
| App | El proyecto arrancado en vivo (o un archivo) para verlo. |
| Terminal | La terminal de cada agente a pantalla completa (Esc, cambiar modelo, relevo). |

**Tareas** (botón arriba a la derecha) abre el cajón con **Tareas**, **Actividad**, **Relevos** y **Memoria**.

**Ajustes:** General, Agentes, Equipo, Skills, Consumo, Despacho, Avisos, Conexión y Errores.

**Segundo plano:** cerrar la ventana no sale de Prometeo; sigue en la bandeja, junto al reloj, y los agentes siguen trabajando. Para salir: clic derecho en el icono → Salir.

## Modos
- **Planificar:** nadie edita hasta que el usuario aprueba; el equipo analiza, pregunta y propone tareas (ver `lienzo-plan`).
- **Directo:** el equipo se pone a trabajar ya.
- **Modo director:** el líder reparte encargos cerrados y revisa cada entrega antes de cerrarla; los demás ejecutan (ver `lienzo-director` y `lienzo-trabajador`).
- **Preguntas:** `team_ask_user` abre en el chat una tarjeta con hasta 4 preguntas de 2–4 opciones; el usuario elige o escribe otra respuesta.
- Un chat cerrado se puede **retomar con su memoria**: cada agente vuelve a la conversación que tenía en él.

## Cómo pedir bien
Una petición útil dice **qué** (objetivo), **dónde** (carpeta o archivos) y **cómo sabremos que está** (criterio de hecho). Ejemplos:
- «Añade un botón de exportar a CSV en `src/components/Tabla.tsx`; debe descargar las filas visibles y `npm test` debe pasar.»
- «Revisa `docs/guia.md` y corrige solo las faltas; no cambies el formato.»

Si la petición es vaga («mejora esto», «hazlo bonito»), no adivines: tradúcela a preguntas con `team_ask_user`.
- Hasta 4 preguntas, cada una con 2–4 opciones concretas; la recomendada primero, con su `description`.
- No preguntes lo que puedes averiguar leyendo el proyecto.

## Skills
- Prometeo las copia al conectar en `.claude/skills/` y `.agents/skills/`, y las enciende o apaga desde **Ajustes → Skills**.
- Las suyas llevan al final la marca de archivo gestionado y se actualizan solas; si el usuario la quita, ese archivo ya no se toca.
- Para proponer una guía nueva usa `team_skill_propose` (`reason` y `source`): el usuario decide; tú no instalas nada.

## Quiero… → pídelo así
| Quiero… | Pídelo así |
|---|---|
| Que varios agentes trabajen a la vez | «Divide esto en tareas independientes, asígnalas y revisa las entregas.» |
| Que no toquen código hasta aprobar | Modo **Planificar**, o «primero muéstrame el plan». |
| Investigar algo con fuentes | Pestaña **Investigar** (Profunda si es amplio). |
| Ver qué cambió y deshacerlo | Pestaña **Historial**. |
| Saber cuánto le queda a cada agente | Chip de límites arriba, o **Equipo**. |
| Que otro agente lo revise | «Que revise esta entrega contra el encargo y me diga qué falla.» |

## Reglas
- Habla en el idioma del usuario y sin jerga innecesaria.
- Distingue lo comprobado de lo supuesto.
- Si no sabes una función de la app, dilo y ofrece comprobarla; no la inventes.

<!-- lienzo:gestionado — lienzo actualiza este archivo al conectar. Quita esta línea para conservar tus cambios. -->
