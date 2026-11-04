import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatCache } from "../src/chat-cache.js";
import type { Message } from "../shared/types.js";
const message = (id: string) =>
  ({
    id: "m-" + id,
    conversationId: id,
    attachments: [],
    text: "saved",
  }) as unknown as Message;
function storage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  } as Storage;
}
test("Chat cache restores history after reload, isolates modes and clears on logout", () => {
  const disk = storage(),
    cache = new ChatCache("real", disk);
  cache.put("a", [message("a")], 123);
  assert.equal(new ChatCache("real", disk).get("a")?.syncedAt, 123);
  assert.deepEqual(new ChatCache("real", disk).get("a")?.messages, [
    message("a"),
  ]);
  assert.equal(new ChatCache("demo", disk).get("a"), undefined);
  cache.put("a", [], undefined);
  assert.equal(cache.get("a")?.syncedAt, 123);
  cache.clear();
  assert.equal(new ChatCache("real", disk).get("a"), undefined);
});
test("Chat cache is bounded and tolerates unavailable or corrupted storage", () => {
  const disk = storage(),
    cache = new ChatCache("real", disk);
  for (let i = 0; i < 25; i++) cache.put(String(i), [message(String(i))]);
  const restored = new ChatCache("real", disk);
  assert.equal(restored.get("0"), undefined);
  assert.equal(restored.get("24")?.messages[0].text, "saved");
  disk.setItem("jorik-chats-v1:real", "{bad");
  assert.equal(new ChatCache("real", disk).get("24"), undefined);
  const blocked = new ChatCache("real", {
    getItem() {
      throw Error();
    },
    setItem() {
      throw Error();
    },
  } as unknown as Storage);
  blocked.put("a", [message("a")]);
  assert.ok(blocked.get("a"));
});

test("Unchanged history reuses render references and avoids rewriting all cached chats", () => {
  const disk = storage();
  let writes = 0;
  const setItem = disk.setItem.bind(disk);
  disk.setItem = (key, value) => {
    writes++;
    setItem(key, value);
  };
  const cache = new ChatCache("real", disk);
  const first = cache.put("a", [message("a")], 123);
  const same = cache.put("a", [message("a")], 123);
  assert.equal(same.messages, first.messages);
  assert.equal(writes, 1);
  const changed = cache.put(
    "a",
    [{ ...message("a"), readAt: "2026-11-02T12:00:00Z" }],
    123,
  );
  assert.notEqual(changed.messages, first.messages);
  assert.equal(changed.messages[0].readAt, "2026-11-02T12:00:00Z");
  assert.equal(writes, 2);
});
