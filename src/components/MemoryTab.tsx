import { agentColor, ago } from "../lib/team";
import type { TeamTask } from "../lib/team";

const PREVIEW_EXT = /\.(html?|svg|md|markdown)$/i;

/**
 * Memoria del equipo: los relevos reales que los agentes guardaron con
 * team_handover_save antes de compactar su contexto. Van pegados a su tarea,
 * así que aquí se ve qué hizo cada uno, cuándo y qué archivos tocó.
 */
export function MemoryTab({
  tasks,
  onOpenTask,
  onPreview,
}: {
  tasks: TeamTask[];
  onOpenTask: (id: number) => void;
  onPreview: (rel: string) => void;
}) {
  const withHandover = tasks
    .filter((t) => t.handover)
    .slice()
    .sort((a, b) => (b.handover?.ts_ms ?? 0) - (a.handover?.ts_ms ?? 0));

  return (
    <div className="cc-mem">
      <div className="cc-mem-head">
        <div className="cc-mem-title">Relevos del equipo</div>
        <p className="cc-mem-sub">
          Lo que cada agente guardó justo antes de compactar su contexto: decisiones, avances y qué
          falta. Quedan pegados a su tarea.
        </p>
      </div>

      {withHandover.length === 0 && (
        <div className="cc-empty">
          <div>
            Aún no hay relevos guardados.
            <br />
            Pídele uno a un agente con «Relevo» (en el modal de Equipo): guardará su resumen y
            Prometeo compactará su contexto sin perder el hilo.
          </div>
        </div>
      )}

      {withHandover.map((t) => {
        const h = t.handover!;
        return (
          <div className="cc-mem-card" key={t.id}>
            <div className="cc-mem-l1">
              <button
                className="cc-mem-task"
                onClick={() => onOpenTask(t.id)}
                title={`Ver los cambios de la tarea #${t.id}`}
              >
                <span className="cc-mem-id">#{t.id}</span> {t.title}
              </button>
              <span className="cc-mem-meta">
                <span style={{ color: agentColor(h.by) }}>{h.by}</span> · hace {ago(h.ts_ms)}
              </span>
            </div>
            <div className="cc-mem-text">{h.text}</div>
            {h.files.length > 0 && (
              <div className="cc-mem-files">
                {h.files.map((f) => {
                  const can = PREVIEW_EXT.test(f);
                  return (
                    <span
                      className="cc-file-chip"
                      key={f}
                      data-click={can ? "1" : "0"}
                      onClick={can ? () => onPreview(f) : undefined}
                      title={can ? `Abrir ${f}` : f}
                    >
                      {f}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
