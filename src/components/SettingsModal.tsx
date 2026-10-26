import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { AgentPref } from "../lib/agentPrefs";
import type { DispatchState } from "../lib/dispatcher";
import { testNotify } from "../lib/notify";
import type { ProjectInfo } from "../lib/project";
import { DEFAULT_SETTINGS, resetSettings, updateSettings, useSettings } from "../lib/settings";
import type { LeaderMode } from "../lib/settings";
import { agentColor, agentInitial, agentLabel, ago, errMsg, shortPath, teamDetails, teamDirector, teamIsolate, teamStrengths, teamUsageReset } from "../lib/team";
import { cachePct, sumUsage, totalTokens, usageOf } from "../lib/usage";
import { fmtTokens } from "./AgentCard";
import type { DetectResult, ModelCatalog, TeamDetails, TeamState } from "../lib/team";
import { Icon } from "./Icon";
import { ConfirmButton } from "./ConfirmButton";
import { SkillsPanel } from "./SkillsPanel";
import { ErrorsPanel } from "./ErrorsPanel";
import { useUnseenErrors } from "../lib/errors";
import type { IconName } from "./Icon";
import { EFFORT_LABEL } from "./TeamModal";
import { appAbout, updateCheck } from "../lib/update";
import type { About, UpdateInfo } from "../lib/update";

export type SettingsSection = "general" | "agents" | "team" | "skills" | "usage" | "dispatch" | "notify" | "hub" | "errors" | "about";

const SECTIONS: { id: SettingsSection; label: string; icon: IconName; hint: string }[] = [
  { id: "general", label: "General", icon: "settings", hint: "Proyecto y arranque" },
  { id: "agents", label: "Agentes", icon: "users", hint: "Conexión y modelos" },
  { id: "team", label: "Equipo", icon: "shield", hint: "Líder, normas y mensajes" },
  { id: "skills", label: "Skills", icon: "book", hint: "Guías de los agentes" },
  { id: "usage", label: "Consumo", icon: "pulse", hint: "Tokens y ahorro" },
  { id: "dispatch", label: "Despacho", icon: "zap", hint: "Reparto de tareas" },
  { id: "notify", label: "Avisos", icon: "bell", hint: "Notificaciones" },
  { id: "hub", label: "Conexión", icon: "plug", hint: "Hub y diagnóstico" },
  { id: "errors", label: "Errores", icon: "warn", hint: "Registro de fallos" },
  { id: "about", label: "Acerca de", icon: "app", hint: "Versión y novedades" },
];

/** Frases listas para las normas: se añaden al final si aún no están. */
const CHARTER_SNIPPETS: { label: string; text: string }[] = [
  { label: "Responder en español", text: "Responde y escribe los resúmenes de las tareas en español." },
  {
    label: "Pruebas antes de cerrar",
    text: "Antes de marcar una tarea como hecha, ejecuta las pruebas del proyecto y pon el resultado en evidence.",
  },
  {
    label: "Revisión cruzada",
    text: "Cuando termines algo grande, pide a otro agente con team_message que revise los cambios antes de cerrar la tarea.",
  },
  { label: "Commits pequeños", text: "Haz un commit por tarea terminada, con un mensaje claro." },
  {
    label: "Preguntar antes de borrar",
    text: "No borres archivos ni cambies dependencias sin preguntar antes al usuario.",
  },
  {
    label: "Reservar archivos",
    text: "Reserva siempre con team_claim_files lo que vayas a editar y libéralo al acabar.",
  },
];

type Props = {
  initial: SettingsSection;
  state: TeamState | null;
  detect: DetectResult | null;
  info: ProjectInfo | null;
  hubOk: boolean;
  catalogs: Record<string, ModelCatalog | null | undefined>;
  prefs: Record<string, AgentPref>;
  opening: string | null;
  autoStart: boolean;
  shoot: "plan" | "exec";
  chatsMin: boolean;
  dispatchOn: boolean;
  dispatchState: DispatchState;
  notifyOn: boolean;
  onClose: () => void;
  say: (text: string, err?: boolean) => void;
  onPref: (name: string, patch: AgentPref) => void;
  onAutoStart: (on: boolean) => void;
  onShoot: (m: "plan" | "exec") => void;
  onChatsMin: (min: boolean) => void;
  onDispatch: (on: boolean) => void;
  onDispatchClear: () => void;
  onNotify: (on: boolean) => void;
  onProject: (path: string | null) => Promise<void>;
  onConnect: (id: string) => Promise<void>;
  onOpenAgent: (id: string) => void;
  onTeamRules: (charter: string | null, leader: string | null) => Promise<void>;
};

export function SettingsModal(props: Props) {
  const [section, setSection] = useState<SettingsSection>(props.initial);
  useEffect(() => setSection(props.initial), [props.initial]);
  const cur = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  const unseen = useUnseenErrors();

  return (
    <>
      <div className="cc-scrim" onClick={props.onClose} />
      <section className="cc-modal st" role="dialog" aria-label="Ajustes">
        <nav className="st-nav" aria-label="Secciones de ajustes">
          <div className="st-nav-title">Ajustes</div>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className="st-nav-item"
              aria-current={s.id === section ? "page" : undefined}
              onClick={() => setSection(s.id)}
            >
              <Icon name={s.icon} size={16} />
              <span>
                <b>{s.label}</b>
                <small>{s.hint}</small>
              </span>
              {s.id === "errors" && unseen > 0 && <i className="st-nav-badge">{unseen}</i>}
            </button>
          ))}
          <div className="st-nav-foot">
            <span className="cc-kbd">Ctrl</span>
            <span className="cc-kbd">,</span>
            <span>abre los ajustes</span>
          </div>
        </nav>

        <div className="st-main">
          <div className="st-top">
            <h3>{cur.label}</h3>
            <button className="cc-icon-btn" onClick={props.onClose} aria-label="Cerrar" title="Cerrar (Esc)">
              <Icon name="x" />
            </button>
          </div>
          <div className="st-body" key={section}>
            {section === "general" && <General {...props} />}
            {section === "agents" && <Agents {...props} />}
            {section === "team" && <Team {...props} />}
            {section === "skills" && <SkillsPanel say={props.say} />}
            {section === "usage" && <Usage {...props} />}
            {section === "dispatch" && <Dispatch {...props} />}
            {section === "notify" && <Notify {...props} />}
            {section === "hub" && <Hub {...props} />}
            {section === "errors" && <ErrorsPanel say={props.say} />}
            {section === "about" && <AboutPanel />}
          </div>
        </div>
      </section>
    </>
  );
}

