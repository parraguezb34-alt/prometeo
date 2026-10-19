---
name: lienzo-revision
description: Cómo revisar la entrega de otro agente del equipo y devolver comentarios útiles. Úsala si eres el líder y se cierra una tarea, o cuando te pidan revisar el trabajo de otro.
---

# Revisar el trabajo de otro agente

## Pasos
1. Lee la entrega de la tarea (`team_task_list` muestra el resumen; `team_task_claim` de una tarea hija trae la entrega completa).
2. Mira solo los archivos de `files`: `git diff -- <ruta>` o léelos por tramos. No releas el proyecto entero.
3. Comprueba la `evidence`: si dice que pasan las pruebas, ejecuta esas mismas (acotando la salida).
4. Contrasta con lo que pedía la tarea (título y notas) y con la memoria del proyecto.

## Devolver
- Todo bien: una línea en `team_task_comment` («Revisado: ok») y, si es útil, propón la decisión a la memoria.
- Hay que cambiar algo: `team_task_comment` en la tarea con una lista corta, cada punto con ruta:línea y qué esperas. Avisa al autor con `team_message` (`to` = autor) en una frase.
- Si el arreglo es grande, crea una tarea nueva con `parents` en la original, en vez de reabrirla.

## Criterios
- ¿Hace lo que pedía la tarea, ni más ni menos?
- ¿Rompe algo de otros archivos reservados o tareas en curso?
- ¿La evidencia es real y repetible?
- ¿Queda algo a medias que nadie lleva? Créalo como tarea.

<!-- lienzo:gestionado — lienzo actualiza este archivo al conectar. Quita esta línea para conservar tus cambios. -->
