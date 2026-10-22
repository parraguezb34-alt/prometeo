---
name: lienzo-plan
description: Flujo del modo plan de lienzo (el usuario aprueba antes de tocar nada). Analizar sin editar, preguntar al usuario, crear las tareas, publicar el plan y esperar aprobación. Úsala cuando un mensaje empiece por «📋 MODO PLAN» o el usuario pida un plan antes de trabajar.
---

# Modo plan

En modo plan el entregable es un plan aprobable, no el trabajo. Hasta que el usuario apruebe, **no edites, no crees archivos y no reserves** (`team_claim_files`).

## 1. Analizar (solo leer)
- `team_context` y `team_feed`: quién está en línea, tareas abiertas, reservas y lo que ya se hizo. No planifiques trabajo repetido.
- Si la petición es «sigue» o similar, el contexto está en el feed: busca tu último plan y las respuestas del usuario antes de nada.
- Lee lo justo del proyecto para saber qué hay que cambiar (busca antes de leer; llamadas independientes en el mismo turno).

## 2. Preguntar (antes de proponer)
Si la petición deja decisiones abiertas, pregunta con un solo `team_ask_user`:
- Hasta 4 preguntas, 2–4 opciones concretas cada una, la recomendada primero y con su porqué en `description`.
- Pregunta lo que cambia el plan: alcance, destino de los archivos, estilo, tecnología, prioridades, qué incluir.
- No preguntes lo que puedes averiguar leyendo el proyecto.
- Si no contesta a tiempo, acaba tu turno: la respuesta te llegará escrita.

**Si tu pregunta se quedó sin respuesta a la vista** (se reinició tu sesión mientras esperabas): la respuesta llega entera, escrita en tu terminal, y también aparece completa en `team_feed` como «💬 Respuestas del usuario…». No vuelvas a preguntar lo mismo.

## 3. Crear las tareas
Con `team_task_create`, una por parte:
- Título accionable («Crear X en ruta», no «X»).
- En `notes`, rutas **absolutas** de lo que se crea o edita y de lo que no se toca, más el criterio de hecho y el comando de comprobación. En modo director, el formato de encargo completo está en la skill `lienzo-director`.
- `parents` para el orden; lo independiente sin padres, para que corra en paralelo. Dos tareas sobre el mismo archivo, nunca en paralelo.
- `level` y `assign` solo a agentes en línea; las difíciles o de diseño, al líder.

## 4. Publicar el plan
Un único `team_update`:
```
📋 Plan (<carpeta base>): <agente> → #N título, #M título · <agente> → … · orden: … · Suposiciones: … Espero tu aprobación.
```
En tu respuesta al usuario: una tabla corta (tarea, agente, dependencia), las suposiciones y la pregunta «¿Apruebas el plan?».

## 5. Esperar
- Las tareas que creas en modo plan quedan en «plan·espera el OK del usuario»: nadie puede reclamarlas ni se despachan. No empieces nada; acaba tu turno, no esperes en bucle.
- El usuario aprueba con el botón «Aprobar y empezar» del chat (te llega «✅ El usuario aprobó el plan…») o por escrito («sí», «dale», «sigue»): en ese caso llama a `team_plan_approve` para soltar las tareas.
- Si pide cambios, ajusta las tareas existentes (`team_task_brief`) en vez de duplicarlas y vuelve a publicar el plan.
- Al aprobarse, lienzo despacha las tareas; las tuyas las reclamas con `team_task_claim`.

## Errores típicos
- Reservar archivos «para ir adelantando»: está prohibido en modo plan.
- Rutas relativas en las tareas: cada CLI tiene su carpeta de trabajo; usa rutas absolutas.
- Un plan de 15 tareas para un cambio de 2 archivos: si es pequeño, una tarea para ti.

<!-- lienzo:gestionado — lienzo actualiza este archivo al conectar. Quita esta línea para conservar tus cambios. -->