// ---- piezas comunes ------------------------------------------------------------------

function Group({ title, desc, children, aside }: { title: string; desc?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="st-group">
      <div className="st-group-head">
        <div>
          <h4>{title}</h4>
          {desc && <p>{desc}</p>}
        </div>
        {aside}
      </div>
      <div className="st-card">{children}</div>
    </section>
  );
}

function Row({ label, hint, children, disabled }: { label: string; hint?: ReactNode; children?: ReactNode; disabled?: boolean }) {
  return (
    <div className="st-row" data-off={disabled ? "1" : undefined}>
      <div className="st-row-txt">
        <span className="st-row-l">{label}</span>
        {hint && <span className="st-row-h">{hint}</span>}
      </div>
      {children && <div className="st-row-ctl">{children}</div>}
    </div>
  );
}

function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      className="st-switch"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <span />
    </button>
  );
}

function Seg<T extends string | number>({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: T;
  options: { v: T; l: string }[];
  onChange: (v: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div className="td-seg st-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.v)} role="radio" aria-checked={o.v === value} disabled={disabled} onClick={() => onChange(o.v)}>
          {o.l}
        </button>
      ))}
    </div>
  );
}

function Pick<T extends string | number>({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: T;
  options: { v: T; l: string }[];
  onChange: (v: T) => void;
  label: string;
  disabled?: boolean;
}) {
  // Si el valor guardado no está en la lista (p. ej. de una versión anterior), se muestra igual.
  const opts = options.some((o) => o.v === value) ? options : [{ v: value, l: String(value) }, ...options];
  return (
    <span className="cc-select">
      <select
        aria-label={label}
        disabled={disabled}
        value={String(value)}
        onChange={(e) => {
          const o = opts.find((x) => String(x.v) === e.target.value);
          if (o) onChange(o.v);
        }}
      >
        {opts.map((o) => (
          <option key={String(o.v)} value={String(o.v)}>
            {o.l}
          </option>
        ))}
      </select>
      <Icon name="chev" size={13} />
    </span>
  );
}

function CopyBtn({ text, say }: { text: string; say: Props["say"] }) {
  return (
    <button
      className="cc-icon-btn st-mini"
      title="Copiar"
      aria-label="Copiar"
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => say("Copiado al portapapeles."),
          () => say("No pude copiarlo.", true),
        );
      }}
    >
      <Icon name="copy" size={14} />
    </button>
  );
}

// ---- General -------------------------------------------------------------------------

/** Animaciones del chat (puntos, mensajes que se escriben, anillo del agente…). */
function MotionGroup() {
  const motion = useSettings().ui.motion;
  return (
    <Group title="Animaciones">
      <Row
        label="Movimiento en el chat"
        hint="«Como Windows» las apaga si tienes desactivados los efectos de animación del sistema."
      >
        <Seg
          label="Animaciones"
          value={motion}
          options={[
            { v: "on", l: "Siempre" },
            { v: "system", l: "Como Windows" },
            { v: "off", l: "Reducidas" },
          ]}
          onChange={(v) => updateSettings({ ui: { motion: v } })}
        />
      </Row>
    </Group>
  );
}

function General({ state, info, autoStart, shoot, chatsMin, say, onAutoStart, onShoot, onChatsMin, onProject }: Props) {
  const settings = useSettings();
  const saved = state?.project ?? "";
  const [draft, setDraft] = useState(saved);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(saved), [saved]);
  const dirty = draft.trim() !== saved;
  const recents = settings.recentProjects.filter((p) => p.toLowerCase() !== saved.toLowerCase());

  const save = async (path: string) => {
    setBusy(true);
    try {
      await onProject(path.trim() || null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Group
        title="Carpeta del proyecto"
        desc="Donde trabajan los agentes. Al conectarlos, Prometeo escribe aquí su configuración MCP y las normas del equipo."
      >
        <div className="st-pad">
          <div className="st-input-row">
            <input
              className="st-input"
              value={draft}
              spellCheck={false}
              placeholder={"C:\\ruta\\del\\proyecto"}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && dirty) void save(draft);
                if (e.key === "Escape" && dirty) {
                  e.stopPropagation();
                  setDraft(saved);
                }
              }}
            />
            <button className="cc-btn" disabled={!dirty || busy} onClick={() => void save(draft)}>
              {busy ? "Guardando…" : "Guardar"}
            </button>
          </div>
          <div className="st-proj-meta">
            {saved ? (
              <>
                <span className="st-pill" data-tone={info?.repo ? "ok" : undefined}>
                  {info?.repo ? `git · ${info.branch || "sin rama"}` : "sin git"}
                </span>
                <button
                  className="st-link"
                  onClick={() => revealItemInDir(saved).catch((e) => say(errMsg(e), true))}
                >
                  <Icon name="folder" size={13} />
                  Mostrar en el explorador
                </button>
              </>
            ) : (
              <span className="st-pill" data-tone="warn">
                Sin carpeta: los agentes no se pueden conectar
              </span>
            )}
          </div>
          {recents.length > 0 && (
            <div className="st-recents">
              <span className="st-row-h">Recientes</span>
              {recents.map((p) => (
                <button key={p} className="st-chip" title={p} disabled={busy} onClick={() => void save(p)}>
                  <Icon name="folder" size={12} />
                  {shortPath(p)}
                </button>
              ))}
            </div>
          )}
        </div>
      </Group>

      <Group title="Al abrir Prometeo">
        <Row
          label="Abrir el equipo al iniciar"
          hint="Conecta los agentes instalados y abre los que no estén en marcha. Los que quites del equipo en Agentes no se abren."
        >
          <Switch on={autoStart} onChange={onAutoStart} label="Abrir el equipo al iniciar" />
        </Row>
        <Row label="Modo de las misiones" hint="Planificar analiza y propone sin tocar código; Directo se pone a trabajar ya.">
          <Seg
            label="Modo de las misiones"
            value={shoot}
            onChange={onShoot}
            options={[
              { v: "plan", l: "Planificar" },
              { v: "exec", l: "Directo" },
            ]}
          />
        </Row>
        <Row label="Lista de chats" hint="Cómo se ve la columna de chats de la izquierda.">
          <Seg
            label="Lista de chats"
            value={chatsMin ? "min" : "full"}
            onChange={(v) => onChatsMin(v === "min")}
            options={[
              { v: "full", l: "Completa" },
              { v: "min", l: "Compacta" },
            ]}
          />
        </Row>
      </Group>

      <MotionGroup />

      <Group title="Atajos">
        <Row label="Abrir los ajustes">
          <span className="st-keys">
            <span className="cc-kbd">Ctrl</span>
            <span className="cc-kbd">,</span>
          </span>
        </Row>
        <Row label="Cerrar la ventana de arriba">
          <span className="cc-kbd">Esc</span>
        </Row>
      </Group>
    </>
  );
}

