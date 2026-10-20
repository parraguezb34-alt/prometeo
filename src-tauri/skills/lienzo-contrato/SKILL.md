---
name: lienzo-contrato
description: Acordar por escrito cómo encajan las partes que hacen agentes distintos (API y pantalla, módulo y quien lo usa, script y sus datos) antes de que cada uno trabaje por su lado. Úsala al repartir o recibir una tarea que conecta con la de otro agente, o al cambiar algo que otro ya usa.
---

# Contratos entre agentes

El fallo más caro de un equipo: cada uno termina su parte y al juntarlas no encajan (un campo con otro nombre, una ruta distinta, un formato que nadie pactó). Un contrato es un archivo corto que fija **la frontera** entre dos partes antes de empezar.

## Cuándo hace falta
- Dos tareas en paralelo que se tocan: una produce algo que la otra consume (endpoint ↔ pantalla, función ↔ quien la llama, archivo de datos ↔ quien lo lee).
- Vas a cambiar una interfaz que otro agente ya usa.
- No hace falta si una sola tarea hace las dos partes, o si la frontera ya existe en el código y nadie la cambia.

## 1. Escribirlo (quien planifica, o el primero que llega)
Un archivo en el proyecto, junto al código que define, p. ej. `docs/contratos/<tema>.md` o el propio archivo de tipos (`types.ts`, `schema.py`). Contiene solo la frontera:
- Qué se intercambia: nombres, tipos y ejemplos reales (un JSON de muestra vale más que una descripción).
- Errores y casos raros: qué pasa si falta un dato, si viene vacío, si falla.
- Quién produce y quién consume (agentes y tareas).
- Lo que **no** cubre (para que nadie lo dé por pactado).

Resérvalo con `team_claim_files` mientras lo escribes y libéralo al acabar.

## 2. Enlazarlo
- En cada tarea afectada, una nota con `team_task_comment`: «Contrato: `<ruta absoluta>`. Respétalo; si necesitas cambiarlo, avisa antes.»
- Si las tareas aún no existen, la ruta va en sus `notes` al crearlas (`team_task_create`), y la tarea del contrato como padre (`parents`) de las dos partes.

## 3. Trabajar contra el contrato
- Implementa exactamente lo pactado; no «mejores» la frontera por tu cuenta.
- Si el otro lado aún no está, usa el ejemplo del contrato como dato de prueba.
- En la entrega (`team_task_done`), di en `evidence` cómo comprobaste que cumples el contrato.

## 4. Cambiarlo
1. Reserva el archivo y propón el cambio a quien consume, con `team_message` (`to` = el otro agente): qué cambia, por qué y desde qué tarea.
2. Espera su visto bueno (o el del líder) antes de tocar código que dependa del cambio.
3. Actualiza el archivo, anota el cambio en las tareas afectadas con `team_task_comment` y libera la reserva.

Si el cambio es una decisión que debe durar, propónla a la memoria del equipo (`team_memory_propose`, `kind: "convencion"`).

## Errores típicos
- Pactar de palabra en un mensaje: se pierde. El contrato es un archivo.
- Un contrato de 200 líneas: si no cabe en una pantalla, estás diseñando, no pactando.
- Cambiar el contrato y avisar después: el otro ya trabajó contra la versión vieja.

<!-- lienzo:gestionado — lienzo actualiza este archivo al conectar. Quita esta línea para conservar tus cambios. -->
