import { invoke } from "./bridge";

/** Versión disponible en la compilación local o en GitHub Releases (ver updater.rs). */
export type UpdateInfo = {
  available: boolean;
  setup: string;
  built_ms: number;
  version: string;
  reason: string;
  source: "dev" | "local" | "github";
  notes: string;
};

export type UpdateProgress = { downloaded: number; total: number | null; stage: "downloading" | "installing" };

export const updateCheck = () => invoke<UpdateInfo>("update_check");
/** Descarga, verifica la firma e instala GitHub; conserva el instalador local cuando existe. */
export const updateApply = () => invoke<void>("update_apply");

export type Change = { hash: string; ts_ms: number; subject: string };
/** La versión que corre: número, commit, cuándo se compiló y sus últimos commits. */
export type About = {
  version: string;
  commit: string;
  dirty: boolean;
  built_ms: number;
  changes: Change[];
  /** Es Prometeo Dev (la versión de desarrollo, con sus datos aparte). */
  dev?: boolean;
};
export const appAbout = () => invoke<About>("app_about");

/** Lo que se vio la última vez que se abrió Prometeo (para enseñar las novedades al actualizar). */
const SEEN_KEY = "lienzo.version.seen";
export type Seen = { version: string; commit: string };

export function loadSeen(): Seen | null {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return raw ? (JSON.parse(raw) as Seen) : null;
  } catch {
    return null;
  }
}

export function saveSeen(s: Seen) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(s));
  } catch {
    /* sin almacenamiento: las novedades se verán otra vez */
  }
}

/**
 * Los commits nuevos desde `seen` (los de arriba de la lista hasta el que ya se vio). Sin nada
 * visto antes (primera vez) no hay novedades; si el visto no está en la lista, las más recientes.
 */
export function newSince(changes: Change[], seen: Seen | null, max = 25): Change[] {
  if (!seen || !seen.commit) return [];
  const at = changes.findIndex((c) => c.hash === seen.commit || seen.commit.startsWith(c.hash) || c.hash.startsWith(seen.commit));
  if (at === 0) return [];
  return changes.slice(0, at < 0 ? max : Math.min(at, max));
}
