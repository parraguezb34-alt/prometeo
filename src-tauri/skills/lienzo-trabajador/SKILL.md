---
name: lienzo-trabajador
description: Cómo ejecutar un encargo en modo director: reclamar, reservar, hacer exactamente lo pedido, comprobar y entregar. Úsala al reclamar una tarea en modo director o al recibir correcciones 🔧.
---

# Trabajar un encargo en modo director

Para lo general de coordinación (buzón, feed, canales y reservas), sigue `lienzo-equipo`. Esta guía cubre el flujo del encargo.

## 1. Reclamar y preparar
- `team_task_claim` con el id: recibes el encargo y las entregas de las tareas previas. Léelos antes de tocar nada.
- Reserva con `team_claim_files` exactamente las rutas de «Archivos» del encargo. Si no puedes reservar una, avisa al líder y no la edites.

## 2. Ejecutar al pie de la letra
- Respeta rutas, nombres y formatos exactos; nada fuera de lo pedido.
- No toques lo que el encargo marque como «No toques».
- Si el encargo no dice algo, no lo inventes: pregunta (paso 3).

## 3. Dudas
- Si algo es ambiguo o imposible, pregunta al líder (`to: "líder"`) antes de improvisar. Una frase con la duda y la ruta.
- Si la decisión es del usuario (gusto, alcance, prioridades), usa `team_ask_user` con opciones concretas.
- No preguntes lo que puedes averiguar leyendo el proyecto o las entregas previas.

## 4. Comprobar
- Ejecuta literalmente el comando de «Comprueba con», acotando la salida.
- Si falla, arréglalo y vuelve a ejecutarlo. No entregues con la comprobación en rojo.

## 5. Entregar
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
- [ ] `summary`, `files` y `evidence` están completos y liberaré las reservas.

<!-- lienzo:gestionado — lienzo actualiza este archivo al conectar. Quita esta línea para conservar tus cambios. -->
