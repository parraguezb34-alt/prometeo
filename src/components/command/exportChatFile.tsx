import { renderToStaticMarkup } from "react-dom/server";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { agentLabel, teamEventsRange } from "../../lib/team";
import { buildTimeline } from "../../lib/timeline";
import { chatHtml, chatMarkdown, fileSlug } from "../../lib/exportChat";
import { exportSave } from "../../lib/viewer";
import { chatLineage, inChat } from "../../lib/chats";
import type { Chat } from "../../lib/chats";
import { Markdown } from "../Markdown";
import { HIDDEN_KINDS } from "./shared";

/**
 * Exporta un chat entero (también lo que ya salió del feed vivo) a Markdown o a una página HTML,
 * donde se elija en el diálogo. Devuelve el aviso para el usuario, o null si no se guardó.
 */
export async function exportChatFile(chat: Chat, allChats: Chat[], project: string | null): Promise<string | null> {
  const name = chat.kind === "agent" ? (chat.agent ?? "") : "";
  const path = await saveDialog({
    title: "Exportar el chat",
    defaultPath: `${fileSlug(chat.title)}.md`,
    filters: [
      { name: "Markdown", extensions: ["md"] },
      { name: "Página web", extensions: ["html"] },
    ],
  }).catch(() => null);
  if (!path) return null;
  const lineage = chatLineage(chat, allChats);
  const from = Math.min(...lineage.map((c) => c.startMs));
  const all = await teamEventsRange(from, chat.endMs ?? null);
  const evs = all.filter(
    (e) =>
      !HIDDEN_KINDS.has(e.kind) &&
      inChat(lineage, e.ts_ms) &&
      (!name || e.agent === name || e.to === name || (e.kind === "broadcast" && e.agent === "tú")),
  );
  const rows = buildTimeline(evs);
  const info = {
    title: chat.title,
    scope: name ? `Chat privado con ${agentLabel(name)}` : "Chat del equipo",
    project: project ?? "—",
    fromMs: evs[0]?.ts_ms ?? chat.startMs,
    toMs: chat.endMs ?? null,
    nowMs: Date.now(),
    label: agentLabel,
  };
  const text = /\.html?$/i.test(path)
    ? chatHtml(rows, info, (t) => renderToStaticMarkup(<Markdown text={t} />))
    : chatMarkdown(rows, info);
  await exportSave(path, text);
  return `💾 Chat exportado (${evs.length} eventos): ${path}`;
}
