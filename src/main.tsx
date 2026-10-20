import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AvisoWindow } from "./components/Avisos";
import { installErrorCapture } from "./lib/errors";
import "./App.css";

installErrorCapture();

// La ventanita de avisos de la esquina (aviso.rs) carga esta misma página con «?aviso».
const isAviso = new URLSearchParams(window.location.search).has("aviso");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(isAviso ? <AvisoWindow /> : <App />);