// ---- Agentes -------------------------------------------------------------------------

/** Qué se le da bien a un agente: el líder lo tiene en cuenta al repartir en modo director. */
function StrengthField({ agent, label, saved }: { agent: string; label: string; saved: string }) {
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  const save = () => {
    if (draft.trim() !== saved.trim()) void teamStrengths(agent, draft).catch(() => {});
  };
  return (
    <label className="cc-field st-strength">
      <span className="cc-field-l">Se le da bien</span>
      <input
        className="st-input"
        type="text"
        value={draft}
        maxLength={200}
        placeholder={`Ej.: interfaz y estilos, tests… (para que el líder sepa qué darle a ${label})`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}

function Agents({ state, detect, catalogs, prefs, opening, onPref, onConnect, onOpenAgent }: Props) {
  const settings = useSettings();
  const [connecting, setConnecting] = useState<string | null>(null);
  const list = detect?.agents ?? [];
  const leader = state?.leader ?? "";
  const hasProject = !!state?.project;

  if (list.length === 0) {
    return (
      <div className="st-empty">
        {detect ? "No encontré Claude Code, OpenCode, Codex ni Antigravity en este equipo." : "Buscando agentes instalados…"}
      </div>
    );
  }

  return (
    <>
      <p className="st-lead">
        Los agentes que Prometeo encontró en este equipo. El modelo y el esfuerzo que elijas aquí se usan cada vez que
        se abren; para cambiarlos en uno que ya está en marcha, usa el panel Equipo.
      </p>
      <div className="st-agents">
        {list.map((d) => {
          const sess = (state?.agents ?? []).filter((a) => a.name === d.id);
          const online = sess.some((a) => a.online);
          const inTeam = !settings.skipAgents.includes(d.id);
          const cat = catalogs[d.id];
          const pref = prefs[d.id] ?? {};
          const chosen = cat?.models.find((m) => m.id === pref.model);
          const efforts = chosen && chosen.efforts.length > 0 ? chosen.efforts : (cat?.efforts ?? []);
          const found = d.cli_found || d.config_dir_found;
          return (
            <article
              key={d.id}
              className="st-agent"
              data-off={inTeam ? undefined : "1"}
              style={{ "--ac": agentColor(d.id) } as CSSProperties}
            >
              <div className="st-agent-top">
                <span className="st-avatar">{agentInitial(d.id)}</span>
                <div className="st-agent-id">
                  <div className="st-agent-name">
                    {d.label}
                    {leader === d.id && (
                      <span className="st-pill" data-tone="accent">
                        <Icon name="crown" size={11} />
                        líder
                      </span>
                    )}
                  </div>
                  <div className="st-agent-meta">
                    <span className="st-dot" data-on={online ? "1" : "0"} />
                    {online ? "En línea" : "Sin sesión"}
                    <span>·</span>
                    {d.cli_found ? "CLI detectada" : d.config_dir_found ? "Config detectada (CLI fuera del PATH)" : "No instalado"}
                  </div>
                </div>
                <Switch
                  on={inTeam}
                  label={`Incluir ${d.label} en el equipo`}
                  onChange={(on) =>
                    updateSettings({
                      skipAgents: on ? settings.skipAgents.filter((x) => x !== d.id) : [...settings.skipAgents, d.id],
                    })
                  }
                />
              </div>

              {!inTeam && (
                <div className="st-note">Fuera del equipo: no se abre al iniciar y el despacho no le pide tareas.</div>
              )}
              {!d.mcp_exe_ok && (
                <div className="st-note" data-tone="warn">
                  Falta el puente lienzo-mcp.exe: no podrá unirse al equipo hasta compilarlo.
                </div>
              )}

              {found && (
                <div className="st-agent-opts">
                  <label className="cc-field">
                    <span className="cc-field-l">Modelo</span>
                    <span className="cc-select">
                      <select
                        value={pref.model ?? ""}
                        disabled={cat === null || cat === undefined}
                        onChange={(e) => {
                          const model = e.target.value || null;
                          const m = cat?.models.find((x) => x.id === model);
                          const keep =
                            pref.effort && (!m || m.efforts.length === 0 || m.efforts.includes(pref.effort))
                              ? pref.effort
                              : null;
                          onPref(d.id, { model, effort: keep });
                        }}
                      >
                        <option value="">
                          {cat === null ? "Cargando…" : cat?.current.model ? `Predeterminado · ${cat.current.model}` : "Predeterminado"}
                        </option>
                        {cat?.models.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                      <Icon name="chev" size={13} />
                    </span>
                  </label>
                  {efforts.length > 0 && (
                    <label className="cc-field">
                      <span className="cc-field-l">Esfuerzo</span>
                      <span className="cc-select">
                        <select value={pref.effort ?? ""} onChange={(e) => onPref(d.id, { effort: e.target.value || null })}>
                          <option value="">Predeterminado</option>
                          {efforts.map((ef) => (
                            <option key={ef} value={ef}>
                              {EFFORT_LABEL[ef] ?? ef}
                            </option>
                          ))}
                        </select>
                        <Icon name="chev" size={13} />
                      </span>
                    </label>
                  )}
                </div>
              )}
              {found && <StrengthField agent={d.id} label={d.label} saved={state?.strengths?.[d.id] ?? ""} />}

              <div className="st-agent-act">
                {!online && found && (
                  <button className="cc-btn sec" disabled={opening === d.id || !hasProject} onClick={() => onOpenAgent(d.id)}>
                    <Icon name="term" size={14} />
                    {opening === d.id ? "Abriendo…" : "Abrir"}
                  </button>
                )}
                <button
                  className="cc-btn sec"
                  disabled={connecting === d.id || !hasProject}
                  title={
                    hasProject
                      ? "Escribe de nuevo su configuración MCP, los hooks y las normas en la carpeta del proyecto"
                      : "Primero elige la carpeta del proyecto en General"
                  }
                  onClick={async () => {
                    setConnecting(d.id);
                    try {
                      await onConnect(d.id);
                    } finally {
                      setConnecting(null);
                    }
                  }}
                >
                  <Icon name={d.connected ? "refresh" : "plug"} size={14} />
                  {connecting === d.id ? "Conectando…" : d.connected ? "Reconectar" : "Conectar"}
                </button>
                {d.connected && <span className="st-pill" data-tone="ok">configurado</span>}
                {sess.length > 0 && (
                  <span className="st-agent-sess" title={sess.map((a) => `pid ${a.pid}`).join(", ")}>
                    {online ? `visto hace ${ago(Math.max(...sess.map((a) => a.last_seen_ms)))}` : ""}
                  </span>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}

// ---- Equipo --------------------------------------------------------------------------

function Messages({ state }: Pick<Props, "state" | "say">) {
  const { team } = useSettings();
  const inbox = Object.entries(state?.inbox ?? {});
  return (
    <Group
      title="Mensajes entre agentes"
      desc="Lo que un agente le escribe a otro llega a su buzón. Se lo entrego al usar cualquier herramienta del equipo, al acabar su turno (Claude) o, si está libre, escribiéndole en su terminal."
    >
      <Row
        label="Avisar en su terminal si está libre"
        hint="Le escribo una línea para que lea su buzón. Si lo apagas, lo leerá en cuanto use una herramienta del equipo."
      >
        <Switch
          on={team.relayInbox}
          onChange={(relayInbox) => updateSettings({ team: { relayInbox } })}
          label="Avisar en su terminal si está libre"
        />
      </Row>
      {inbox.length === 0 ? (
        <div className="st-empty-row">Ningún agente tiene mensajes sin leer.</div>
      ) : (
        inbox.map(([agent, info]) => (
          <Row
            key={agent}
            label={agentLabel(agent)}
            hint={`De ${info.from.map(agentLabel).join(", ")}`}
          >
            <span className="st-pill" data-tone="warn">
              {info.unread} sin leer
            </span>
          </Row>
        ))
      )}
    </Group>
  );
}

/** Modo director: el líder reparte encargos a los demás, revisa y manda corregir. */
function Director({ state, say }: Pick<Props, "state" | "say">) {
  const on = !!state?.director;
  const limit = state?.fix_limit ?? 2;
  const leader = state?.leader ?? "";
  const { team } = useSettings();
  const set = (enabled: boolean, fixLimit?: number) =>
    teamDirector(enabled, fixLimit).catch((e) => say(errMsg(e), true));
  return (
    <Group
      title="Modo director"
      desc="El líder divide el trabajo en encargos detallados para los demás agentes, revisa cada entrega y manda corregir. Lo difícil lo hace él."
      aside={on ? <span className="st-pill" data-tone="ok">Activo</span> : undefined}
    >
      <Row
        label="Dirige el líder"
        hint={
          !leader
            ? "Elige antes un líder: es quien reparte y revisa."
            : on
              ? `${agentLabel(leader)} revisa las entregas antes de cerrarlas. Si se desconecta, le esperan hasta que vuelva (o las apruebas tú).`
              : "Las tareas se cierran en cuanto su agente las entrega."
        }
      >
        <Switch label="Modo director" on={on} disabled={!leader} onChange={(v) => void set(v)} />
      </Row>
      <Row label="Rondas de corrección" hint="Si tras estas rondas sigue mal, el líder la termina él en vez de insistir.">
        <Seg
          label="Rondas de corrección"
          value={limit}
          disabled={!on}
          options={[1, 2, 3].map((v) => ({ v, l: String(v) }))}
          onChange={(v) => void set(true, v)}
        />
      </Row>
      <Row
        label="Contexto limpio entre misiones"
        hint="Al cerrarse todas las tareas, si Claude dirige y su conversación pesa más de 30k tokens, Prometeo la limpia (/clear) cuando está libre. Lo hecho queda en el tablero y la memoria; cada revisión cuesta mucho menos."
      >
        <Switch
          label="Contexto limpio entre misiones"
          on={team.leaderClean}
          disabled={!on}
          onChange={(leaderClean) => updateSettings({ team: { leaderClean } })}
        />
      </Row>
    </Group>
  );
}

/** Carpetas aisladas: cada tarea trabaja en su copia del proyecto y se une al entregarla. */
function Isolate({ state, say }: Pick<Props, "state" | "say">) {
  const on = !!state?.isolate;
  const busy = (state?.tasks ?? []).filter((t) => !!t.workspace).length;
  return (
    <Group
      title="Carpetas aisladas"
      desc="Cada tarea que se toma trabaja en su propia copia del proyecto (en .lienzo/tareas), así dos agentes pueden tocar el mismo archivo a la vez sin pisarse. Al entregar, Prometeo une los cambios al proyecto; si chocan con algo que cambió mientras tanto, lo deja marcado en la copia para que el agente lo resuelva."
      aside={on ? <span className="st-pill" data-tone="ok">Activo</span> : undefined}
    >
      <Row
        label="Una copia por tarea"
        hint={
          on
            ? `En modo director, los cambios se unen al aprobar la entrega. node_modules y .venv se comparten con el proyecto (no se copian).${busy ? ` Ahora hay ${busy} tarea${busy === 1 ? "" : "s"} con copia.` : ""}`
            : "Las tareas trabajan directamente en el proyecto y se coordinan reservando archivos."
        }
      >
        <Switch label="Carpetas aisladas" on={on} onChange={(v) => void teamIsolate(v).catch((e) => say(errMsg(e), true))} />
      </Row>
    </Group>
  );
}

function Team({ state, detect, say, onTeamRules }: Props) {
  const saved = state?.charter ?? "";
  const leader = state?.leader ?? "";
  const [draft, setDraft] = useState(saved);
  const [busy, setBusy] = useState(false);
  // Solo se recarga el borrador si no lo has tocado.
  const [base, setBase] = useState(saved);
  useEffect(() => {
    if (draft === base) setDraft(saved);
    setBase(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);
  const dirty = draft.trim() !== saved.trim();

  const options = useMemo(() => {
    const seen = new Map<string, string>();
    for (const a of detect?.agents ?? []) seen.set(a.id, a.label);
    for (const a of state?.agents ?? []) if (!seen.has(a.name)) seen.set(a.name, agentLabel(a.name));
    if (leader && !seen.has(leader)) seen.set(leader, agentLabel(leader));
    return [...seen.entries()].map(([v, l]) => ({ v, l }));
  }, [detect, state, leader]);

  const save = async (charter: string, lead: string) => {
    setBusy(true);
    try {
      await onTeamRules(charter.trim() ? charter : null, lead || null);
      return true;
    } catch (e) {
      say(errMsg(e), true);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Group title="Líder" desc="Coordina al equipo: reparte el trabajo de las misiones y revisa lo que entregan los demás.">
        <Row label="Quién lidera" hint={leader ? `Ahora: ${agentLabel(leader)}` : "Sin líder: cada agente trabaja por su cuenta."}>
          <Pick
            label="Líder del equipo"
            value={leader}
            disabled={busy}
            onChange={(v) => {
              void save(saved, v).then((ok) => ok && say(v ? `✓ ${agentLabel(v)} es el líder.` : "✓ El equipo queda sin líder."));
            }}
            options={[{ v: "", l: "Sin líder" }, ...options]}
          />
        </Row>
      </Group>

      <Director {...{ state, say }} />
      <Isolate {...{ state, say }} />

      <Messages {...{ state, say }} />

      <Group
        title="Normas del equipo"
        desc="Instrucciones que reciben todos los agentes al unirse: cómo trabajar juntos, qué comprobar, qué evitar."
        aside={dirty ? <span className="st-pill" data-tone="warn">Sin guardar</span> : saved ? <span className="st-pill" data-tone="ok">Guardadas</span> : undefined}
      >
        <div className="st-pad">
          <textarea
            className="st-input st-textarea"
            value={draft}
            rows={9}
            placeholder="Ej.: Trabajad en ramas pequeñas. Antes de cerrar una tarea, ejecutad las pruebas…"
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="st-snips">
            <span className="st-row-h">Añadir</span>
            {CHARTER_SNIPPETS.map((s) => {
              const has = draft.includes(s.text);
              return (
                <button
                  key={s.label}
                  className="st-chip"
                  disabled={has}
                  title={has ? "Ya está en las normas" : s.text}
                  onClick={() => setDraft((d) => (d.trim() ? `${d.trimEnd()}\n- ${s.text}` : `- ${s.text}`))}
                >
                  {has ? <Icon name="check" size={12} /> : <Icon name="plus" size={12} />}
                  {s.label}
                </button>
              );
            })}
          </div>
          <div className="st-actions">
            <span className="st-row-h">{draft.trim().length} caracteres</span>
            <span className="cc-c-grow" />
            <button className="cc-btn sec" disabled={!dirty || busy} onClick={() => setDraft(saved)}>
              Descartar
            </button>
            <button
              className="cc-btn"
              disabled={!dirty || busy}
              onClick={() => void save(draft, leader).then((ok) => ok && say("✓ Normas del equipo guardadas."))}
            >
              {busy ? "Guardando…" : "Guardar normas"}
            </button>
          </div>
          <div className="st-note">
            Los agentes que ya están en marcha las reciben la próxima vez que lean el contexto del equipo; para que las
            relean en su configuración, usa Reconectar en Agentes.
          </div>
        </div>
      </Group>
    </>
  );
}

// ---- Consumo -------------------------------------------------------------------------

const STATUS_LABEL: Record<string, string> = { open: "por hacer", claimed: "en curso", review: "en revisión", done: "hecha" };

/** Cuánto costó cada tarea y a quién: así se ve si delegar compensa. */
function TaskCosts({ state }: Pick<Props, "state">) {
  const rows = (state?.tasks ?? [])
    .filter((t) => t.cost && Object.keys(t.cost).length > 0)
    .sort((a, b) => b.id - a.id)
    .slice(0, 12)
    .map((t) => {
      const per = Object.keys(t.cost ?? {}).map((n) => ({ name: n, u: usageOf(t.cost ?? {}, n)! }));
      return { t, per, all: sumUsage(per.map((p) => p.u)) };
    });
  return (
    <Group
      title="Por tarea"
      desc="Lo que gastó cada agente mientras hacía o revisaba la tarea. Cada modelo cuesta distinto: los tokens de un modelo gratuito o local no gastan tu plan."
    >
      {rows.length === 0 ? (
        <div className="st-empty-row">Aún no hay tareas con gasto: se apunta desde que un agente reclama, entrega o revisa una.</div>
      ) : (
        <div className="st-table-wrap">
          <table className="st-table">
            <thead>
              <tr>
                <th>Tarea</th>
                <th>Quién</th>
                <th>Total</th>
                <th title="Rondas de corrección en modo director">Rondas</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ t, per, all }) => (
                <tr key={t.id}>
                  <td title={t.title}>
                    #{t.id} {t.title.length > 34 ? `${t.title.slice(0, 33)}…` : t.title}
                    <small> · {STATUS_LABEL[t.status] ?? t.status}</small>
                  </td>
                  <td>
                    {per.map(({ name, u }) => (
                      <span key={name} className="st-tag" style={{ "--ac": agentColor(name) } as CSSProperties}>
                        {agentLabel(name)} {fmtTokens(totalTokens(u))}
                      </span>
                    ))}
                  </td>
                  <td>
                    {fmtTokens(totalTokens(all))}
                    <small> · {all.turns} resp.</small>
                  </td>
                  <td>{t.fix_rounds ? t.fix_rounds : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Group>
  );
}

function Usage({ state, detect, say, onConnect }: Props) {
  const [confirm, setConfirm] = useState(false);
  const map = state?.usage ?? {};
  const names = Object.keys(map).sort();
  const rows = names.map((n) => ({ name: n, u: usageOf(map, n)! }));
  const all = sumUsage(rows.map((r) => r.u));
  const pct = cachePct(all);
  const since = state?.usage_since ? new Date(state.usage_since) : null;
  const sinceLabel = since
    ? since.toLocaleDateString("es", { day: "numeric", month: "short" }) +
      " " +
      since.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })
    : "—";
  const skillsMissing = (detect?.agents ?? []).some((a) => a.connected) ? null : "Conecta un agente para instalarlas.";

  return (
    <>
      <div className="st-stats">
        <div className="st-stat">
          <span>Tokens procesados</span>
          <b>{fmtTokens(totalTokens(all))}</b>
          <small>{all.turns} respuestas</small>
        </div>
        <div className="st-stat" data-tone={pct === null ? undefined : pct >= 70 ? "ok" : pct < 40 ? "warn" : undefined}>
          <span>Entrada desde caché</span>
          <b>{pct === null ? "—" : `${pct} %`}</b>
          <small>{fmtTokens(all.cache_read)} a precio reducido</small>
        </div>
        <div className="st-stat" data-tone={all.saved_ctx > 0 ? "ok" : undefined}>
          <span>Ahorro de Prometeo</span>
          <b>~{fmtTokens(all.saved_ctx)}</b>
          <small>contexto del equipo no repetido</small>
        </div>
        <div className="st-stat">
          <span>Contexto liberado</span>
          <b>{fmtTokens(all.freed)}</b>
          <small>
            {all.compactions === 1 ? "1 vez" : `${all.compactions} veces`}, al compactar o empezar de nuevo
          </small>
        </div>
      </div>

      <Group
        title="Por agente"
        desc={`Desde ${sinceLabel}. Claude y OpenCode informan de lo que gastan; Antigravity no.`}
        aside={
          <button
            className="st-link"
            disabled={names.length === 0}
            onClick={() => {
              if (!confirm) {
                setConfirm(true);
                window.setTimeout(() => setConfirm(false), 4000);
                return;
              }
              setConfirm(false);
              teamUsageReset().then(
                () => say("✓ El consumo empieza a contar desde cero."),
                (e) => say(errMsg(e), true),
              );
            }}
          >
            {confirm ? "Pulsa otra vez para borrar" : "Empezar de cero"}
          </button>
        }
      >
        {rows.length === 0 ? (
          <div className="st-empty-row">Aún no hay datos: aparecen cuando los agentes terminan su primera respuesta.</div>
        ) : (
          <div className="st-table-wrap">
            <table className="st-table">
              <thead>
                <tr>
                  <th>Agente</th>
                  <th>Entrada</th>
                  <th>Salida</th>
                  <th>Caché</th>
                  <th title="Contexto del equipo que Prometeo no repitió (estimado)">Ahorro</th>
                  <th title="Contexto liberado al compactar o empezar una conversación nueva">Liberado</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ name, u }) => {
                  const p = cachePct(u);
                  return (
                    <tr key={name}>
                      <td>
                        <span className="st-tag" style={{ "--ac": agentColor(name) } as CSSProperties}>
                          {agentLabel(name)}
                        </span>
                      </td>
                      <td>{fmtTokens(u.input + u.cache_write)}</td>
                      <td>{fmtTokens(u.output)}</td>
                      <td>
                        {fmtTokens(u.cache_read)}
                        {p !== null && <small> · {p} %</small>}
                      </td>
                      <td>~{fmtTokens(u.saved_ctx)}</td>
                      <td>{u.freed > 0 ? `${fmtTokens(u.freed)} (${u.compactions})` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Group>

      <TaskCosts state={state} />

      <Group title="Qué hace Prometeo para que duren más">
        <Row
          label="Contexto del equipo sin repetir"
          hint="En cada mensaje solo inyecto lo que cambió desde el anterior (tareas, reservas, actividad), no el resumen entero."
        >
          <span className="st-pill" data-tone="ok">activo</span>
        </Row>
        <Row
          label="Instrucciones cortas"
          hint="CLAUDE.md y AGENTS.md llevan solo lo imprescindible; el detalle está en skills que los agentes leen cuando les hace falta."
        >
          <span className="st-pill" data-tone="ok">activo</span>
        </Row>
        <Row
          label="Skills del equipo"
          hint={
            <>
              Las de Prometeo (equipo, ahorro, relevo, revisión) y caveman, de la comunidad, para respuestas breves cuando
              se piden. Van en <code>.claude/skills</code> y{" "}
              <code>.agents/skills</code> del proyecto. {skillsMissing ?? "Se instalan o actualizan al conectar."}
            </>
          }
        >
          <button
            className="cc-btn sec"
            disabled={!state?.project}
            onClick={() => {
              const ids = (detect?.agents ?? []).filter((a) => a.cli_found || a.connected).map((a) => a.id);
              void Promise.all(ids.map((id) => onConnect(id)));
            }}
          >
            <Icon name="refresh" size={14} />
            Instalar ahora
          </button>
        </Row>
        <Row
          label="Relevo antes de llenarse"
          hint="Hacia el 70 % de contexto, el panel Equipo recomienda un relevo: el agente guarda su memoria en la tarea y se compacta."
        />
      </Group>
    </>
  );
}

// ---- Despacho ------------------------------------------------------------------------

const secs = (list: number[]) => list.map((v) => ({ v, l: v < 60 || v % 60 ? `${v} s` : `${v / 60} min` }));
const nums = (list: number[], unit: string) => list.map((v) => ({ v, l: `${v} ${unit}` }));

function Dispatch({ dispatchOn, dispatchState, onDispatch, onDispatchClear }: Props) {
  const { dispatch: d } = useSettings();
  const set = (p: Partial<typeof d>) => updateSettings({ dispatch: p });
  const isDefault = JSON.stringify(d) === JSON.stringify(DEFAULT_SETTINGS.dispatch);
  const now = Date.now();
  const pending = Object.entries(dispatchState.pending);
  const parked = Object.entries(dispatchState.taskFails).filter(([, n]) => n >= d.failureLimit);
  const paused = Object.entries(dispatchState.agentPausedUntil).filter(([, until]) => until > now);
  const off = !dispatchOn;

  return (
    <>
      <Group title="Despacho automático" desc="Cuando una tarea del chat abierto queda lista y hay un agente libre, Prometeo le pide que la tome.">
        <Row label="Repartir tareas solo" hint="Se puede cambiar también desde el panel del chat (Auto).">
          <Switch on={dispatchOn} onChange={onDispatch} label="Despacho automático" />
        </Row>
        <div className="st-status">
          <span>
            <b>{pending.length}</b> {pending.length === 1 ? "aviso esperando" : "avisos esperando"}
          </span>
          <span>
            <b>{parked.length}</b> {parked.length === 1 ? "tarea parada" : "tareas paradas"}
          </span>
          <span>
            <b>{paused.length}</b> {paused.length === 1 ? "agente en pausa" : "agentes en pausa"}
            {paused.length > 0 && ` (${paused.map(([a, until]) => `${agentLabel(a)} ${Math.ceil((until - now) / 60_000)} min`).join(", ")})`}
          </span>
          <span className="cc-c-grow" />
          <button className="st-link" disabled={parked.length + paused.length === 0} onClick={onDispatchClear}>
            <Icon name="refresh" size={13} />
            Borrar fallos y pausas
          </button>
        </div>
      </Group>

      <Group
        title="Reglas del reparto"
        aside={
          <ConfirmButton
            className="st-link"
            disabled={isDefault}
            onConfirm={() => resetSettings("dispatch")}
            confirmText="¿Seguro? Pulsa otra vez"
          >
            Valores por defecto
          </ConfirmButton>
        }
      >
        <Row label="El líder recibe tareas" hint="El líder coordina; normalmente solo trabaja si no hay nadie más." disabled={off}>
          <Seg<LeaderMode>
            label="El líder recibe tareas"
            value={d.leader}
            disabled={off}
            onChange={(leader) => set({ leader })}
            options={[
              { v: "last", l: "Si no hay otro" },
              { v: "never", l: "Nunca" },
              { v: "any", l: "Como uno más" },
            ]}
          />
        </Row>
        <Row label="Tiempo para reclamarla" hint="Si el agente no la reclama en este tiempo, se prueba con otro." disabled={off}>
          <Pick label="Tiempo para reclamarla" value={d.claimWaitS} disabled={off} onChange={(claimWaitS) => set({ claimWaitS })} options={secs([45, 60, 90, 120, 180, 300])} />
        </Row>
        <Row label="Agente libre tras" hint="Sin actividad en su terminal durante este tiempo." disabled={off}>
          <Pick label="Agente libre tras" value={d.idleS} disabled={off} onChange={(idleS) => set({ idleS })} options={secs([10, 20, 30, 60, 120])} />
        </Row>
        <Row label="Intentos por tarea" hint="Avisos sin respuesta antes de dejarla parada hasta que la reintentes." disabled={off}>
          <Pick label="Intentos por tarea" value={d.failureLimit} disabled={off} onChange={(failureLimit) => set({ failureLimit })} options={nums([1, 2, 3, 4, 5], "avisos")} />
        </Row>
        <Row label="Pausar a un agente tras" hint="Avisos seguidos que deja sin contestar." disabled={off}>
          <Pick label="Pausar a un agente tras" value={d.agentFailLimit} disabled={off} onChange={(agentFailLimit) => set({ agentFailLimit })} options={nums([2, 3, 4, 5, 6], "avisos")} />
        </Row>
        <Row label="Duración de la pausa" disabled={off}>
          <Pick label="Duración de la pausa" value={d.pauseMin} disabled={off} onChange={(pauseMin) => set({ pauseMin })} options={nums([2, 5, 10, 15, 30], "min")} />
        </Row>
      </Group>

      <Group
        title="Agentes colgados"
        desc="Si un agente con una tarea tomada deja de dar señales, te aviso y su tarjeta del equipo ofrece preguntarle o interrumpirlo. Funciona aunque el despacho automático esté apagado."
      >
        <Row label="Sin señales durante" hint="Ni acciones en el equipo ni trabajo en su terminal. No cuenta si espera tu permiso o tu respuesta.">
          <Pick
            label="Sin señales durante"
            value={d.stallQuietMin}
            onChange={(stallQuietMin) => set({ stallQuietMin })}
            options={[{ v: 0, l: "Nunca" }, ...nums([3, 5, 8, 10, 15, 30], "min")]}
          />
        </Row>
        <Row label="Con la misma herramienta" hint="Una orden que no acaba o que repite una y otra vez, aunque su terminal se mueva.">
          <Pick
            label="Con la misma herramienta"
            value={d.stallToolMin}
            onChange={(stallToolMin) => set({ stallToolMin })}
            options={[{ v: 0, l: "Nunca" }, ...nums([10, 15, 20, 30, 45, 60], "min")]}
          />
        </Row>
      </Group>
    </>
  );
}

// ---- Avisos --------------------------------------------------------------------------

function Notify({ notifyOn, onNotify, say }: Props) {
  const { notify: n } = useSettings();
  const set = (p: Partial<typeof n>) => updateSettings({ notify: p });
  const off = !notifyOn;
  return (
    <>
      <Group
        title="Avisos"
        desc="Si estás mirando Prometeo, salen arriba a la derecha; si estás en otra ventana, en la esquina de la pantalla."
      >
        <Row label="Activar avisos" hint="También con la campana de la barra superior.">
          <Switch on={notifyOn} onChange={onNotify} label="Avisos" />
        </Row>
        <Row
          label="Aspecto fuera de Prometeo"
          hint={
            n.style === "lienzo"
              ? "Con el diseño de Prometeo. No quedan en el centro de notificaciones de Windows."
              : "Los de Windows: sin el diseño de Prometeo, pero quedan en el centro de notificaciones."
          }
          disabled={off}
        >
          <Seg
            label="Aspecto de los avisos"
            value={n.style}
            disabled={off}
            onChange={(style) => set({ style })}
            options={[
              { v: "lienzo", l: "Prometeo" },
              { v: "windows", l: "Windows" },
            ]}
          />
        </Row>
        <Row label="Avisar también en la esquina de la pantalla aunque Prometeo esté delante" hint="Dentro de la app se avisa siempre." disabled={off}>
          <Switch on={n.whenFocused} disabled={off} onChange={(whenFocused) => set({ whenFocused })} label="Avisar aunque Prometeo esté delante" />
        </Row>
        <div className="st-status">
          <span className="st-row-h">Mira cómo se ve un aviso en la esquina de la pantalla.</span>
          <span className="cc-c-grow" />
          <button
            className="st-link"
            onClick={() =>
              void testNotify().then((ok) =>
                say(
                  ok
                    ? "Aviso de prueba enviado."
                    : n.style === "windows"
                      ? "Windows no deja mostrar avisos: revisa Configuración › Notificaciones."
                      : "No pude abrir la ventanita de avisos.",
                  !ok,
                ),
              )
            }
          >
            <Icon name="bell" size={13} />
            Enviar aviso de prueba
          </button>
        </div>
      </Group>

      <Group title="Cuándo avisar">
        <Row label="Un agente pide permiso o respuesta" disabled={off}>
          <Switch on={n.ask} disabled={off} onChange={(ask) => set({ ask })} label="Avisar cuando pide permiso" />
        </Row>
        <Row label="Un agente termina una tarea" disabled={off}>
          <Switch on={n.done} disabled={off} onChange={(done) => set({ done })} label="Avisar cuando termina una tarea" />
        </Row>
        <Row label="Un agente te responde" disabled={off}>
          <Switch on={n.reply} disabled={off} onChange={(reply) => set({ reply })} label="Avisar cuando te responde" />
        </Row>
        <Row label="Un agente no contesta a tu mensaje" hint="Si no está trabajando y pasa este tiempo sin responder." disabled={off}>
          <Pick
            label="Avisar si no contesta"
            value={n.lateMin}
            disabled={off}
            onChange={(lateMin) => set({ lateMin })}
            options={[{ v: 0, l: "Nunca" }, ...nums([2, 3, 5, 10, 15], "min")]}
          />
        </Row>
      </Group>
    </>
  );
}

// ---- Conexión ------------------------------------------------------------------------

/** La versión que corre, si hay otra lista para instalar y los últimos cambios. */
function AboutPanel() {
  const [about, setAbout] = useState<About | null>(null);
  const [upd, setUpd] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const check = () => {
    setChecking(true);
    updateCheck()
      .then(setUpd)
      .catch(() => setUpd(null))
      .finally(() => setChecking(false));
  };
  useEffect(() => {
    appAbout().then(setAbout).catch(() => setAbout(null));
    check();
  }, []);
  return (
    <>
      <Group title="Prometeo" desc="La versión sube sola cada vez que se compila (una por commit).">
        <Row label="Versión">
          <b>{about?.version ?? "…"}</b>
        </Row>
        <Row label="Commit" hint={about?.dirty ? "Compilada con cambios que aún no estaban guardados en git." : undefined}>
          <code>{about?.commit || "—"}</code>
        </Row>
        <Row label="Compilada">{about?.built_ms ? `hace ${ago(about.built_ms)}` : "—"}</Row>
        <Row
          label="Actualización"
          hint={upd?.available ? "Usa el botón «Actualizar» de arriba a la derecha." : upd?.reason || undefined}
        >
          <span className="st-pill" data-tone={upd?.available ? "ok" : undefined}>
            {upd?.available ? `Lista: ${upd.version || "versión nueva"}` : "Al día"}
          </span>
          <button className="hs-btn" onClick={check} disabled={checking}>
            {checking ? "Buscando…" : "Buscar ahora"}
          </button>
        </Row>
      </Group>
      <Group title="Últimos cambios" desc="Lo que trae esta versión, del más nuevo al más viejo.">
        <ul className="st-changes">
          {(about?.changes ?? []).slice(0, 20).map((c) => (
            <li key={c.hash}>
              <span>{c.subject}</span>
              <time>{ago(c.ts_ms)}</time>
            </li>
          ))}
        </ul>
      </Group>
    </>
  );
}

function Hub({ state, detect, hubOk, say }: Props) {
  const [details, setDetails] = useState<TeamDetails | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => {
    teamDetails().then(setDetails).catch(() => setDetails(null));
  }, []);
  const bridgeOk = detect ? detect.agents.every((a) => a.mcp_exe_ok) : null;
  const sessions = state?.agents ?? [];
  const claims = state?.claims ?? [];

  return (
    <>
      <Group title="Hub del equipo" desc="El servidor local por el que los agentes se hablan. Solo escucha en este equipo.">
        <Row label="Estado">
          <span className="st-pill" data-tone={hubOk ? "ok" : "err"}>
            <span className="st-dot" data-on={hubOk ? "1" : "0"} />
            {hubOk ? "Conectado" : "Sin conexión"}
          </span>
        </Row>
        <Row label="Dirección" hint={<code>{details?.url ?? "…"}</code>}>
          {details && <CopyBtn text={details.url} say={say} />}
        </Row>
        <Row
          label="Puente MCP"
          hint={<code>{details?.mcp_exe ?? "sin compilar"}</code>}
        >
          {bridgeOk !== null && (
            <span className="st-pill" data-tone={bridgeOk ? "ok" : "warn"}>
              {bridgeOk ? "listo" : "falta compilar"}
            </span>
          )}
        </Row>
        <Row label="Archivo de estado" hint={<code>{details?.state_file ?? "…"}</code>}>
          {details && (
            <>
              <CopyBtn text={details.state_file} say={say} />
              <button
                className="cc-icon-btn st-mini"
                title="Mostrar en el explorador"
                aria-label="Mostrar en el explorador"
                onClick={() => revealItemInDir(details.state_file).catch((e) => say(errMsg(e), true))}
              >
                <Icon name="folder" size={14} />
              </button>
            </>
          )}
        </Row>
      </Group>

      <Group title={`Sesiones (${sessions.length})`} desc="Cada terminal de agente que se ha unido al hub.">
        {sessions.length === 0 ? (
          <div className="st-empty-row">Ninguna sesión todavía.</div>
        ) : (
          sessions.map((a) => (
            <Row
              key={a.session_id}
              label={agentLabel(a.name)}
              hint={`pid ${a.pid} · visto hace ${ago(a.last_seen_ms)}${a.cli_session ? " · conversación guardada" : ""}`}
            >
              <span className="st-pill" data-tone={a.online ? "ok" : undefined}>
                {a.online ? "en línea" : "desconectada"}
              </span>
            </Row>
          ))
        )}
      </Group>

      <Group title={`Archivos reservados (${claims.length})`} desc="Lo que cada agente ha pedido no tocar mientras lo edita.">
        {claims.length === 0 ? (
          <div className="st-empty-row">Nadie tiene archivos reservados.</div>
        ) : (
          claims.map((c) => (
            <Row key={`${c.agent}:${c.path}`} label={c.path} hint={`${agentLabel(c.agent)} · hace ${ago(c.ts_ms)}`} />
          ))
        )}
      </Group>

      <Group title="Restablecer">
        <Row label="Ajustes de despacho y avisos" hint="Vuelven a sus valores por defecto. No toca el proyecto, las normas ni los agentes.">
          <button
            className={confirmReset ? "cc-btn hot" : "cc-btn sec"}
            onClick={() => {
              if (!confirmReset) {
                setConfirmReset(true);
                window.setTimeout(() => setConfirmReset(false), 4000);
                return;
              }
              resetSettings("dispatch");
              resetSettings("notify");
              setConfirmReset(false);
              say("✓ Despacho y avisos restablecidos.");
            }}
          >
            {confirmReset ? "Pulsa otra vez para confirmar" : "Restablecer"}
          </button>
        </Row>
      </Group>
    </>
  );
}
