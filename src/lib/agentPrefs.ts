/** Ajustes por agente (modelo y esfuerzo) y arranque automático. Viven en el
 * navegador: se aplican al abrir cada agente y al reiniciarlo desde el modal. */
export type AgentPref = { model?: string | null; effort?: string | null };

const PREFS_KEY = "lienzo.agentprefs.v1";
const AUTO_KEY = "lienzo.autostart.v1";

export function loadPrefs(): Record<string, AgentPref> {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, AgentPref>;
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch {
    /* almacenamiento no disponible: sin ajustes guardados */
  }
  return {};
}

export function savePrefs(prefs: Record<string, AgentPref>) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* sin almacenamiento: no se recordarán */
  }
}

/** Ajustes de un agente tal como se guardaron (para quien lanza sin pasar por la UI de equipo). */
export function prefsFor(agent: string): AgentPref {
  return loadPrefs()[agent] ?? {};
}

const APPLIED_KEY = "lienzo.agentapplied.v1";

/** Lo último que se aplicó a la sesión de cada agente. Se guarda para que, al reabrir Prometeo
 * (las terminales vuelven con las mismas flags), no aparezca un «Reiniciar con esto» falso. */
export function loadApplied(): Record<string, AgentPref | undefined> {
  try {
    const raw = localStorage.getItem(APPLIED_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, AgentPref>;
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch {
    /* sin almacenamiento */
  }
  return {};
}

export function saveApplied(applied: Record<string, AgentPref | undefined>) {
  try {
    localStorage.setItem(APPLIED_KEY, JSON.stringify(applied));
  } catch {
    /* sin almacenamiento */
  }
}

export function loadAutoStart(): boolean {
  try {
    const v = localStorage.getItem(AUTO_KEY);
    return v == null ? true : v === "1";
  } catch {
    return true;
  }
}

export function saveAutoStart(on: boolean) {
  try {
    localStorage.setItem(AUTO_KEY, on ? "1" : "0");
  } catch {
    /* sin almacenamiento: no se recordará */
  }
}
