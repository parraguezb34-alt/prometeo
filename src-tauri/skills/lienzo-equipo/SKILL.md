---
name: lienzo-equipo
description: Cómo coordinarte con los otros agentes de lienzo (buzón, mensajes, tareas, reservas y entregas). Úsala al empezar a trabajar en equipo, cuando veas 📬 o antes de pedir o entregar trabajo a otro agente.
---

# Trabajo en equipo con lienzo

Trabajas con otros agentes de IA en el mismo proyecto. lienzo os coordina con las herramientas `team_*` (servidor MCP `lienzo-team`). El usuario ve todo lo que publicáis en su chat.

## Al empezar
1. `team_context`: quién está, qué tareas hay, quién lidera y qué archivos están reservados.
2. Si tienes una tarea asignada, reclámala con `team_task_claim`: recibes las entregas de las tareas de las que depende. Léelas antes de tocar nada.
3. Reserva con `team_claim_files` lo que vayas a editar. Si alguien ya lo tiene, mira «Si un archivo está reservado».

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
| Algo que todos deban recordar siempre | `team_memory_propose` (el líder decide; guía: `lienzo-memoria`) |
| Planificar antes de ejecutar (modo plan) | skill `lienzo-plan`; acuerda el plan y pregunta con `team_ask_user` |
| Repartir trabajo | `team_task_create` con `parents` para el orden; a quién: skill `lienzo-reparto` |
| Pactar cómo encajan dos partes | un archivo de contrato: skill `lienzo-contrato` |

### Lo que cuesta cada canal
- `team_message` **despierta** al otro agente: le cuesta un turno entero releer su contexto. Úsalo solo si necesitas que actúe o conteste (guía: `lienzo-consulta`).
- `team_task_comment` **no despierta** a nadie: lo lee quien abra la tarea. Para datos y decisiones de una tarea, casi siempre es mejor.
- `team_update` lo ve el usuario y el feed; nadie tiene que contestar.

### Cuándo no escribir
- Para confirmar que leíste algo, dar las gracias o repetir lo que ya está en una entrega.
- Para contar lo que ya muestra `team_context` (quién está, qué tareas hay, qué está reservado).
- A todo el equipo, si en realidad solo le importa a uno.

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
- **Líder**: parte la misión en tareas pequeñas e independientes, reparte, revisa entregas (skill `lienzo-revision`) y cura la memoria. Programa poco. En modo director, sigue la skill `lienzo-director`.
- **Resto**: ejecuta su parte, avisa pronto si se bloquea y no compite por el mando.

Si recibes encargos en modo director, sigue la skill `lienzo-trabajador`.

## Si un archivo está reservado
- No lo edites ni lo sobrescribas, aunque creas que tu cambio es mejor.
- Escribe a su dueño con `team_message` (`to` = dueño): qué necesitas y para qué. Mientras tanto, sigue con otra parte de tu tarea.
- Si es urgente y no contesta, avisa al líder (`to: "líder"`). No esperes en bucle.

## Si te bloqueas
Escribe al líder (`to: "líder"`) con qué te falta, en una frase, y sigue con otra parte mientras tanto.

## Preguntar al usuario (`team_ask_user`)
Cuando una decisión depende de su gusto o de algo que no sabes (estilo, alcance, tecnología, prioridades), no supongas: pregúntale. Le sale un panel en el chat para elegir.
- Junta las dudas en una sola llamada: hasta 4 preguntas, cada una con 2–4 opciones concretas y distintas. Puede escribir otra respuesta, así que no hace falta la opción «Otra».
- Pon primero la opción que recomiendas y di en su `description` por qué y qué implica.
- `header` corto («Estilo», «Alcance») y `multiSelect: true` si puede elegir varias.
- En modo plan, pregunta antes de proponer el plan. No preguntes lo que puedes averiguar leyendo el proyecto.
- Si no contesta a tiempo, acaba tu turno: la respuesta te llegará escrita en tu terminal.

## Skills
Si al equipo le vendría bien una guía que no tiene (diseño, pruebas, un framework), mira `team_skill_list` y propón una con `team_skill_propose` (nombre de la biblioteca o enlace de GitHub). La instala el usuario.
- Guías: `lienzo-reparto` (a quién darle cada cosa), `lienzo-consulta` (pedir ayuda a un compañero), `lienzo-contrato` (pactar cómo encajan las partes), `lienzo-integracion` (juntar y probar el conjunto), `lienzo-investigar` (buscar con fuentes), `lienzo-ahorro` (gastar menos), `lienzo-relevo` (pasar el testigo), `lienzo-memoria` (qué recordar y cómo proponerlo), `lienzo-plan` (acordar el plan antes de tocar nada), `lienzo-revision`, `lienzo-director`, `lienzo-trabajador` (cumplir encargos), `prometeo-guia` (ayudar al usuario con la app) y `caveman` (respuestas breves).

<!-- lienzo:gestionado — lienzo actualiza este archivo al conectar. Quita esta línea para conservar tus cambios. -->
