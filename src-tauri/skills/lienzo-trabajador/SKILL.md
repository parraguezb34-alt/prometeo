---
name: lienzo-trabajador
description: Cómo ejecutar un encargo en modo director: reclamar, reservar, hacer exactamente lo pedido, comprobar y entregar. Úsala al reclamar una tarea en modo director o al recibir correcciones 🔧.
---

# Trabajar un encargo en modo director

Para lo general de coordinación (buzón, feed, canales y reservas), sigue `lienzo-equipo`. Esta guía cubre el flujo del encargo.

## 1. Reclamar y preparar
- `team_task_claim` con el id: recibes el encargo y las entregas de las tareas previas. Léelos antes de tocar nada.
- Si la respuesta trae «📁 CARPETA AISLADA», trabaja solo en esa copia: las rutas del encargo bajo el proyecto se traducen a la copia (misma ruta relativa) y no hace falta reservar. Al entregar, lienzo une tus cambios; si chocan, te dice qué archivos y los deja marcados con `<<<<<<<` en la copia: resuélvelos allí y entrega otra vez.
- Reserva con `team_claim_files` exactamente las rutas de «Archivos» del encargo. Si no puedes reservar una, avisa al líder y no la edites.

## 2. Ejecutar al pie de la letra
- Respeta rutas, nombres y formatos exactos; nada fuera de lo pedido.
- No toques lo que el encargo marque como «No toques».
- Si el encargo no dice algo, no lo inventes: pregunta (paso 3).

## 2b. Avisar por fases
- Si la tarea tiene varias partes, anuncia cada una con un `team_update` corto: «#N: fase 2/3, tests de exportCsv» (qué fase, de cuántas, en qué estás).
- Uno por fase, no uno por archivo. Además de que el usuario vea por dónde vas, es la señal de vida que mira lienzo: sin avances en un buen rato, te tomará por parado.

## 2c. Comandos que se cuelgan
- Lo que pueda tardar (instalar, compilar, tests largos, servidores) va con tiempo límite o en segundo plano; acota su salida.
- Si un comando se cuelga o vence, no lo repitas tal cual: averigua por qué (¿espera una respuesta por teclado? ¿un puerto ocupado? ¿un archivo bloqueado?) y cambia algo antes del siguiente intento. Dos intentos fallidos iguales → pregunta al líder.
- Nada de comandos que pidan algo por teclado: usa sus opciones no interactivas (`--yes`, `-y`, `--no-input`).

## 3. Dudas
- Si algo es ambiguo o imposible, pregunta al líder (`to: "líder"`) antes de improvisar. Una frase con la duda y la ruta.
- Si la decisión es del usuario (gusto, alcance, prioridades), usa `team_ask_user` con opciones concretas.
- **Pregunta siempre antes de** borrar archivos o carpetas que no creaste tú en esta tarea, publicar o enviar algo fuera (push, subir, desplegar, mandar mensajes) o tocar algo fuera de la carpeta del proyecto (salvo lo que el encargo nombre). Aunque parezca obvio: es difícil de deshacer.
- No preguntes lo que puedes averiguar leyendo el proyecto o las entregas previas.

## 4. Comprobar
- Ejecuta literalmente el comando de «Comprueba con», acotando la salida.
- Si falla, arréglalo y vuelve a ejecutarlo. No entregues con la comprobación en rojo.
- Lee después lo que cambiaste (el archivo o el tramo) y confirma que quedó como vas a decir. Haber ejecutado la escritura no prueba que esté bien.
- Si citas rutas, líneas o código (de este proyecto o de otro repo), comprueba cada cita: la ruta existe y es completa, el rango no pasa del final del archivo y el fragmento es literal, no reescrito de memoria.

## 5. Entregar
- Antes de cerrar, mira `team_inbox`: si el líder te mandó una corrección o una duda mientras trabajabas, atiéndela primero.
- En el `summary`, separa lo comprobado de lo supuesto: lo que no verificaste va marcado `[tentativo]`, nunca como hecho.
- `team_task_done` con `summary` (2–4 frases: qué hiciste y qué decidiste), `files` (rutas tocadas) y `evidence` (la salida real y acotada del comando).
- Después, `team_release_files` con tus reservas.

## 6. Correcciones (🔧)
- Si llega 🔧, aplica cada punto numerado tal cual, sin añadir extras.
- Vuelve a ejecutar «Comprueba con» y cierra otra vez con `team_task_done` actualizando summary, files y evidence.

## 7. Checklist antes de entregar
- [ ] Reclamé la tarea y leí el encargo y las entregas previas.
- [ ] Reservé solo los «Archivos» y respeté «No toques».
- [ ] Cumplí rutas, nombres y formatos exactos, sin nada extra.
- [ ] Ejecuté «Comprueba con» y la salida coincide.
- [ ] Releí lo que cambié y verifiqué cada ruta, rango y fragmento que cito.
- [ ] Miré el buzón y lo no comprobado va marcado `[tentativo]`.
- [ ] `summary`, `files` y `evidence` están completos y liberaré las reservas.

<!-- lienzo:gestionado — lienzo actualiza este archivo al conectar. Quita esta línea para conservar tus cambios. -->
