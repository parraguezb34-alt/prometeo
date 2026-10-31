# Prometeo desde el iPad (acceso remoto)

Los agentes siguen trabajando en el PC; el iPad abre la misma pantalla de Prometeo en Safari.
El PC tiene que estar **encendido, con Prometeo abierto y con internet**.

> Quien tenga el enlace con el token controla tus agentes y tu PC. No lo compartas, no abras
> puertos en el router y no expongas el 47820 a internet: entra solo por Tailscale.

## 1. Tailscale (una vez)

Tailscale crea una red privada entre tus aparatos. Funciona desde cualquier wifi o desde los datos
del móvil, sin tocar el router. Es gratis para uso personal.

1. En el PC: descarga Tailscale para Windows (https://tailscale.com/download/windows), instálalo
   y entra con tu cuenta (Google, Microsoft…).
2. En el iPad: instala **Tailscale** desde la App Store, entra con **la misma cuenta** y acepta
   añadir la VPN. Deja el interruptor encendido.
3. En el PC: el icono de Tailscale (bandeja) muestra la IP del PC, del tipo `100.x.y.z`.
   La verás también en https://login.tailscale.com/admin/machines.

## 2. Encender el acceso en Prometeo

1. En el PC: **Ajustes → Acceso remoto (iPad)** → enciende el interruptor.
2. Si Windows pregunta por el Firewall para Prometeo, permite **solo redes privadas**.
3. Copia el **Enlace HTTPS** si aparece (ver «HTTPS con nombre» abajo) o, si no, el **Enlace
   Tailscale** (`http://100.x.y.z:47820/?t=…`).

Prometeo escucha **solo** en la IP de Tailscale del PC y en `127.0.0.1`; nunca en la wifi
(`192.168…`), y rechaza cualquier conexión que no venga de Tailscale o del propio PC. Si Tailscale
no está conectado, Ajustes lo dice y el enlace aparece solo en cuanto se conecta, sin reiniciar
Prometeo.

## 3. Firewall: dejar entrar solo a Tailscale

En el PC, en PowerShell **como administrador**:

```powershell
New-NetFirewallRule -DisplayName "Prometeo remoto (solo Tailscale)" -Direction Inbound `
  -Protocol TCP -LocalPort 47820 -RemoteAddress 100.64.0.0/10 -Action Allow
```

`100.64.0.0/10` es el rango de direcciones de Tailscale. Para quitar la regla:
`Remove-NetFirewallRule -DisplayName "Prometeo remoto (solo Tailscale)"`.

### Opcional: HTTPS con nombre (tailscale serve)

En vez de la IP puedes tener `https://<nombre-del-pc>.<tu-red>.ts.net`:

```powershell
tailscale serve --bg 47820
```

La primera vez te pedirá activar HTTPS en el panel de Tailscale (te da el enlace). Así el tráfico
entra por Tailscale hasta `127.0.0.1:47820` y no necesitas la regla del Firewall. Para apagarlo:
`tailscale serve --https=443 off`. Añade `?t=TOKEN` (el token de Ajustes) al final de la dirección.

## 4. Que el PC no se duerma

En PowerShell (como administrador), con el PC enchufado:

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

La pantalla sí puede apagarse; lo que no puede es suspenderse ni hibernar. Además:
- **Windows Update**: en Configuración → Windows Update → Opciones avanzadas → Horas activas, pon
  las horas de la hackatón para que no reinicie entonces.
- Si se va la luz o internet en casa, el iPad dejará de conectar hasta que vuelva. Al volver la luz
  el PC no se enciende solo (salvo que la BIOS lo tenga activado), así que prueba la víspera.
- Si Prometeo se cierra, el acceso se cae. Al reabrirlo, el acceso remoto vuelve a encenderse solo
  y los agentes se reabren y retoman su conversación.

## 5. En el iPad

1. Con Tailscale encendido, abre en Safari el enlace copiado (`http://100.x.y.z:47820/?t=…`).
2. Botón Compartir → **Añadir a pantalla de inicio**: queda como una app.
3. Si pone «Enlace no válido», el token cambió: copia el enlace otra vez desde Ajustes.

## Qué se puede y qué no desde el iPad

- **Sí**: el chat del equipo, mensajes a cada agente, contestar sus preguntas, aprobar planes, ver
  tareas y programadas, escribir en las terminales de los agentes, ver los archivos del proyecto,
  **lanzar el escuadrón, abrir, cerrar y reiniciar agentes**, **cambiar a un proyecto reciente**,
  **adjuntar fotos y archivos** y **descargar** lo que te entregan los agentes (botón «Descargar»).
  Abajo a la izquierda, el botón **PC** muestra memoria, disco, corriente y Tailscale del PC.
- **No** (hazlo en el PC): elegir una carpeta nueva con el explorador de Windows, «Mostrar en la
  carpeta», actualizar Prometeo y encender, apagar o cambiar el acceso remoto.
- Si se corta la conexión, arriba sale «Reconectando con el PC…» y se recupera sola al volver.

## Lista de la víspera

Hazla entera el día antes, con tiempo para arreglar lo que falle. Al final, prueba **desde los
datos móviles del iPad** (wifi apagada): así compruebas lo mismo que en la hackatón.

**En el PC**
- [ ] **Tailscale sin iniciar sesión**: icono de Tailscale → Preferences → **Run unattended**
  (o `tailscale up --unattended=true`). Reinicia el PC y, **sin iniciar sesión**, comprueba desde
  el iPad que el PC sale conectado en Tailscale. Hay informes de que solo funciona tras activarlo
  desde la interfaz y reiniciar.
  Fuentes: [Run unattended](https://tailscale.com/kb/1088/run-unattended),
  [issue #3186](https://github.com/tailscale/tailscale/issues/3186).
- [ ] **Inicio de sesión automático** (para que Prometeo arranque tras un reinicio): descarga
  [Autologon de Sysinternals](https://learn.microsoft.com/sysinternals/downloads/autologon), pon
  usuario y contraseña → **Enable**. No funciona si Windows exige PIN o Windows Hello: en
  Configuración → Cuentas → Opciones de inicio de sesión, desactiva «Para mejorar la seguridad,
  permitir solo el inicio de sesión de Windows Hello». Fuentes:
  [it@media](https://atmarkit.itmedia.co.jp/ait/spv/2205/16/news020.html),
  [winhelponline](https://www.winhelponline.com/blog/auto-login-user-account-windows-11/).
- [ ] **Prometeo al iniciar Windows**: Ajustes → General → «Abrir Prometeo al iniciar Windows»
  (cuando esté disponible) y comprueba que tras reiniciar se abre con el acceso remoto encendido.
- [ ] **Que no se duerma**: los dos `powercfg` de la sección 4.
- [ ] **Windows Update**: Configuración → Windows Update → **Pausar actualizaciones** (hasta 35
  días en Windows 11) y, además, Horas activas cubriendo la hackatón (máximo 18 h).
  Fuentes: [Microsoft](https://support.microsoft.com/en-us/kb/4028233),
  [guía](https://braindetox.kr/en/posts/windows_update_setup_guide.html).
- [ ] **Corte de luz**: en la BIOS/UEFI, «Restore on AC Power Loss» (o parecido) = **Power On**.
  El nombre cambia según la placa; si no existe, ten a alguien en casa localizable.
- [ ] **HTTPS** (necesario para los avisos en el iPad): `tailscale serve --bg 47820` y acepta
  activar HTTPS si lo pide. En Ajustes → Acceso remoto aparecerá el **Enlace HTTPS**.
  Fuentes: [Tailscale Serve](https://tailscale.com/kb/1312/serve),
  [Enabling HTTPS](https://tailscale.com/docs/how-to/set-up-https-certificates).
- [ ] **Enchufado** y, en el botón **PC** del iPad, sin avisos de memoria ni disco.

**En el iPad**
- [ ] Tailscale instalado, con la **misma cuenta** y el interruptor encendido.
- [ ] Abre el **Enlace HTTPS** en Safari → Compartir → **Añadir a pantalla de inicio**, y abre
  Prometeo desde ese icono (los avisos solo funcionan así).
  Fuente: [OneSignal: iOS web push](https://documentation.onesignal.com/docs/ios-web-push).
- [ ] Si Prometeo ofrece «Activar avisos», actívalo con un toque (si lo deniegas, hay que quitar el
  icono y volver a añadirlo).

**Prueba final, con la wifi del iPad apagada (datos móviles)**
- [ ] Ves el proyecto, el hub conectado y los agentes en línea.
- [ ] Lanzas el escuadrón o abres un agente, y le mandas un mensaje.
- [ ] Adjuntas una foto de la cámara y el agente la puede leer.
- [ ] Un agente te entrega un archivo (`team_share_file`) y lo descargas con «Descargar».
- [ ] Bloqueas el iPad un par de minutos, vuelves y la conexión se recupera sola.
- [ ] Reinicias el PC desde el propio PC y, sin tocarlo más, vuelves a entrar desde el iPad.

## Fuentes

- Instalar Tailscale: https://tailscale.com/kb/1347/installation
- Tailscale en iOS/iPadOS: https://tailscale.com/kb/1020/install-ios
- Rango de IPs de Tailscale (100.64.0.0/10): https://tailscale.com/kb/1015/100.x-addresses
- `tailscale serve`: https://tailscale.com/kb/1242/tailscale-serve
- `New-NetFirewallRule`: https://learn.microsoft.com/powershell/module/netsecurity/new-netfirewallrule
- `powercfg`: https://learn.microsoft.com/windows-hardware/design/device-experiences/powercfg-command-line-options
