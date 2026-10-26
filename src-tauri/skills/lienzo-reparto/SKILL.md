---
name: lienzo-reparto
description: A qué agente darle cada tarea según para qué sirve cada uno, cuánta cuota le queda y su contexto. Úsala al crear o asignar tareas (assign), al decidir si delegar algo o hacerlo tú, y cuando un compañero está cerca de su límite de uso.
---

# Repartir bien el trabajo

`team_context` lista a cada agente en línea con su modelo, su **uso** (cuánto le queda de su cuota) y lo que **se le da bien**. Con eso decides a quién va cada tarea (`assign` en `team_task_create`).

## 1. Qué pide la tarea
- **Difícil o de diseño** (arquitectura, decisiones, bugs raros, revisar el trabajo de otros): los modelos fuertes, el líder y Codex si está. Entre ellos, el que vaya más holgado de **ritmo** (`team_context`): así duran las dos cuotas.
- **Mecánica o en volumen** (renombrar, traducir, mover, tests repetitivos, aplicar un patrón conocido en muchos archivos): un modelo barato o gratis.
- **Leer mucho o buscar fuera** (documentación larga, varios archivos grandes, investigar en la web): el de contexto largo y búsqueda.
- Si el usuario escribió fortalezas en Ajustes → Equipo, mandan sobre estas pautas.

## 2. Cuánto le queda
El uso viene en escalones:
- `holgado` o `a medias`: dale lo que le toque.
- `⚠ … alto`: solo lo que necesite precisamente él; el volumen, a otro.
- `⛔ … casi agotado`: nada pesado hasta que se reinicie (el contexto dice cuándo). Si es el líder, delega más y revisa menos (lo más importante).
- `sin límite (modelos gratis)`: buen destino para el volumen, con instrucciones muy concretas.

## 3. Cómo está ahora
- Si tiene una tarea en curso, no le apiles otra que corra en paralelo: encadénala con `parents`.
- Si su contexto está muy lleno, una tarea larga nueva le costará más: mejor a otro, o que guarde antes su relevo (`lienzo-relevo`).
- Solo a agentes **en línea**: una tarea asignada a alguien desconectado se queda esperando.

## 4. Cuándo hacerlo tú
- Si explicarlo cuesta más que hacerlo (cambios de pocas líneas), hazlo tú.
- Si es la parte crítica y el resto depende de ella, hazla tú o dásela al más capaz.
- Delegar no es quitarse trabajo de encima: el encargo tiene que ser cerrado (qué, dónde, criterio de hecho; ver `lienzo-director`).

## 5. Explica el reparto
En el plan (`team_update`), una línea por agente con el porqué cuando no sea obvio: «opencode → #12 renombrar en 40 archivos (volumen, gratis) · claude → #13 diseño del caché (difícil)». Así el usuario puede corregirlo antes de aprobar.

## Errores típicos
- Todo al líder «porque lo hace mejor»: se queda sin cuota a mitad de la misión.
- Lo difícil al modelo gratis para ahorrar: vuelve con fallos y la revisión cuesta más que hacerlo bien.
- Ignorar el `⛔`: el agente se corta a mitad y la tarea queda colgada.

<!-- lienzo:gestionado — lienzo actualiza este archivo al conectar. Quita esta línea para conservar tus cambios. -->
