import type { StoredMessage } from "./protocol.ts";
export interface MessagePage { messages: StoredMessage[]; hasMore: boolean; serverNow: number; expiresAt: number }
export async function drainMessages(
  cursor: number,
  fetchPage: (cursor: number) => Promise<MessagePage>,
  applyPage: (page: MessagePage) => Promise<void>,
  active: () => boolean,
): Promise<number> {
  let after = cursor;
  while (active()) {
    const page = await fetchPage(after);
    if (!active()) break;
    if (page.messages.some((m, i) => m.sequence <= (i === 0 ? after : page.messages[i - 1].sequence))) throw new Error("INVALID_SEQUENCE");
    await applyPage(page);
    if (!active()) break;
    after = page.messages.at(-1)?.sequence ?? after;
    if (!page.hasMore || page.messages.length === 0) break;
  }
  return after;
}
