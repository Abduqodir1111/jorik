export const MAX_QUICK_REPLIES = 100;
export type QuickReply = { id: string; title: string; text: string };
/** Legacy four-slot arrays receive stable IDs without changing their text/order. */
export function normalizeQuickReplies(
  value: unknown,
): QuickReply[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_QUICK_REPLIES) return;
  const seen = new Set<string>();
  const result: QuickReply[] = [];
  for (const [index, item] of value.entries()) {
    if (
      !item ||
      typeof item.title !== "string" ||
      typeof item.text !== "string"
    )
      return;
    const id = item.id === undefined ? `legacy-${index}` : item.id;
    if (typeof id !== "string" || !id || id.length > 80 || seen.has(id)) return;
    seen.add(id);
    result.push({ id, title: item.title, text: item.text });
  }
  return result;
}
export function quickReplyHotkey(index: number) {
  return index >= 0 && index < 9 ? `Ctrl + ${index + 1}` : undefined;
}
export function nextTemplateIndex(
  current: number,
  direction: number,
  length: number,
) {
  return length ? (((current + direction) % length) + length) % length : 0;
}
