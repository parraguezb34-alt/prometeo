import { agentColor, ago, shortPath } from "../lib/team";
import type { TeamEvent } from "../lib/team";

export const GLYPHS: Record<string, string> = {
  join: "⊕",
  leave: "⊖",
  message: "✉",
  prompt: "❯",
  update: "●",
  tool: "↳",
  task: "☰",
  claim: "⊙",
  stop: "■",
  session: "▶",
  broadcast: "📣",
  release: "↺",
};

/** Activity feed shared by the team panel and the command center. Newest first. */
export function FeedList({ events, empty }: { events: TeamEvent[]; empty: string }) {
  if (events.length === 0) return <div className="team-empty">{empty}</div>;
  return (
    <>
      {events.map((e) => (
        <div className="feed-item" key={e.seq}>
          <span className="feed-glyph">{GLYPHS[e.kind] ?? "•"}</span>
          <span className="feed-main">
            <span className="feed-agent" style={{ color: agentColor(e.agent) }}>
              {e.agent}
              {e.to ? ` → ${e.to}` : ""}
            </span>
            <span className="feed-text" data-weak={e.kind === "tool" ? "1" : "0"}>
              {" "}
              {e.text}
            </span>
            {e.files.length > 0 && (
              <span className="feed-files"> · {e.files.map(shortPath).join(", ")}</span>
            )}
          </span>
          <span className="feed-time">{ago(e.ts_ms)}</span>
        </div>
      ))}
    </>
  );
}
