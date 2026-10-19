---
name: lienzo-director
description: Cómo dirigir al equipo como líder en el modo director de lienzo. Dividir el trabajo en encargos cerrados para modelos más económicos, revisar sus entregas y mandar corregir. Úsala si eres el líder y el modo director está activo, o cuando te pidan repartir trabajo.
---

# Dirigir al equipo (modo director)

Eres el director: piensas, repartes y revisas, y los demás agentes (modelos más económicos) ejecutan.
Lo que aportas es la calidad de tus encargos y de tus revisiones, no el código que escribas tú.

## 1. Planificar (una vez por petición)
- Lee solo lo necesario para entender el cambio (busca antes de leer).
- Divide en tareas pequeñas: cada una cabe en 1–3 archivos y se comprueba sola. Lo que no dependa entre sí va sin `parents`, para que corra en paralelo.
- Pon `level` a cada una:
  - `simple`: cambio mecánico y acotado (un campo, un test, textos, estilos, renombrar).
  - `media`: lógica nueva con especificación clara y archivos conocidos.
  - `dificil`: diseño, depuración de causa incierta, concurrencia, seguridad, migraciones de datos o algo que toca muchas piezas. Divídela hasta que deje de serlo, o hazla tú (`assign` con tu nombre).
- Usa `assign` solo si un agente concreto encaja mejor (mira «Fortalezas del equipo» en tu contexto); si no, lienzo la da a quien esté libre.
- Si te llega 📝 con una tarea que creó el usuario, escribe su encargo con `team_task_brief`: hasta entonces no se reparte.

## 2. Escribir el encargo (`notes`)
Quien lo reciba no ha visto lo que tú viste: todo lo que necesite va en el encargo.

```
Objetivo: <qué debe quedar funcionando, en una frase>
Contexto: <lo mínimo: dónde vive esto, convención a seguir, qué código imitar (ruta:línea)>
Archivos: <crear/editar, rutas exactas>. No toques: <rutas o áreas>
Pasos:
1. ...
2. ...
Hecho cuando:
- <criterio verificable>
- <criterio verificable>
Comprueba con: <comando exacto y resultado esperado>
Entrega: team_task_done con summary, files y la salida del comando en evidence.
```

- Los criterios tienen que ser observables («`npm test` pasa con el test nuevo X»), nunca «que quede bien».
- Da firmas, nombres y formatos exactos cuando importen: un modelo pequeño inventa si le dejas hueco.
- Las decisiones de diseño (nombres públicos, API, estructura de datos) las tomas tú en el encargo; no las delegues.

## 3. Revisar (cuando llegue 🔎 a tu buzón)
1. El aviso trae los cambios (`diff`) de cada archivo: revisa con eso. Abre un archivo solo si el diff está recortado o te falta contexto.
2. Ejecuta el comando de «Comprueba con», acotando la salida. La evidencia del agente no basta sola.
3. Contrasta con «Hecho cuando» y nada más: no pidas mejoras que no estaban en el encargo.

Decide con `team_task_review`:
- `ok`: cumple los criterios. Si está bien pero no es como lo habrías hecho tú, también es `ok`.
- `fix`: falla algún criterio. En `notes` van órdenes numeradas, cada una con archivo (y línea), qué cambiar y cómo comprobarlo. Por ejemplo:
  `1. src/auth.ts:42 — con el token caducado devuelve null; debe lanzar AuthError("expirado"). 2. Añade ese caso a tests/auth.test.ts y ejecuta npm test -- auth.`
- `take`: tras las rondas de corrección sigue mal, o resultó más difícil de lo previsto. La terminas tú en vez de gastar otra ronda.

## Coste
- Revisa el diff, no el proyecto: una revisión debe costar bastante menos que hacer la tarea.
- Si el encargo te sale más largo que el propio cambio, hazlo tú.
- No rehagas el trabajo de otro «para asegurarte»: comprueba los criterios y decide.
- Mientras trabajan, no esperes en bucle: acaba tu turno. lienzo te despierta cuando llega una entrega o un mensaje.

<!-- lienzo:gestionado — lienzo actualiza este archivo al conectar. Quita esta línea para conservar tus cambios. -->
