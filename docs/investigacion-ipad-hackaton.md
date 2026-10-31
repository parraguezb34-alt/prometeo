# Prometeo solo desde el iPad en una hackatón — investigación (#211)

Escenario: el PC se queda en casa con Prometeo abierto; el usuario lleva **solo el iPad** y entra
por Tailscale. Cada dato lleva su fuente. Donde las fuentes son de la comunidad (foros, issues) se
indica, porque son menos fiables que la documentación oficial.

Estado de Prometeo al escribir esto (rama `mejoras-dev`): acceso remoto solo por Tailscale y
loopback (#214), estado del PC visible en el iPad (#212), abrir/cerrar agentes y cambiar de
proyecto desde el iPad (#215), subir fotos y descargar archivos del chat (#216).

## 1. Safari / app en la pantalla de inicio (iPadOS 17–18)

### Eventos en segundo plano (SSE)
- iOS Safari corta la conexión `EventSource` al pasar la pestaña a segundo plano **sin lanzar
  `error`**, así que la reconexión automática del navegador no ocurre y el flujo queda muerto
  ([informe en un proyecto](https://github.com/dimakis/mitzo/pull/325),
  [otro](https://github.com/bencode/baton/issues/5); comunidad).
- `visibilitychange` no siempre llega: el proceso se suspende al bloquear la pantalla o salir de
  Safari ([WebKit 207256](https://bugs.webkit.org/show_bug.cgi?id=207256),
  [WebKit 199854](https://bugs.webkit.org/show_bug.cgi?id=199854)), y al volver desde la caché
  (bfcache) llega `pageshow` con `persisted: true` en vez de `visibilitychange`
  ([Flarum #4590](https://github.com/flarum/framework/pull/4590)).
- **Qué hacer:** al volver (`visibilitychange` visible, `pageshow`, `online`) cerrar y abrir de
  nuevo el `EventSource`, y volver a pedir el estado (`team_state`) para tapar el hueco; un vigilante
  que recree la conexión si se queda «conectando». **Prometeo hoy no lo hace** (`src/lib/bridge.ts`
  solo reabre al cambiar el token).

### «Añadir a pantalla de inicio»
- Necesita un *web app manifest* con `display` `standalone` o `fullscreen` para comportarse como
  app y para poder pedir avisos ([OneSignal: iOS web push](https://documentation.onesignal.com/docs/ios-web-push),
  [MoEngage](https://developers.moengage.com/hc/en-us/articles/13906923326100)). Lo hace #213.

### Avisos (Web Push)
- Disponibles desde iOS/iPadOS 16.4, **solo** en webs añadidas a la pantalla de inicio; el permiso
  se pide tras un toque del usuario; si se deniega, hay que quitar la app y volver a añadirla
  ([OneSignal](https://documentation.onesignal.com/docs/ios-web-push),
  [MoEngage](https://developers.moengage.com/hc/en-us/articles/13906923326100)).
- Requiere *service worker*, que los navegadores solo permiten en contexto seguro (HTTPS o
  localhost): por eso hace falta `tailscale serve` (sección 2). El envío lo hace el PC hacia el
  servicio de push de Apple, así que el PC necesita internet (ya lo necesita para los agentes).

### Fotos y archivos
- iOS Safari entrega las fotos como **JPEG** aunque estén en HEIC, con `accept="image/*"`; pero si
  `accept` incluye `image/heic`, desde Safari 17 puede convertirlas a HEIC
  ([prueba de un desarrollador](https://zenn.dev/link/comments/c356d4558e16ad),
  [WebKit 303803](https://bugs.webkit.org/show_bug.cgi?id=303803),
  [Apple Developer Forums](https://developer.apple.com/forums/thread/743049)).
  Conviene fiarse del tipo MIME, no de la extensión
  ([plyr.fm](https://tangled.org/zzstoatzz.io/plyr.fm/commit/9eb4a0cd867bc2a1c5b71579a8d636994c9b46c6)).
  Prometeo (#216) convierte HEIC→JPG en el navegador por si acaso y no pone `image/heic` en `accept`.

## 2. Tailscale

- `tailscale serve 47820` publica el puerto en `https://<pc>.<red>.ts.net` dentro de la red de
  Tailscale; requiere activar **MagicDNS** y **certificados HTTPS** en la red (si no, el propio
  comando ofrece activarlos). Los certificados son de Let's Encrypt y duran 90 días (se renuevan)
  ([Tailscale Serve](https://tailscale.com/kb/1312/serve),
  [Enabling HTTPS](https://tailscale.com/docs/how-to/set-up-https-certificates)). La sintaxis cambió en el
  cliente 1.52: los tutoriales antiguos usan otra
  ([Tailscale Serve](https://tailscale.com/kb/1312/serve)).
- Prometeo detecta la IP 100.x y si `tailscale serve` apunta a su puerto, y muestra ese enlace en
  Ajustes (#214).
- **Sin sesión iniciada en Windows, Tailscale no conecta** salvo con *Run Unattended* (Preferencias
  del icono, o `tailscale up --unattended=true`) ([Run unattended](https://tailscale.com/kb/1088/run-unattended)).
  Hay informes de que no siempre funciona antes del primer inicio de sesión: activarlo desde la
  interfaz, reiniciar y comprobarlo
  ([issue #3186](https://github.com/tailscale/tailscale/issues/3186),
  [foro](https://forum.tailscale.com/t/tailscale-doesnt-connect-until-someone-logs-into-windows/2624); comunidad).

## 3. Recuperarse sin tocar el PC

| Riesgo | Qué hacer | Fuente |
|---|---|---|
| Windows Update reinicia | Horas activas (máx. 18 h) cubriendo la hackatón, o **pausar actualizaciones** (hasta 35 días en Windows 11) la víspera | [Microsoft](https://support.microsoft.com/en-us/kb/4028233), [guía](https://braindetox.kr/en/posts/windows_update_setup_guide.html) |
| El PC se suspende | `powercfg /change standby-timeout-ac 0` y `hibernate-timeout-ac 0` (ya en `docs/acceso-remoto.md`) | — |
| Reinicio y Windows se queda en la pantalla de inicio de sesión | **Autologon** de Sysinternals (guarda la contraseña cifrada como secreto LSA); no funciona con PIN/Windows Hello obligatorio | [it@media](https://atmarkit.itmedia.co.jp/ait/spv/2205/16/news020.html), [itechguides](https://www.itechguides.com/?p=386667), [winhelponline](https://www.winhelponline.com/blog/auto-login-user-account-windows-11/) |
| Tras el reinicio Prometeo no está abierto | Arranque automático con Windows — **Prometeo no lo tiene hoy** (propuesta 3) | — |
| Corte de luz | BIOS: «Restore on AC power loss = Power On» (depende de la placa) | — |
| El PC está apagado | Wake-on-LAN no viaja por Tailscale (capa 3): hace falta otro aparato siempre encendido en casa (p. ej. Raspberry Pi como *subnet router*) que envíe el paquete | [r/Tailscale](https://redlib.hbubli.cc/r/Tailscale/comments/1jublor/question_wake_on_lansoftware), [yeri.be](https://yeri.be/remote-desktop-and-wake-on-lan/) (comunidad) |
| Prometeo se cuelga | Hoy no hay forma desde el iPad: propuesta 6 | — |

## 4. Lo que le falta a Prometeo (priorizado)

| # | Propuesta | Prioridad | Esfuerzo | Riesgo |
|---|---|---|---|---|
| 1 | **Reconexión robusta en el iPad**: reabrir SSE en `visibilitychange`/`pageshow`/`online`, vigilante si queda «conectando», volver a pedir el estado y franja visible «Reconectando…/Sin conexión con el PC» | Imprescindible | Bajo (bridge.ts + un componente) | Bajo |
| 2 | **Arranque automático de Prometeo con Windows** (interruptor en Ajustes; plugin autostart de Tauri o clave Run) y que al arrancar reabra agentes y acceso remoto (ya lo hace) | Imprescindible | Bajo | Bajo |
| 3 | **Avisos push en el iPad** cuando un agente pregunta, pide permiso, entrega o termina: service worker + manifest (#213) + claves VAPID generadas en el PC + envío desde Rust; solo con el enlace HTTPS de `tailscale serve` | Imprescindible | Alto | Medio (exige HTTPS; probar en iPad real) |
| 4 | **Estado del PC en el iPad**: conectado/último contacto, RAM y disco libres, corriente/batería, Tailscale, agentes vivos; avisar si la RAM se agota | Muy útil | Medio | Bajo |
| 5 | **Lista de comprobación de la víspera** en la guía y botón «Probar» en Ajustes (Tailscale unattended, autologon, energía, actualizaciones pausadas, HTTPS, arranque automático) | Imprescindible | Bajo | Nulo |
| 6 | **Vigilante de Prometeo**: tarea programada de Windows que lo relanza si el proceso muere o el puerto 47820 deja de responder | Muy útil | Medio | Medio (no duplicar instancias) |
| 7 | **Ver la app arrancada desde el iPad**: la pestaña App apunta a `localhost` del PC, que el iPad no alcanza; servirla por un proxy autenticado `/preview/` del acceso remoto | Muy útil | Medio | Medio (websockets de recarga en caliente) |
| 8 | **Atajos con teclado físico** en el iPad (⌘↩ enviar, ⌘K cambiar de chat, Esc detener agente) | Muy útil | Bajo | Bajo |
| 9 | **Descargar carpetas como zip** desde el chat | Opcional | Bajo | Bajo |
| 10 | Wake-on-LAN desde Prometeo (necesita un aparato extra en casa) | Opcional | Medio | Alto (hardware) |

Recomendación para #217: 1, 2 y 5 primero (baratas y evitan quedarse tirado), luego 3 (lo que más
cambia la experiencia en el iPad) y 4/8 si queda tiempo; 6 y 7 como mejora siguiente.
