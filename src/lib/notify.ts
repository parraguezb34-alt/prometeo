import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

/**
 * Avisos de Windows: solo cuando lienzo no está delante (si lo estás mirando, ya lo
 * ves en el chat). Varios avisos seguidos se juntan en uno para no llenar la esquina.
 */

let granted: boolean | null = null;
let queue: { title: string; body: string }[] = [];
let timer: number | undefined;

async function allowed(): Promise<boolean> {
  if (!("__TAURI_INTERNALS__" in window)) return false;
  if (granted === null) {
    try {
      granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
    } catch {
      granted = false;
    }
  }
  return granted;
}

function flush() {
  timer = undefined;
  const items = queue;
  queue = [];
  if (items.length === 0) return;
  const one =
    items.length === 1
      ? items[0]
      : { title: `${items.length} novedades del equipo`, body: items.map((i) => `• ${i.title}`).join("\n") };
  void allowed().then((ok) => {
    if (ok) sendNotification({ title: one.title, body: one.body.slice(0, 240) });
  });
}

/** Encola un aviso; se manda tras un respiro corto, junto con los que lleguen a la vez. */
export function notify(title: string, body: string) {
  if (document.hasFocus()) return;
  queue.push({ title, body });
  if (timer === undefined) timer = window.setTimeout(flush, 1500);
}
