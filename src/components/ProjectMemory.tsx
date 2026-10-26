import { useState } from "react";
import type { CSSProperties } from "react";
import { agentColor, agentLabel, ago } from "../lib/team";
import type { MemoryEntry } from "../lib/team";
import { Icon } from "./Icon";
import { ConfirmButton } from "./ConfirmButton";

const KINDS: { id: string; label: string }[] = [
  { id: "decision", label: "Decisión" },
  { id: "hecho", label: "Hecho" },
  { id: "convencion", label: "Convención" },
  { id: "aviso", label: "Aviso" },
];

const kindLabel = (k: string) => KINDS.find((x) => x.id === k)?.label ?? "Hecho";

/**
 * Memoria del proyecto: lo que el equipo debe recordar siempre. La cura el líder
 * (o tú): los demás agentes proponen y aquí se aceptan, se reescriben o se descartan.
 * Todos los agentes la reciben en su contexto.
 */
export function ProjectMemory({
  memory,
  leader,
  onAdd,
  onResolve,
  onForget,
}: {
  memory: MemoryEntry[];
  leader: string;
  onAdd: (text: string, kind: string) => Promise<void>;
  onResolve: (id: number, accept: boolean, text?: string) => Promise<void>;
  onForget: (id: number) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState("hecho");
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);

  const active = memory.filter((m) => m.status === "active").slice().reverse();
  const proposed = memory.filter((m) => m.status === "proposed");

  const add = async () => {
    const t = draft.trim();
    if (!t) return;
    await onAdd(t, kind);
    setDraft("");
  };

  return (
    <div className="cc-pm">
      <p className="cc-pm-sub">
        Lo que todos los agentes recuerdan en cada mensaje.{" "}
        {leader ? `${agentLabel(leader)} (líder) la cura; los demás proponen.` : "Sin líder elegido, cualquiera puede guardar."}
      </p>

      {proposed.length > 0 && (
        <section className="cc-pm-sec">
          <h4>
            Propuestas <span className="cc-count">{proposed.length}</span>
          </h4>
          {proposed.map((m) => (
            <div className="cc-pm-card" data-pending="1" key={m.id} style={{ "--ac": agentColor(m.by) } as CSSProperties}>
              <div className="cc-pm-meta">
                <span className="cc-pm-kind">{kindLabel(m.kind)}</span>
                <span>
                  propone {agentLabel(m.by)} · hace {ago(m.ts_ms)}
                </span>
              </div>
              {editing?.id === m.id ? (
                <textarea
                  className="cc-pm-edit"
                  value={editing.text}
                  rows={3}
                  onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                />
              ) : (
                <div className="cc-pm-text">{m.text}</div>
              )}
              <div className="cc-btn-row">
                <button
                  className="cc-btn"
                  onClick={() => {
                    void onResolve(m.id, true, editing?.id === m.id ? editing.text : undefined);
                    setEditing(null);
                  }}
                >
                  <Icon name="check" size={14} />
                  Aceptar
                </button>
                <button
                  className="cc-btn sec"
                  onClick={() => setEditing(editing?.id === m.id ? null : { id: m.id, text: m.text })}
                >
                  <Icon name="pencil" size={14} />
                  {editing?.id === m.id ? "Cancelar edición" : "Editar"}
                </button>
                <button className="cc-btn sec" onClick={() => void onResolve(m.id, false)}>
                  <Icon name="x" size={14} />
                  Descartar
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      <section className="cc-pm-sec">
        <h4>
          En la memoria <span className="cc-count">{active.length}</span>
        </h4>
        {active.length === 0 && (
          <div className="cc-td-empty">
            Todavía no hay nada. Añade aquí lo que quieras que todos recuerden, o espera a que un agente lo proponga.
          </div>
        )}
        {active.map((m) => (
          <div className="cc-pm-card" key={m.id} style={{ "--ac": agentColor(m.by) } as CSSProperties}>
            <div className="cc-pm-meta">
              <span className="cc-pm-kind">{kindLabel(m.kind)}</span>
              <span>
                {m.by === "tú" ? "tú" : agentLabel(m.by)} · hace {ago(m.ts_ms)}
              </span>
              <ConfirmButton
                className="cc-icon-btn sm"
                onConfirm={() => void onForget(m.id)}
                confirmText="¿Seguro? Pulsa otra vez"
                title="Olvidar esta entrada"
                aria-label="Olvidar"
                style={{ width: "auto", minWidth: 20, padding: "0 6px", fontSize: 11 }}
              >
                <Icon name="x" size={13} />
              </ConfirmButton>
            </div>
            <div className="cc-pm-text">{m.text}</div>
          </div>
        ))}
      </section>

      <div className="cc-pm-add">
        <select className="cc-pm-kindsel" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Tipo">
          {KINDS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={draft}
          placeholder="Añadir a la memoria…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
        />
        <button className="cc-send-mini" onClick={() => void add()} disabled={!draft.trim()} aria-label="Guardar">
          <Icon name="plus" size={15} />
        </button>
      </div>
    </div>
  );
}
