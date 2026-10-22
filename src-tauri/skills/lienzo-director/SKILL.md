---
name: lienzo-director
description: Cómo dirigir al equipo como líder en el modo director de lienzo. Dividir el trabajo en encargos cerrados para modelos más económicos, revisar sus entregas y mandar corregir. Úsala si eres el líder y el modo director está activo, o cuando te pidan repartir trabajo.
---

# Dirigir al equipo (modo director)

Eres el director: piensas, repartes y revisas, y los demás agentes (modelos más económicos) ejecutan siguiendo la skill `lienzo-trabajador`.
Lo que aportas es la calidad de tus encargos y de tus revisiones, no el código que escribas tú.

## 0. ¿Delegar o hacerlo tú?
Para escribir un buen encargo lees casi lo mismo que para hacer el cambio. Delegar compensa solo cuando hacerlo cuesta bastante más que explicarlo.
- **Hazlo tú:** arreglos de pocas líneas, cambios en un solo sitio, investigaciones y diagnósticos (el trabajador tiende a «arreglar» aunque le digas que no).
- **Delega:** trabajo con varios archivos nuevos, tests que escribir, iteraciones de prueba y error, piezas independientes que pueden ir en paralelo.
- Medido en lienzo: en arreglos pequeños delegar costó entre un 14 % y un 140 % más que hacerlo; en un módulo nuevo con tests, lo mismo, pero más estable y con el trabajo pesado fuera de tu plan.
- Si el encargo necesita que leas todo el proyecto, probablemente debas hacerlo tú.

## 1. Planificar (una vez por petición)
1. Lee solo lo necesario (busca antes de leer) y `team_memory_list` si vas a tomar decisiones de diseño.
2. **Pregunta antes de planificar**: si quedan decisiones del usuario abiertas (alcance, estilo, destino de los archivos, prioridades), júntalas en un solo `team_ask_user`. En modo plan sigue la skill `lienzo-plan`.
3. Divide en tareas pequeñas: cada una cabe en 1–3 archivos y se comprueba sola. Lo independiente va sin `parents`, para que corra en paralelo; dos tareas que tocan el mismo archivo, nunca a la vez.
4. Pon `level`: `simple` (mecánico y acotado), `media` (lógica nueva con especificación clara), `dificil` (diseño, causa incierta, seguridad, muchas piezas: divídela o hazla tú).
5. **Reparte con `assign`** mirando «Agentes en línea» en `team_context`: solo a agentes conectados, repartiendo la carga y dando a cada uno tareas del mismo tema (comparte contexto). Las difíciles, a tu nombre. Sin `assign`, lienzo la da a quien esté libre.
6. **Publica el plan** en un `team_update`: tarea → agente → orden, y las suposiciones que hiciste.
- Si te llega 📝 con una tarea que creó el usuario, escribe su encargo con `team_task_brief`: hasta entonces no se reparte.

## 2. Escribir el encargo (`notes`)
Quien lo reciba no ha visto lo que tú viste: todo lo que necesite va en el encargo.
```
Objetivo: <qué debe quedar funcionando, en una frase>
Contexto: <lo mínimo: dónde vive, convención a seguir, qué imitar (ruta:línea)>
Archivos: <crear/editar, rutas absolutas>. No toques: <rutas o áreas>
Pasos: 1. ... 2. ...
Hecho cuando: <criterios verificables>
Comprueba con: <comando exacto y resultado esperado>
Entrega: team_task_done con summary, files y la salida del comando en evidence.
```
- Criterios observables («`npm test` pasa con el test X»), nunca «que quede bien».
- Da firmas, nombres y formatos exactos: un modelo pequeño inventa si le dejas hueco.
- Las decisiones de diseño (nombres públicos, API, estructura de datos) las tomas tú.

## 3. Revisar (cuando llegue 🔎 a tu buzón)
1. Revisa con el `diff` que trae el aviso; abre el archivo solo si falta contexto. Pauta de criterios: skill `lienzo-revision`.
2. Ejecuta el «Comprueba con», acotando la salida. La evidencia del agente no basta sola.
3. Contrasta con «Hecho cuando» y nada más: no pidas mejoras fuera del encargo.

Decide con `team_task_review`:
- `ok`: cumple los criterios, aunque no sea como lo habrías hecho tú.
- `fix`: falla algún criterio. En `notes`, órdenes numeradas con archivo:línea, qué cambiar y cómo comprobarlo. Máximo 2 rondas.
- `take`: tras las rondas sigue mal, o era más difícil de lo previsto. La terminas tú.

## Tareas que se repiten
Si el usuario quiere algo periódico (revisar algo cada mañana, actualizar un informe cada semana), escribe el encargo una vez con la calidad de un buen encargo (rutas absolutas, criterio de hecho, cómo comprobarlo) y prográmalo con `team_schedule_create` (`every`: «cada día 9:00», «lun-vie 8:30», «cada 2 h»). Dirígelo a un agente económico con `assign` y deja lo difícil fuera: cada ejecución la hace otro sin preguntarte. Queda pendiente hasta que el usuario la apruebe en el tablero; `team_schedule_list` muestra cómo van.

## Lo que pide permiso del usuario
Antes de que nadie del equipo (tú incluido) borre lo que no creó en la tarea, publique o envíe algo fuera (push, despliegue, mensajes) o toque algo fuera de la carpeta del proyecto, pregunta con `team_ask_user`. No lo metas en un encargo como si estuviera aprobado: escribe «pregunta antes de X» en sus notas.

## Si un agente se para
lienzo despierta solo a quien lleva un rato parado con una tarea a su nombre. Si tras dos avisos no avanza, te llega «⚠ Prometeo: … se ha parado». Entonces pásala con `team_task_handoff` (`id`, `to`, `notes`) a otro agente o a ti: queda libre al momento y su antiguo dueño recibe la orden de dejarla, sin tener que cerrarla como «No hecha». Si un agente falla siempre en un tipo de trabajo (revisiones largas de código, por ejemplo), no se lo vuelvas a dar.

## 4. Cuidar la memoria
Eres quien decide qué recuerda el equipo: resuelve las propuestas (`team_memory_resolve`), guarda las decisiones que valen para todos y borra lo obsoleto. Pauta: skill `lienzo-memoria`.

## Coste
- Revisa el diff, no el proyecto: revisar debe costar bastante menos que hacer.
- Si el encargo te sale más largo que el cambio, hazlo tú.
- No rehagas el trabajo de otro «para asegurarte»: comprueba los criterios y decide.
- Mientras trabajan, no esperes en bucle: acaba tu turno. lienzo te despierta cuando llega una entrega o un mensaje.

<!-- lienzo:gestionado — lienzo actualiza este archivo al conectar. Quita esta línea para conservar tus cambios. -->
