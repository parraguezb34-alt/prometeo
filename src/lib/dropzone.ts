// Quién recibe lo que arrastras a la ventana. Por defecto, el compositor del chat (adjuntos);
// mientras está abierta la pantalla de skills, ella (para instalarlas).

type Handler = (paths: string[]) => void;

let owner: Handler | null = null;

/** Toma el arrastre mientras el componente esté montado; devuelve cómo soltarlo. */
export function claimDrop(h: Handler): () => void {
  owner = h;
  return () => {
    if (owner === h) owner = null;
  };
}

export function dropOwner(): Handler | null {
  return owner;
}
