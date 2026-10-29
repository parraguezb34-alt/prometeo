import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import ReactDOM from "react-dom/client";
import { installErrorCapture } from "./lib/errors";
import "./App.css";

installErrorCapture();

// La ventanita de avisos de la esquina (aviso.rs) carga esta misma página con «?aviso».
const isAviso = new URLSearchParams(window.location.search).has("aviso");
const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

if (isAviso) {
  void import("./components/Avisos").then(({ AvisoWindow }) => root.render(<AvisoWindow />));
} else {
  void import("./App").then(({ default: App }) => root.render(<App />));
}
