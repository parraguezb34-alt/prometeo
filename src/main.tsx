import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import ReactDOM from "react-dom/client";
import { installErrorCapture } from "./lib/errors";
import { isRemote, onRemoteAuth, remoteToken } from "./lib/bridge";
import "./App.css";

installErrorCapture();

// La ventanita de avisos de la esquina (aviso.rs) carga esta misma página con «?aviso».
const isAviso = new URLSearchParams(window.location.search).has("aviso");
const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

if (isAviso) {
  void import("./components/Avisos").then(({ AvisoWindow }) => root.render(<AvisoWindow />));
} else if (isRemote()) {
  // Acceso remoto (el iPad): sin token no hay nada que pedirle al PC; con él, primero se trae la
  // disposición de terminales del PC para no pintar un centro de mando vacío.
  void (async () => {
    const { RemoteGate } = await import("./components/RemoteGate");
    if (!remoteToken()) {
      root.render(<RemoteGate reason="sin-enlace" />);
      return;
    }
    const { syncRemoteLayout, startRemoteLayoutSync } = await import("./store");
    await syncRemoteLayout();
    startRemoteLayoutSync();
    const { default: App } = await import("./App");
    const { RemoteLinkBar } = await import("./components/RemoteLink");
    const { PcStatusChip } = await import("./components/PcStatus");
    const remoteApp = (
      <>
        <App />
        <RemoteLinkBar />
        <PcStatusChip />
      </>
    );
    let shown: "app" | "gate" | null = null;
    onRemoteAuth((ok) => {
      const want = ok ? "app" : "gate";
      if (want === shown) return;
      shown = want;
      root.render(ok ? remoteApp : <RemoteGate reason="token" />);
    });
    if (shown === null) {
      shown = "app";
      root.render(remoteApp);
    }
  })();
} else {
  void import("./App").then(({ default: App }) => root.render(<App />));
}
