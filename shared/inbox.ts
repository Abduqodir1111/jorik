export const RECENT_CHAT_LIMIT = 50;

export function recentConversations<
  T extends { accountId: string; updatedAt: string },
>(conversations: T[]): T[] {
  const counts = new Map<string, number>();
  return [...conversations]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .filter((conversation) => {
      const count = counts.get(conversation.accountId) ?? 0;
      counts.set(conversation.accountId, count + 1);
      return count < RECENT_CHAT_LIMIT;
    });
}
