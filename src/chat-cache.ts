import type { Message } from "../shared/types";

type Entry = { messages: Message[]; syncedAt: number };
const PREFIX = "jorik-chats-v1:";
const LIMIT = 20;
export class ChatCache {
  private entries = new Map<string, Entry>();
  private serialized = new Map<string, string>();
  constructor(
    private key: string,
    private storage?: Storage,
  ) {
    try {
      const saved = JSON.parse(storage?.getItem(PREFIX + key) || "[]");
      if (Array.isArray(saved))
        for (const [id, entry] of saved.slice(-LIMIT)) {
          if (
            typeof id === "string" &&
            Array.isArray(entry?.messages) &&
            entry.messages.every(
              (m: Message) =>
                m &&
                m.conversationId === id &&
                typeof m.id === "string" &&
                Array.isArray(m.attachments),
            )
          ) {
            this.entries.set(id, {
              messages: entry.messages,
              syncedAt: Number(entry.syncedAt) || 0,
            });
            this.serialized.set(id, JSON.stringify(entry.messages));
          }
        }
    } catch {
      /* A corrupt or unavailable cache must never prevent opening a chat. */
    }
  }
  get(id: string) {
    return this.entries.get(id);
  }
  put(id: string, messages: Message[], syncedAt = this.get(id)?.syncedAt || 0) {
    const previous = this.get(id);
    const serialized = JSON.stringify(messages);
    if (previous && this.serialized.get(id) === serialized) {
      this.entries.delete(id);
      this.entries.set(id, previous);
      if (previous.syncedAt !== syncedAt) {
        previous.syncedAt = syncedAt;
        this.save();
      }
      return previous;
    }
    this.entries.delete(id);
    const entry = { messages, syncedAt };
    this.entries.set(id, entry);
    this.serialized.set(id, serialized);
    while (this.entries.size > LIMIT) this.evictOldest();
    this.save();
    return entry;
  }
  private evictOldest() {
    const id = this.entries.keys().next().value!;
    this.entries.delete(id);
    this.serialized.delete(id);
  }
  private save() {
    try {
      let json = JSON.stringify([...this.entries]);
      while (json.length > 1_000_000 && this.entries.size > 1) {
        this.evictOldest();
        json = JSON.stringify([...this.entries]);
      }
      if (json.length <= 1_000_000)
        this.storage?.setItem(PREFIX + this.key, json);
      else this.storage?.removeItem(PREFIX + this.key);
    } catch {
      /* Keep the in-memory cache when browser storage is full. */
    }
  }
  clear() {
    this.entries.clear();
    this.serialized.clear();
    try {
      this.storage?.removeItem(PREFIX + this.key);
    } catch {}
  }
}
