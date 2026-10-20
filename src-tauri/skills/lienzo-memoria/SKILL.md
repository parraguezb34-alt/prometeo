---
name: lienzo-memoria
description: Guía para consultar, proponer y gestionar la memoria del proyecto. Úsala al empezar para revisar decisiones clave de diseño, al acordar convenciones o cuando el líder gestione el conocimiento del equipo.
---

# Memoria del proyecto

La memoria guarda lo que todo el equipo debe recordar siempre: decisiones de arquitectura, convenciones y acuerdos que perduran entre tareas y sesiones.

## Diferencias clave
- **Memoria**: global, permanente y aplicable a todo el equipo.
- **Relevo** (`team_handover_save`): local a una tarea concreta, para retomar sin perder el hilo tras compactar.
- **Comentario de tarea** (`team_task_comment`): apunte o detalle puntual durante la ejecución de una tarea.

## Al empezar
- Ejecuta `team_memory_list` si vas a decidir algo de diseño o arquitectura, para no contradecir acuerdos previos.

## Roles y herramientas
- **Cualquier agente**:
  - `team_memory_propose`: propone una decisión, hecho, convención o aviso (`kind`, `text`).
  - `team_memory_list`: consulta la memoria consolidada y las propuestas pendientes.
- **Líder**:
  - `team_memory_resolve`: acepta (pudiendo ajustar el texto) o descarta una propuesta pendiente (`id`, `accept`).
  - `team_memory_save`: guarda directo una entrada consolidada en la memoria.
  - `team_memory_list`: revisa el estado de la memoria y propuestas.
  - `team_memory_forget`: elimina una entrada cuando queda obsoleta (`id`).

## Qué guardar y qué no
- **Sí guardar**: decisiones de diseño, convenciones del equipo y rutas clave.
- **No guardar**: estado temporal, logs, errores puntuales ni lo que ya está en los archivos.
- **Regla**: 1 hecho por entrada, claro y autosuficiente, máximo ~300 caracteres.

## Cuando el usuario te corrige
Una corrección del usuario que valga para más de una tarea («los textos van en español», «no uses esa librería», «los tests se corren con X») es memoria: si no se guarda, el siguiente agente repetirá el error.
- Propónla en cuanto la recibas: `team_memory_propose` con `kind: "convencion"` (cómo se hace) o `"aviso"` (qué evitar), en sus palabras y con el porqué si lo dio.
- Si solo vale para la tarea en curso, va en `team_task_comment`, no en la memoria.

## Lo que aprende el equipo
- Un dato verificado de una investigación (una versión, un límite, con su fuente): `kind: "hecho"`.
- Un contrato que debe durar (ver `lienzo-contrato`): `kind: "convencion"`, con la ruta del archivo.
- Una trampa descubierta al integrar o revisar («los tests de X solo pasan con Y»): `kind: "aviso"`.

## Ejemplos
- **Bueno** (convención): «Todas las skills van en español y con description enfocada en cuándo usarlas».
- **Bueno** (decisión): «Las propuestas de skills se crean en propuestas/ sin tocar las carpetas originales».
- **Malo**: «Ejecuté el comando de bash y devolvió código 1» (es un log temporal, no memoria del proyecto).

<!-- lienzo:gestionado — lienzo actualiza este archivo al conectar. Quita esta línea para conservar tus cambios. -->
