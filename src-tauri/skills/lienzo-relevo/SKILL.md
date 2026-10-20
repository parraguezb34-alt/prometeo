---
name: lienzo-relevo
description: Cómo guardar un relevo con memoria (team_handover_save) para compactar el contexto o pasar el testigo sin perder el hilo. Úsala cuando el contexto pase del 70 %, al cambiar de tarea o si el usuario pide un relevo.
---

# Relevo con memoria

El relevo es lo que tu «yo» de después (u otro agente) necesita para seguir sin releer todo. Se guarda pegado a la tarea con `team_handover_save` y lienzo compacta tu contexto después: no hace falta que lo hagas tú.

## Cuándo
- Contexto por encima del 70 %.
- Al terminar una tarea y antes de empezar otra distinta.
- Cuando el usuario o el líder te lo pidan.

## Qué escribir (máximo ~1200 caracteres)
```
Objetivo: <la tarea en una frase>
Hecho: <lo terminado, con rutas>
Decisiones: <qué elegiste y por qué, lo que no se debe deshacer>
Falta: <siguientes pasos concretos, en orden>
Ojo: <trampas, comandos que fallan, supuestos sin comprobar>
```
- Rutas y nombres exactos; nada de pegar código.
- Pon `task_id` si tienes tarea y `files` con lo que tocaste.

### Ejemplo
```
Objetivo: #44 exportar la tabla de pedidos a CSV desde src/components/Pedidos.tsx.
Hecho: botón y función exportCsv() en src/lib/csv.ts; prueba en tests/csv.test.ts (pasa).
Decisiones: separador «;» porque el usuario abre los CSV en Excel en español; no exportar columnas ocultas.
Falta: 1) fechas en formato local, 2) npm test completo, 3) team_task_done con evidencia.
Ojo: Pedidos.tsx también lo tiene reservado opencode (#45): solo toqué el botón.
```

## Al volver de un reinicio
Prometeo, tu sesión o el equipo pueden reiniciarse con trabajo a medias. Antes de seguir:
1. `team_context`: ¿tienes alguna tarea en curso (`claimed`) a tu nombre? ¿Siguen tuyas tus reservas?
2. `team_task_claim` de esa tarea: te devuelve tu último relevo y las entregas de las que depende.
3. `team_inbox`: los mensajes que llegaron mientras no estabas.
4. Si estabas esperando una respuesta del usuario (`team_ask_user`), búscala en `team_feed` como «💬 Respuestas del usuario a tu pregunta qN» o en tu terminal: no la vuelvas a preguntar.
5. Sigue desde «Falta» de tu relevo, no desde el principio.

## Después
- Al retomar tras compactar: lee tu relevo con team_task_claim antes de nada.
- Si lo que decidiste vale para todo el equipo, propónlo también con `team_memory_propose`.
- Libera las reservas que ya no necesites.

<!-- lienzo:gestionado — lienzo actualiza este archivo al conectar. Quita esta línea para conservar tus cambios. -->
