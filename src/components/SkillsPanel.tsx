import { useEffect, useMemo, useState } from "react";
import { claimDrop } from "../lib/dropzone";
import { RECOMMENDED, riskNotice, skillsInstall, skillsList, skillsRead, skillsRemove, skillsSet } from "../lib/skills";
import type { Skill, SkillLibrary } from "../lib/skills";
import { errMsg } from "../lib/team";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { Markdown } from "./Markdown";

/**
 * Ajustes → Skills: la biblioteca de guías que comparten todos los agentes. Cada una con su
 * interruptor, su modo (a demanda u obligatoria) y su categoría; se instalan pegando un enlace
 * o arrastrando una carpeta, un .zip o un SKILL.md.
 */

const CAT_ICON: Record<string, IconName> = {
  equipo: "users",
  diseno: "eye",
  codigo: "term",
  pruebas: "check",
  docs: "book",
  ahorro: "zap",
  otras: "list",
};

function origin(s: Skill): string {
  if (s.builtin) return "de Prometeo";
  const gh = /github\.com\/([^/]+\/[^/]+)/.exec(s.source);
  if (gh) return gh[1];
  if (/^https?:/.test(s.source)) return new URL(s.source).host;
  return "local";
}

export function SkillsPanel({ say }: { say: (text: string, err?: boolean) => void }) {
  const [lib, setLib] = useState<SkillLibrary | null>(null);
  const [cat, setCat] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [view, setView] = useState<{ name: string; text: string } | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string[]>([]);

  useEffect(() => {
    skillsList()
      .then(setLib)
      .catch((e) => say(errMsg(e), true));
  }, [say]);

  // Escape en la vista de una skill vuelve a la lista, sin cerrar Ajustes.
  useEffect(() => {
    if (!view) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setView(null);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [view]);

  const install = async (src: string) => {
    const s = src.trim();
    if (!s || busy) return;
    setBusy(s);
    try {
      const r = await skillsInstall(s);
      setLib(r.library);
      setFresh(r.installed);
      setSource("");
      const added = r.library.skills.filter((k) => r.installed.includes(k.name));
      const on = added.filter((k) => k.enabled).length;
      const risky = riskNotice(r.warnings);
      if (risky) {
        say(risky, true);
        return;
      }
      say(
        added.length === 1
          ? `Skill «${added[0].name}» instalada${on ? " y encendida (a demanda)" : ""}.`
          : `${added.length} skills añadidas a tu biblioteca, apagadas: enciende las que quieras.`,
      );
    } catch (e) {
      say(`No pude instalarla: ${errMsg(e)}`, true);
    } finally {
      setBusy(null);
    }
  };

  // Mientras estás aquí, lo que arrastres a la ventana se instala como skill.
  useEffect(() => claimDrop((paths) => paths.slice(0, 5).forEach((p) => void install(p))));

  const patch = async (s: Skill, p: Parameters<typeof skillsSet>[1]) => {
    try {
      setLib(await skillsSet(s.name, p));
    } catch (e) {
      say(errMsg(e), true);
    }
  };

  const open = async (s: Skill) => {
    try {
      setView({ name: s.name, text: await skillsRead(s.name) });
    } catch (e) {
      say(errMsg(e), true);
    }
  };

  const del = async (s: Skill) => {
    try {
      setLib(await skillsRemove(s.name));
      setConfirmDel(null);
      say(`«${s.name}» borrada de la biblioteca y del proyecto.`);
    } catch (e) {
      say(errMsg(e), true);
    }
  };

  const skills = useMemo(() => lib?.skills ?? [], [lib]);
  const q = query.trim().toLowerCase();
  const shown = skills.filter(
    (s) =>
      (cat === "all" || (cat === "on" ? s.enabled : s.category === cat)) &&
      (!q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)),
  );
  const onCount = skills.filter((s) => s.enabled).length;
  const always = skills.filter((s) => s.enabled && s.mode === "always").length;

  if (!lib) return <div className="st-empty">Cargando la biblioteca…</div>;

  if (view) {
    return (
      <section className="st-group">
        <div className="st-group-head">
          <div>
            <h4>{view.name}</h4>
            <p>Lo que leerán los agentes.</p>
          </div>
          <button className="cc-btn sec" onClick={() => setView(null)}>
            <Icon name="chev" size={13} />
            Volver
          </button>
        </div>
        <div className="st-card sk-read">
          <Markdown text={view.text.replace(/^---[\s\S]*?\n---\s*/, "").replace(/<!--[\s\S]*?-->/g, "")} />
        </div>
      </section>
    );
  }

  return (
    <>
      <section className="st-group">
        <div className="st-group-head">
          <div>
            <h4>Añadir skills</h4>
            <p>
              Pega un enlace de GitHub (un repositorio o la carpeta de una skill) o arrastra aquí una carpeta, un .zip o
              un SKILL.md.
            </p>
          </div>
        </div>
        <div className="st-card st-pad sk-add">
          <form
            className="st-input-row"
            onSubmit={(e) => {
              e.preventDefault();
              void install(source);
            }}
          >
            <input
              className="st-input"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="https://github.com/usuario/repo/tree/main/skills/mi-skill"
              spellCheck={false}
              aria-label="Enlace o ruta de la skill"
            />
            <button className="cc-btn" type="submit" disabled={!source.trim() || !!busy}>
              {busy === source.trim() && busy ? "Instalando…" : "Instalar"}
            </button>
          </form>
          <div className="sk-recs">
            {RECOMMENDED.map((r) => {
              const have = skills.some((s) => s.source === r.source);
              return (
                <button
                  key={r.source}
                  className="sk-rec"
                  disabled={!!busy}
                  onClick={() => void install(r.source)}
                  title={r.source}
                >
                  <Icon name={busy === r.source ? "refresh" : have ? "check" : "plus"} size={14} />
                  <span>
                    <b>{r.label}</b>
                    <small>{busy === r.source ? "Descargando…" : have ? "En tu biblioteca · pulsa para actualizar" : r.desc}</small>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <section className="st-group">
        <div className="st-group-head">
          <div>
            <h4>Tu biblioteca</h4>
            <p>
              {onCount} encendidas{always ? ` · ${always} obligatoria${always === 1 ? "" : "s"}` : ""}. Las
              obligatorias las siguen todos los agentes siempre; las de «a demanda» solo se leen cuando hacen falta
              (gastan menos).
            </p>
          </div>
        </div>
        <div className="sk-filters">
          <div className="sk-cats" role="tablist" aria-label="Categorías">
            {[{ id: "all", label: "Todas" }, { id: "on", label: "Encendidas" }, ...lib.categories].map((c) => {
              const n =
                c.id === "all" ? skills.length : c.id === "on" ? onCount : skills.filter((s) => s.category === c.id).length;
              if (n === 0 && c.id !== "all" && c.id !== "on") return null;
              return (
                <button key={c.id} role="tab" aria-selected={cat === c.id} onClick={() => setCat(c.id)}>
                  {c.label}
                  <span>{n}</span>
                </button>
              );
            })}
          </div>
          <input
            className="st-input sk-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar…"
            aria-label="Buscar skills"
          />
        </div>
        <div className="st-card sk-list">
          {shown.length === 0 && <div className="st-empty-row">Nada por aquí.</div>}
          {shown.map((s) => (
            <div className="sk-item" key={s.name} data-on={s.enabled ? "1" : "0"} data-fresh={fresh.includes(s.name) ? "1" : undefined}>
              <span className="sk-ic" data-cat={s.category}>
                <Icon name={CAT_ICON[s.category] ?? "list"} size={15} />
              </span>
              <div className="sk-main">
                <div className="sk-name">
                  <b>{s.name}</b>
                  {s.enabled && s.mode === "always" && <span className="sk-badge">Obligatoria</span>}
                  <span className="sk-origin">{origin(s)}</span>
                </div>
                {s.description && <p className="sk-desc">{s.description}</p>}
                <div className="sk-ctl">
                  <div className="td-seg st-seg sk-mode" role="radiogroup" aria-label={`Modo de ${s.name}`}>
                    {(
                      [
                        ["auto", "A demanda"],
                        ["always", "Obligatoria"],
                      ] as const
                    ).map(([v, l]) => (
                      <button
                        key={v}
                        role="radio"
                        aria-checked={s.mode === v}
                        disabled={!s.enabled}
                        onClick={() => void patch(s, { mode: v })}
                      >
                        {l}
                      </button>
                    ))}
                  </div>
                  <span className="cc-select sk-cat">
                    <select
                      aria-label={`Categoría de ${s.name}`}
                      value={s.category}
                      onChange={(e) => void patch(s, { category: e.target.value })}
                    >
                      {lib.categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                    <Icon name="chev" size={13} />
                  </span>
                  <button className="st-link" onClick={() => void open(s)}>
                    Ver
                  </button>
                  {!s.builtin &&
                    (confirmDel === s.name ? (
                      <span className="sk-confirm">
                        ¿Borrarla?
                        <button className="st-link" data-tone="warn" onClick={() => void del(s)}>
                          Sí, borrar
                        </button>
                        <button className="st-link" onClick={() => setConfirmDel(null)}>
                          No
                        </button>
                      </span>
                    ) : (
                      <button className="st-link" onClick={() => setConfirmDel(s.name)}>
                        Borrar
                      </button>
                    ))}
                </div>
              </div>
              <button
                className="st-switch"
                role="switch"
                aria-checked={s.enabled}
                aria-label={`${s.enabled ? "Apagar" : "Encender"} ${s.name}`}
                disabled={s.locked}
                title={s.locked ? "La base del equipo: siempre encendida" : undefined}
                onClick={() => void patch(s, { enabled: !s.enabled })}
              >
                <span />
              </button>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
