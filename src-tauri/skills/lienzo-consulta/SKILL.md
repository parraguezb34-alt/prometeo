---
name: lienzo-consulta
description: Cómo pedir ayuda, un dato o una segunda opinión a otro agente del equipo, y cómo contestar, sin gastar turnos de más. Úsala cuando estés atascado, dudes entre dos caminos, necesites algo que otro sabe o hizo, o cuando te llegue una consulta.
---

# Consultar a un compañero

Cada mensaje despierta al otro agente y le cuesta un turno entero (relee su contexto). Una consulta buena se contesta en una sola respuesta.

## Cuándo consultar
- Llevas **2 intentos** fallidos con lo mismo.
- Vas a tomar una decisión que afecta al trabajo de otro (o que es difícil de deshacer).
- Necesitas algo que otro hizo o sabe: «¿qué devuelve tu función X?», «¿dónde dejaste Y?».
- No consultes lo que puedes averiguar leyendo el proyecto, su entrega (`team_task_list` trae `result`) o la memoria del equipo (`team_memory_list`).
- Lo que solo puede decidir el usuario se le pregunta a él (`team_ask_user`), no a otro agente.

## Cómo preguntar
Un único `team_message` con `to` = el agente (o «líder»):
```
[Consulta] <pregunta cerrada en una línea>
Contexto: <tarea #N, archivo y línea, lo justo>
Ya probé: <qué y qué pasó>
Opciones que veo: A) … B) …  → me inclino por A porque …
Me basta con: <«A o B», un dato, un sí/no>
```
- Pregunta cerrada: que se pueda contestar con una opción, un dato o un sí/no.
- Si es sobre una tarea concreta, mejor `team_task_comment` en esa tarea: queda junto a ella para quien venga después.
- Elige a quién por lo que sabe (ver `lienzo-reparto`): el que hizo esa parte, o el más capaz si es difícil.

## Mientras esperas
- Sigue con otra parte que no dependa de la respuesta; no esperes en bucle.
- Si es bloqueante y no hay nada más, publícalo con `team_update` («bloqueado en #N esperando a X») y acaba tu turno: la respuesta te llegará al buzón (📬).

## Cómo contestar
- Lee con `team_inbox` y contesta con `team_message` (`to` = quien preguntó, `reply_to` = el número del mensaje).
- Responde a lo que pidió («Me basta con…»), en pocas líneas, con la ruta o el dato exacto.
- Si no lo sabes, dilo y, si puedes, di quién lo sabe.
- No contestes agradecimientos ni confirmaciones: cierran la conversación.

## Segunda opinión
Para una decisión importante, pide revisión a un agente **de otro modelo**: ve fallos que tú no ves. Dale el planteamiento y las opciones, no tu conclusión, para que no se contagie.

## Errores típicos
- «¿Me ayudas con esto?» sin contexto: obliga a una ronda más.
- Mandar la misma consulta a todo el equipo: todos gastan un turno.
- Conversar a base de mensajes: si hacen falta más de dos idas y vueltas, decidid un contrato (`lienzo-contrato`) o subidlo al líder.

<!-- lienzo:gestionado — lienzo actualiza este archivo al conectar. Quita esta línea para conservar tus cambios. -->
