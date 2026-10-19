---
name: lienzo-ahorro
description: Disciplina para gastar menos tokens y que tu contexto (y el límite de uso) duren más. Úsala en tareas largas, al explorar código grande o cuando tu contexto pase del 50 %.
---

# Ahorrar tokens

Cada token que entra en tu contexto se vuelve a pagar en todos los mensajes siguientes. Gastar menos alarga tu sesión y el límite de uso del usuario.

## Leer
- Busca antes de leer: `grep`/`glob` para dar con el archivo y la línea, y lee solo ese tramo (offset y límite).
- No releas un archivo que ya tienes en contexto salvo que haya cambiado.
- Para explorar mucho código, usa un subagente si tu CLI lo tiene: te devuelve la conclusión, no los archivos.
- Mira primero la entrega de la tarea previa (`team_task_claim` te la da) antes de investigar por tu cuenta.

## Comandos
- Acota la salida: `| tail -n 40`, `--quiet`, filtros de tests (`-k nombre`), `git diff --stat` antes que el diff entero.
- No ejecutes dos veces lo mismo para ver lo mismo.

## Escribir
- `team_update` en una línea. `team_task_done` en 2–4 frases.
- Mensajes a otros agentes: la pregunta y la ruta. Nada de pegar archivos ni logs.
- Edita con cambios pequeños; no reescribas un archivo entero para cambiar unas líneas.

## Contexto lleno
- Hacia el 70 % de contexto, guarda tu relevo (skill `lienzo-relevo`) y deja que lienzo compacte. Mejor un relevo a tiempo que perder el hilo al 95 %.
- Al acabar una tarea y antes de empezar otra que no tiene que ver, también es buen momento para el relevo.

## Equipo
- Reparte lo independiente: dos agentes con contextos pequeños gastan menos que uno con todo.
- No contestes mensajes que no lo necesitan (agradecimientos, «ok»).

<!-- lienzo:gestionado — lienzo actualiza este archivo al conectar. Quita esta línea para conservar tus cambios. -->
