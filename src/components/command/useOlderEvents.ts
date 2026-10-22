// El feed vivo guarda los últimos 500 eventos. Lo anterior del chat abierto se lee del archivo del
// feed al abrirlo, y lo que se va cayendo del feed mientras está abierto se guarda aquí.
import { useEffect, useRef, useState } from "react";
import { teamEventsRange } from "../../lib/team";
import type { TeamEvent } from "../../lib/team";
import { droppedEvents } from "../../lib/chatsDisk";
import type { Chat } from "../../lib/chats";

export function useOlderEvents(
  project: string | null,
  chatId: string | null,
  lineage: Chat[],
  liveEvents: TeamEvent[] | undefined,
): TeamEvent[] {
  const [older, setOlder] = useState<TeamEvent[]>([]);
  const olderKey = useRef("");
  const prevLive = useRef<TeamEvent[]>([]);
  const chatFrom = lineage.length ? Math.min(...lineage.map((c) => c.startMs)) : 0;
  useEffect(() => {
    if (!liveEvents) return;
    const key = `${project ?? ""}|${chatId ?? ""}`;
    if (olderKey.current !== key) {
      olderKey.current = key;
      prevLive.current = liveEvents;
      setOlder([]);
      const oldest = liveEvents[liveEvents.length - 1]?.ts_ms ?? 0;
      if (chatId && liveEvents.length > 0 && chatFrom < oldest) {
        teamEventsRange(chatFrom, oldest)
          .then((list) => {
            if (olderKey.current === key) setOlder((cur) => [...list, ...cur]);
          })
          .catch(() => {});
      }
      return;
    }
    const gone = droppedEvents(prevLive.current, liveEvents, chatFrom);
    prevLive.current = liveEvents;
    if (gone.length) setOlder((cur) => [...cur, ...gone]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveEvents, chatId, project]);
  return older;
}
