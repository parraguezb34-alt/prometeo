import { useEffect, useRef, useState } from "react";
import { ago } from "../../lib/team";
import { appAbout, loadSeen, newSince, saveSeen } from "../../lib/update";
import type { Change } from "../../lib/update";
import { Icon } from "../Icon";

/** «Novedades»: al abrir una versión nueva, los commits que trae (una vez). */
export function NewsCard() {
  const [news, setNews] = useState<{ version: string; changes: Change[] } | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    appAbout()
      .then((a) => {
        const seen = loadSeen();
        if (seen?.version === a.version && seen.commit === a.commit) return;
        // La primera vez que hay novedades (sin nada visto antes), las últimas.
        const list = seen ? newSince(a.changes, seen) : a.changes.slice(0, 8);
        saveSeen({ version: a.version, commit: a.commit });
        if (list.length) setNews({ version: a.version, changes: list });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!news) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNews(null);
    };
    const onClick = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        setNews(null);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [news]);

  if (!news) return null;
  return (
    <div ref={cardRef} className="cc-news" role="dialog" aria-label="Novedades de Prometeo">
      <header>
        <b>Novedades de Prometeo {news.version}</b>
        <button className="ap-icon" onClick={() => setNews(null)} aria-label="Cerrar" title="Cerrar">
          <Icon name="x" size={14} />
        </button>
      </header>
      <ul>
        {news.changes.map((c) => (
          <li key={c.hash}>
            <span>{c.subject}</span>
            <time>{ago(c.ts_ms)}</time>
          </li>
        ))}
      </ul>
      <button className="hs-btn" onClick={() => setNews(null)}>
        Entendido
      </button>
    </div>
  );
}
