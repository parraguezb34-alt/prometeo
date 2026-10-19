---
name: lienzo-equipo
description: Cómo coordinarte con los otros agentes de lienzo (buzón, mensajes, tareas, reservas y entregas). Úsala al empezar a trabajar en equipo, cuando veas 📬 o antes de pedir o entregar trabajo a otro agente.
---

# Trabajo en equipo con lienzo

Trabajas con otros agentes de IA en el mismo proyecto. lienzo os coordina con las herramientas `team_*` (servidor MCP `lienzo-team`). El usuario ve todo lo que publicáis en su chat.

## Al empezar
1. `team_context`: quién está, qué tareas hay, quién lidera y qué archivos están reservados.
2. Si tienes una tarea asignada, reclámala con `team_task_claim`: recibes las entregas de las tareas de las que depende. Léelas antes de tocar nada.
3. Reserva con `team_claim_files` lo que vayas a editar. Si alguien ya lo tiene, no lo edites: escríbele.

## Buzón (📬)
- Los mensajes que te mandan otros agentes van a tu buzón. Cuando una herramienta te diga «📬 tienes N mensajes», léelos con `team_inbox`.
- Contesta con `team_message` (campo `to` = quien te escribió) y pon `reply_to` con el número del mensaje: así queda hilado y tu buzón se marca como leído.
- `to: "líder"` llega al líder actual, sea quien sea.
- No contestes agradecimientos ni confirmaciones vacías («ok», «gracias»): gastan tokens de los dos. Contesta solo si aportas algo o te preguntan.

## Qué canal usar
| Para… | Usa |
|---|---|
| Avisar de un avance (1 línea) | `team_update` |
| Preguntar o pedir algo a un agente | `team_message` con `to` |
| Datos o decisiones sobre una tarea concreta | `team_task_comment` (queda en su tablón para quien la lleve) |
| Algo que todos deban recordar siempre | `team_memory_propose` (el líder decide) |
| Repartir trabajo | `team_task_create` con `parents` para el orden |

## Pedir trabajo a otro
- Crea la tarea con un título accionable y, en `notes`, el criterio de terminado y las rutas exactas.
- Usa `parents` cuando dependa de otra: espera sola y quien la tome recibe la entrega previa.
- No pegues archivos ni logs en los mensajes: da la ruta y la línea.

## Entregar
Cierra con `team_task_done`:
- `summary`: qué hiciste y qué decidiste, en 2–4 frases.
- `files`: rutas tocadas.
- `evidence`: cómo lo comprobaste (comando y resultado).
Después libera tus reservas con `team_release_files`.

## Roles
- **Líder**: parte la misión en tareas pequeñas e independientes, reparte, revisa entregas (skill `lienzo-revision`) y cura la memoria. Programa poco.
- **Resto**: ejecuta su parte, avisa pronto si se bloquea y no compite por el mando.

## Si te bloqueas
Escribe al líder (`to: "líder"`) con qué te falta, en una frase, y sigue con otra parte mientras tanto.

<!-- lienzo:gestionado — lienzo actualiza este archivo al conectar. Quita esta línea para conservar tus cambios. -->
