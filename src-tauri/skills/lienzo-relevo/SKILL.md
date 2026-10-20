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
Objetivo: Mejorar skill lienzo-equipo con pautas de buzón y reservas.
Hecho: Creado propuestas/lienzo-equipo/SKILL.md con reglas de concurrencia.
Decisiones: Mantener description enfocada en cuándo usarla para el selector de skills.
Falta: Validar formato con bash y cerrar tarea #44 con team_task_done.
Ojo: No tocar las skills originales de .claude/ ni dejar marcas automáticas.
```

## Después
- Al retomar tras compactar: lee tu relevo con team_task_claim antes de nada.
- Si lo que decidiste vale para todo el equipo, propónlo también con `team_memory_propose`.
- Libera las reservas que ya no necesites.

<!-- lienzo:gestionado — lienzo actualiza este archivo al conectar. Quita esta línea para conservar tus cambios. -->
