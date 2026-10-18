import { useState } from "react";
import { Canvas } from "./components/Canvas";
import { CommandCenter } from "./components/CommandCenter";
import "./App.css";
import "./cc2.css";

type Mode = "command" | "canvas";
const MODE_KEY = "lienzo.mode.v1";

function loadMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === "canvas" ? "canvas" : "command";
  } catch {
    return "command";
  }
}

function App() {
  const [mode, setMode] = useState<Mode>(loadMode);
  const switchMode = (m: Mode) => {
    setMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* storage unavailable: mode won't persist */
    }
  };
  return (
    <div className="app">
      {mode === "command" ? (
        <CommandCenter onMode={switchMode} />
      ) : (
        <Canvas onMode={switchMode} />
      )}
    </div>
  );
}

export default App;
