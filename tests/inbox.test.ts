import { test } from "node:test";
import assert from "node:assert/strict";
import { recentConversations } from "../shared/inbox.js";

test("The inbox keeps the latest 50 per account, without deleting older saved chats", () => {
  const saved = ["telegram-1", "instagram-2"].flatMap((accountId) =>
    Array.from({ length: 65 }, (_, i) => ({
      accountId,
      id: `${accountId}-${i}`,
      updatedAt: new Date(1700000000000 + i * 1000).toISOString(),
    })),
  );
  const visible = recentConversations(saved);
  assert.equal(visible.length, 100);
  for (const account of ["telegram-1", "instagram-2"]) {
    const ids = visible.filter((c) => c.accountId === account).map((c) => c.id);
    assert.equal(ids.length, 50);
    assert.ok(ids.includes(`${account}-64`));
    assert.ok(ids.includes(`${account}-15`));
    assert.ok(!ids.includes(`${account}-14`));
  }
  assert.equal(saved.length, 130);
  assert.equal(saved[0].id, "telegram-1-0");
});
