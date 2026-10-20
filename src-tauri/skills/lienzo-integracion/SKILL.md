---
name: lienzo-integracion
description: Juntar y comprobar el trabajo de varios agentes cuando terminan sus partes en paralelo, antes de dar la misión por cerrada. Úsala si eres quien integra (normalmente el líder o la última tarea del plan), o al planificar una misión con partes paralelas.
---

# Integrar el trabajo del equipo

Cada agente comprueba su parte; nadie comprueba el conjunto. Integrar es ese último paso: todo junto, compilado y probado como lo usará el usuario.

## Al planificar
- Si hay partes en paralelo, añade una tarea final «Integrar y comprobar X» con `parents` = todas las partes. Va al líder o a quien conozca el conjunto.
- Escribe en sus `notes` el comando de comprobación completo (build, tests, arrancar la app) y qué hay que ver funcionando.

## Al integrar
1. `team_task_list`: lee la entrega de cada parte (`summary`, `files`, `evidence`). Si alguna no trae evidencia real, pídela antes de seguir.
2. Revisa las fronteras: lo que una parte produce y otra consume (si hubo contrato, compáralo con lo hecho; ver `lienzo-contrato`).
3. Ejecuta el comando de comprobación **completo** desde la raíz del proyecto, no solo los tests de una parte.
4. Prueba el recorrido que hará el usuario (arranca la app, abre la pantalla, usa el comando).

## Si algo falla
- Localiza de qué parte viene antes de tocar nada.
- Si el arreglo es pequeño y está en la frontera, hazlo tú, reservando los archivos (`team_claim_files`), y anótalo en la tarea afectada (`team_task_comment`).
- Si es de una parte, devuélvela a su agente con un encargo cerrado: qué falla, cómo reproducirlo y qué se espera (en modo director, `team_task_review` con `verdict: "fix"`).
- No tapes un fallo para cerrar: «funciona salvo X» es una entrega válida; «funciona» sin probar, no.

## Al cerrar
Entrega la tarea de integración (`team_task_done`) con:
- `summary`: qué quedó funcionando de punta a punta.
- `evidence`: el comando que corriste y su resultado (o lo que viste en la app).
- Lo que quedó pendiente o con riesgo, para que el usuario decida.

Si descubriste algo que el equipo debe recordar («los tests de X solo pasan con Y»), propónlo con `team_memory_propose`.

<!-- lienzo:gestionado — lienzo actualiza este archivo al conectar. Quita esta línea para conservar tus cambios. -->
