import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { InboxSnapshots } from "../server/inbox-sync.js";
import { InboxSyncClient } from "../src/inbox-sync.js";
import {
  applyInboxSync,
  type InboxState,
  type InboxSync,
} from "../shared/inbox-sync.js";
import { createApp } from "../server/app.js";

function fixture(n = 500): InboxState {
  return {
    mode: "demo",
    localAccess: true,
    quickRepliesVersion: "one",
    settings: { ownerName: "Owner" },
    accounts: [],
    conversations: Array.from({ length: n }, (_, i) => ({
      id: String(i).padStart(5, "0"),
      accountId: "telegram-1",
      externalId: String(i),
      name: "Client " + i,
      username: "client" + i,
      updatedAt: new Date(1795000000000 - i * 1000).toISOString(),
      draft: "",
      draftVersion: 0,
      deletedAt: null,
      preview: "Sample message",
      stage: "",
      unread: 0,
      needsReply: false,
    })),
  };
}
test("Five operators share one query; one changed conversation is a small delta, unchanged clients keep row references", () => {
  let state = fixture(),
    now = 0,
    loads = 0;
  const cache = new InboxSnapshots(
    () => {
      loads++;
      return structuredClone(state);
    },
    () => now,
  );
  const initial = cache.read(undefined, 0);
  assert.equal(initial.kind, "full");
  for (let i = 0; i < 4; i++) cache.read(undefined, 0);
  assert.equal(loads, 1);
  const old = applyInboxSync(undefined, initial)!;
  state.conversations[5].preview = "New message";
  state.conversations[5].unread = 1;
  const update = cache.read(initial.version, 1);
  assert.equal(loads, 2);
  assert.equal(update.kind, "delta");
  if (update.kind !== "delta") throw Error();
  assert.deepEqual(
    update.upsert.map((c) => c.id),
    ["00005"],
  );
  assert.deepEqual(update.removed, []);
  assert.equal(update.metadata, undefined);
  for (let i = 0; i < 4; i++) cache.read(initial.version, 1);
  assert.equal(loads, 2);
  const merged = applyInboxSync(old, update)!;
  assert.deepEqual(merged.state, state);
  assert.equal(merged.state.conversations[0], old.state.conversations[0]);
  assert.ok(
    JSON.stringify(update).length < JSON.stringify(initial).length / 50,
  );
  now = 501;
  cache.read(update.version, 1);
  assert.equal(loads, 3);
  console.log(
    JSON.stringify({
      fullBytes: JSON.stringify(initial).length,
      deltaBytes: JSON.stringify(update).length,
      operators: 5,
      queriesPerUpdate: 1,
    }),
  );
});
test("Deletion, restoration, metadata changes and missed revisions reconcile exactly; cache is bounded", () => {
  let state = fixture(3);
  const cache = new InboxSnapshots(() => structuredClone(state));
  let previous = applyInboxSync(undefined, cache.read(undefined, 0))!;
  const removed = state.conversations.shift()!;
  state.settings.ownerName = "Renamed";
  let delta = cache.read(previous.version, 1);
  previous = applyInboxSync(previous, delta)!;
  assert.deepEqual(previous.state, state);
  state.conversations.unshift(removed);
  delta = cache.read(previous.version, 2);
  previous = applyInboxSync(previous, delta)!;
  assert.deepEqual(previous.state, state);
  state.conversations[0].draft = "New draft";
  state.conversations[0].draftVersion++;
  cache.read(undefined, 3);
  state.conversations[0].stage = "paid";
  cache.read(undefined, 4);
  for (let i = 0; i < 5; i++) {
    state.conversations[0].preview = "Later " + i;
    cache.read(undefined, 10 + i);
  }
  assert.equal(cache.read(previous.version, 14).kind, "full");
  assert.equal(applyInboxSync(undefined, delta), undefined);
  state.settings.large = "x".repeat(4 * 1024 * 1024 + 1);
  const large = cache.read(undefined, 5);
  state.settings.large = "small";
  cache.read(undefined, 6);
  assert.equal(cache.read(large.version, 6).kind, "full");
});
test("Client falls back to full sync on version mismatch and rejects responses from a previous session", async () => {
  const full: InboxSync = { kind: "full", version: "one", state: fixture(1) };
  const delta: InboxSync = {
    kind: "delta",
    baseVersion: "wrong",
    version: "two",
    upsert: [],
    removed: [],
  };
  const urls: string[] = [];
  const replies = [full, delta, { ...full, version: "three" }];
  const client = new InboxSyncClient(async (url) => {
    urls.push(url);
    return replies.shift()!;
  });
  await client.read();
  await client.read();
  assert.deepEqual(urls, [
    "/inbox-sync",
    "/inbox-sync?since=one",
    "/inbox-sync",
  ]);
  let complete!: (value: InboxSync) => void;
  const delayed = new InboxSyncClient(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const pending = delayed.read();
  delayed.reset();
  complete(full);
  await assert.rejects(pending, /Сессия/);
});
test("Authenticated API preserves legacy full state; incoming, drafts, deletion/restore invalidate shared snapshots", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-sync-"));
  const ctx = await createApp({
    dataDir: dir,
    mode: "demo",
    localAccess: true,
    worker: false,
  });
  try {
    const id = ctx.store.incoming("telegram-1", {
      externalConversationId: "client",
      externalMessageId: "one",
      name: "Client",
      username: "client",
      text: "First",
    });
    const fetch = async (since?: string) =>
      (
        await ctx.app.inject({
          url: "/api/inbox-sync" + (since ? "?since=" + since : ""),
        })
      ).json() as InboxSync;
    let state = applyInboxSync(undefined, await fetch())!;
    assert.deepEqual(
      state.state,
      (await ctx.app.inject({ url: "/api/state" })).json(),
    );
    assert.equal(
      (
        await ctx.app.inject({
          method: "PUT",
          url: `/api/conversations/${id}/draft`,
          payload: { text: "Draft", version: 0, key: randomUUID() },
        })
      ).statusCode,
      200,
    );
    state = applyInboxSync(state, await fetch(state.version))!;
    assert.equal(state.state.conversations[0].draft, "Draft");
    const preview = (
      await ctx.app.inject({ url: `/api/conversations/${id}/deletion-preview` })
    ).json();
    assert.equal(
      (
        await ctx.app.inject({
          method: "DELETE",
          url: `/api/conversations/${id}`,
          headers: { "if-match": JSON.stringify(preview.version) },
        })
      ).statusCode,
      200,
    );
    state = applyInboxSync(state, await fetch(state.version))!;
    assert.equal(state.state.conversations.length, 0);
    ctx.store.incoming("telegram-1", {
      externalConversationId: "client",
      externalMessageId: "two",
      name: "Client",
      username: "client",
      text: "New incoming",
    });
    state = applyInboxSync(state, await fetch(state.version))!;
    assert.equal(state.state.conversations[0].id, id);
    assert.equal(
      (await ctx.app.inject({ url: "/api/inbox-sync?since=invalid" }))
        .statusCode,
      400,
    );
  } finally {
    await ctx.app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const secure = await createApp({
    dataDir: dir,
    mode: "demo",
    localAccess: false,
    worker: false,
  });
  try {
    assert.equal(
      (await secure.app.inject({ url: "/api/inbox-sync" })).statusCode,
      401,
    );
  } finally {
    await secure.app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
