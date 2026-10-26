---
name: lienzo-revision
description: Cómo revisar la entrega de otro agente del equipo y devolver comentarios útiles. Úsala si eres el líder y se cierra una tarea, o cuando te pidan revisar el trabajo de otro.
---

# Revisar el trabajo de otro agente

## Quién revisa
- Mejor un agente **de otro modelo** que el autor: un modelo distinto ve los fallos que el autor no ve (el mismo modelo tiende a dar por bueno su propio razonamiento).
- Si el revisor natural (el líder) va con el uso `⛔ casi agotado` en `team_context`, revisa solo lo crítico y delega el resto de la revisión (ver `lienzo-reparto`).
- Revisa sin leer antes el razonamiento del autor: primero la tarea y el resultado; después, su resumen.

## Pasos
1. Lee la entrega de la tarea (`team_task_list` muestra el resumen; `team_task_claim` de una tarea hija trae la entrega completa).
2. Mira solo los archivos de `files`: `git diff -- <ruta>` o léelos por tramos. En proyectos sin git no hay `git diff`: abre cada archivo de `files` por tramos (búsquedas con `grep` y lecturas acotadas) y compáralo con lo que pedía la tarea. No releas el proyecto entero.
3. Comprueba la `evidence`: si dice que pasan las pruebas, ejecuta esas mismas (acotando la salida).
4. Contrasta con lo que pedía la tarea (título y notas) y con la memoria del proyecto.

## Devolver
En modo director, decide con `team_task_review` siguiendo la skill `lienzo-director`. Si eres el **primer revisor** (te lo dice el aviso 🔎): `ok` si cumple el «Hecho cuando» del encargo, `fix` con órdenes concretas si falla algo, y `lider` si dudas, si toca algo delicado (seguridad, datos, borrados) o si tras las rondas sigue mal. No apruebes lo que no hayas comprobado con el «Comprueba con». Fuera de ese modo:
- Todo bien: una línea en `team_task_comment` («Revisado: ok») y, si es útil, propón la decisión a la memoria.
- Hay que cambiar algo: `team_task_comment` en la tarea con una lista corta, cada punto con ruta:línea y qué esperas. Avisa al autor con `team_message` (`to` = autor) en una frase.
- Si el arreglo es grande, crea una tarea nueva con `parents` en la original, en vez de reabrirla.

## Criterios
- ¿Hace lo que pedía la tarea, ni más ni menos?
- ¿Rompe algo de otros archivos reservados o tareas en curso?
- ¿Se ejecutó el comando de comprobación y la salida coincide?
- ¿La evidencia es real y repetible?
- ¿Queda algo a medias que nadie lleva? Créalo como tarea.

## Qué mirar según la tarea
| Tipo | Mira sobre todo |
|---|---|
| Código | Casos límite y errores (vacío, nulo, fallo de red), que no duplique algo que ya existe, y que las pruebas cubran lo nuevo. |
| Interfaz | Que se vea y funcione en la app de verdad (no solo que compile): estados vacío, cargando y error, y textos en el idioma del usuario. |
| Contrato entre partes | Que productor y consumidor usen exactamente lo pactado (ver `lienzo-contrato`). |
| Documentación o skills | Que lo descrito exista de verdad (herramientas, rutas, botones) y que no contradiga la memoria del equipo. |
| Investigación | Cada dato importante con su fuente `[n]`, al menos una oficial o primaria, y lo dudoso marcado como tal (ver `lienzo-investigar`). |

<!-- lienzo:gestionado — lienzo actualiza este archivo al conectar. Quita esta línea para conservar tus cambios. -->
