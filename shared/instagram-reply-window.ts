import type { Conversation, Message } from "./types.js";

// A conversation's timestamp is available before its first history page.
// Never dereference a history message merely because this window is open.
export function instagramReplyWindow(
  conversation: Pick<Conversation, "id" | "lastIncomingAt"> | undefined,
  messages: Pick<Message, "conversationId" | "direction" | "createdAt">[],
  now: number,
) {
  let incomingAt = conversation?.lastIncomingAt;
  if (!incomingAt && conversation) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (
        message.conversationId === conversation.id &&
        message.direction === "in"
      ) {
        incomingAt = message.createdAt;
        break;
      }
    }
  }
  const timestamp = incomingAt ? Date.parse(incomingAt) : NaN;
  const remaining = timestamp + 86400000 - now;
  if (!Number.isFinite(remaining) || remaining <= 0)
    return { closed: true, remainingMinutes: 0 };
  return {
    closed: false,
    remainingMinutes: Math.max(1, Math.ceil(remaining / 60000)),
  };
}
