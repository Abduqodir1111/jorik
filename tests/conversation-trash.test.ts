import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/app.js";
import { openDb } from "../server/db.js";
import { Store } from "../server/store.js";
import { InstagramIntegration } from "../server/instagram.js";
import { TelegramIntegration } from "../server/telegram.js";
import { Api } from "teleproto";
import bigInt from "big-integer";

const event = (message: string) => ({
  externalConversationId: "client",
  externalMessageId: message,
  name: "Client",
  username: "client",
  text: message,
});
test("Real adapters keep old history, outgoing echoes and duplicates hidden; new incoming restores", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-trash-adapters-"));
  const db = openDb(dir, "real"),
    store = new Store(db);
  const ig = new InstagramIntegration(store, {
    accountId: "instagram-1",
    token: "test",
    receiveMode: "webhook",
    fetcher: (async () =>
      Response.json({
        id: "page",
        instagram_business_account: { id: "business", username: "shop" },
        data: [],
      })) as typeof fetch,
  });
  const tg = new TelegramIntegration(store, {
    apiId: 123,
    apiHash: "a".repeat(32),
    encryptionKey: "b".repeat(64),
  });
  try {
    await ig.sync();
    const hook = (mid: string, timestamp: number, out = false) => ({
      id: "business",
      messaging: [
        {
          sender: { id: out ? "business" : "customer" },
          recipient: { id: out ? "customer" : "business" },
          timestamp,
          message: { mid, text: mid, is_echo: out },
        },
      ],
    });
    ig.receiveWebhook(hook("first", Date.now() - 20000));
    const id = store.conversations()[0].id;
    db.prepare("UPDATE conversations SET deleted_at=? WHERE id=?").run(
      new Date().toISOString(),
      id,
    );
    ig.receiveWebhook(hook("first", Date.now() - 20000));
    ig.receiveWebhook(hook("old", Date.now() - 10000));
    ig.receiveWebhook(hook("out", Date.now() + 1000, true));
    assert.ok(store.conversation(id).deletedAt);
    ig.receiveWebhook(hook("new", Date.now() + 1000));
    assert.equal(store.conversation(id).deletedAt, null);
    db.prepare("INSERT INTO telegram_peers VALUES(?,?,?,?,?)").run(
      "telegram-1",
      "123",
      "456",
      "Client",
      "client",
    );
    const ingest = (
      tg as unknown as {
        importMessage(
          m: Api.TypeMessage,
          unread: boolean,
          edited?: boolean,
        ): Promise<void>;
      }
    ).importMessage.bind(tg);
    const msg = (id: number, date: number, out = false) =>
      new Api.Message({
        id,
        peerId: new Api.PeerUser({ userId: bigInt(123) }),
        date,
        message: "hello",
        out,
      });
    const now = Math.floor(Date.now() / 1000);
    await ingest(msg(1, now - 20), false);
    const tid = store
      .conversations()
      .find((c) => c.accountId === "telegram-1")!.id;
    db.prepare("UPDATE conversations SET deleted_at=? WHERE id=?").run(
      new Date().toISOString(),
      tid,
    );
    await ingest(msg(1, now - 20), true);
    await ingest(msg(2, now - 10), false);
    await ingest(msg(3, now + 1, true), true);
    assert.ok(store.conversation(tid).deletedAt);
    await ingest(msg(4, now + 1), true);
    assert.equal(store.conversation(tid).deletedAt, null);
  } finally {
    await ig.close();
    await tg.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("Conversation trash preserves history, drafts, orders, account isolation and survives restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-trash-"));
  let ctx = await createApp({
    dataDir: dir,
    mode: "demo",
    localAccess: true,
    worker: false,
  });
  try {
    const id = ctx.store.incoming("telegram-1", event("first"));
    const other = ctx.store.incoming("telegram-2", event("first"));
    ctx.db
      .prepare("UPDATE conversations SET draft=?,draft_version=1 WHERE id=?")
      .run("saved draft", id);
    const order = await ctx.app.inject({
      method: "POST",
      url: "/api/orders",
      payload: {
        conversationId: id,
        client: "Client",
        source: "Telegram 1",
        date: "2026-11-24",
        phone: "+998901234567",
        deliveryType: "pickup",
        district: "",
        address: "",
        coordinates: "",
        amount: 100000,
        isPaid: false,
        items: "Book",
      },
    });
    assert.equal(order.statusCode, 201, order.body);
    const before = ctx.store.messages(id);
    const preview = (
      await ctx.app.inject({ url: `/api/conversations/${id}/deletion-preview` })
    ).json();
    assert.equal(preview.hasDraft, true);
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
    assert.equal(
      ctx.store.conversations().some((c) => c.id === id),
      false,
    );
    assert.equal(
      ctx.store.conversations().some((c) => c.id === other),
      true,
    );
    assert.deepEqual(ctx.store.messages(id), before);
    assert.equal(ctx.store.conversation(id).draft, "saved draft");
    assert.equal(
      (await ctx.app.inject({ url: `/api/conversations/${id}` })).json().id,
      id,
    );
    assert.equal(
      (await ctx.app.inject({ url: "/api/orders" })).json().length,
      1,
    );
    assert.throws(
      () => ctx.store.enqueue(id, "no", randomUUID()),
      /восстановите/,
    );
    assert.equal(
      (
        await ctx.app.inject({
          method: "PUT",
          url: `/api/conversations/${id}/draft`,
          payload: { text: "overwrite", version: 1, key: randomUUID() },
        })
      ).statusCode,
      409,
    );
    ctx.store.incoming("telegram-1", event("first"));
    assert.ok(
      ctx.store.conversation(id).deletedAt,
      "duplicate must not restore",
    );
    await ctx.app.close();
    ctx = await createApp({
      dataDir: dir,
      mode: "demo",
      localAccess: true,
      worker: false,
    });
    assert.ok(ctx.store.conversation(id).deletedAt);
    const trash = (
      await ctx.app.inject({ url: "/api/conversations/deleted" })
    ).json();
    assert.deepEqual(
      trash.conversations.map((c: any) => c.id),
      [id],
    );
    assert.equal("draft" in trash.conversations[0], false);
    assert.equal(
      (
        await ctx.app.inject({
          method: "POST",
          url: `/api/conversations/${id}/restore`,
        })
      ).statusCode,
      200,
    );
    assert.equal(ctx.store.conversation(id).deletedAt, null);
    assert.deepEqual(ctx.store.messages(id), before);
    assert.equal(ctx.store.conversation(id).draft, "saved draft");
    const fresh = (
      await ctx.app.inject({ url: `/api/conversations/${id}/deletion-preview` })
    ).json();
    assert.notEqual(fresh.version, preview.version);
    assert.equal(
      (
        await ctx.app.inject({
          method: "DELETE",
          url: `/api/conversations/${id}`,
          headers: { "if-match": JSON.stringify(preview.version) },
        })
      ).statusCode,
      409,
    );
  } finally {
    await ctx.app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Deletion rejects stale confirmation and pending sends; only fresh incoming revives hidden chat", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-trash-race-"));
  const ctx = await createApp({
    dataDir: dir,
    mode: "demo",
    localAccess: true,
    worker: false,
  });
  try {
    const id = ctx.store.incoming("instagram-1", event("first"));
    const preview = async () =>
      (
        await ctx.app.inject({
          url: `/api/conversations/${id}/deletion-preview`,
        })
      ).json();
    const remove = (version: string) =>
      ctx.app.inject({
        method: "DELETE",
        url: `/api/conversations/${id}`,
        headers: { "if-match": JSON.stringify(version) },
      });
    assert.equal(
      (
        await ctx.app.inject({
          method: "DELETE",
          url: `/api/conversations/${id}`,
        })
      ).statusCode,
      428,
    );
    const stale = await preview();
    ctx.store.incoming("instagram-1", event("second"));
    assert.equal((await remove(stale.version)).statusCode, 409);
    const draft = await preview();
    ctx.db
      .prepare(
        "UPDATE conversations SET draft_version=draft_version+1 WHERE id=?",
      )
      .run(id);
    assert.equal((await remove(draft.version)).statusCode, 409);
    ctx.store.enqueue(id, "pending", randomUUID());
    assert.equal((await preview()).pending, true);
    assert.equal((await remove((await preview()).version)).statusCode, 409);
    ctx.db
      .prepare("UPDATE outbox SET state='error' WHERE conversation_id=?")
      .run(id);
    const job = randomUUID();
    ctx.db
      .prepare(
        "INSERT INTO archive_jobs(id,idempotency_key,conversation_id,entry_id,state,created_at) VALUES(?,?,?,?,'preparing',?)",
      )
      .run(job, randomUUID(), id, "video", Date.now());
    assert.equal((await remove((await preview()).version)).statusCode, 409);
    ctx.db.prepare("UPDATE archive_jobs SET state='error' WHERE id=?").run(job);
    assert.equal((await remove((await preview()).version)).statusCode, 200);
    const boundary = ctx.store.conversation(id).deletedAt!;
    ctx.store.revealForIncoming(
      id,
      new Date(Date.parse(boundary) - 1000).toISOString(),
    );
    assert.ok(
      ctx.store.conversation(id).deletedAt,
      "old archive history must stay hidden",
    );
    ctx.store.revealForIncoming(
      id,
      new Date(Date.parse(boundary) + 1000).toISOString(),
    );
    assert.equal(ctx.store.conversation(id).deletedAt, null);
    assert.equal((await remove((await preview()).version)).statusCode, 200);
    ctx.store.incoming("instagram-1", event("third"));
    assert.equal(ctx.store.conversation(id).deletedAt, null);
  } finally {
    await ctx.app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Trash pagination is stable at equal timestamps and rejects invalid cursors", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-trash-pages-"));
  const ctx = await createApp({
    dataDir: dir,
    mode: "demo",
    localAccess: true,
    worker: false,
  });
  try {
    for (let i = 0; i < 55; i++)
      ctx.store.incoming("telegram-1", {
        ...event("one"),
        externalConversationId: String(i),
      });
    ctx.db
      .prepare("UPDATE conversations SET deleted_at=?")
      .run("2026-11-20T00:00:00.000Z");
    const first = (
      await ctx.app.inject({ url: "/api/conversations/deleted" })
    ).json();
    assert.equal(first.conversations.length, 50);
    const second = (
      await ctx.app.inject({
        url: "/api/conversations/deleted?cursor=" + first.nextCursor,
      })
    ).json();
    assert.equal(second.conversations.length, 5);
    assert.equal(
      new Set(
        [...first.conversations, ...second.conversations].map((c) => c.id),
      ).size,
      55,
    );
    assert.equal(second.nextCursor, null);
    assert.equal(
      (await ctx.app.inject({ url: "/api/conversations/deleted?cursor=bad" }))
        .statusCode,
      400,
    );
  } finally {
    await ctx.app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Trash endpoints require authentication", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-trash-auth-"));
  const ctx = await createApp({
    dataDir: dir,
    mode: "demo",
    localAccess: false,
    worker: false,
  });
  try {
    for (const [method, url] of [
      ["GET", "/api/conversations/deleted"],
      ["GET", `/api/conversations/${randomUUID()}`],
      ["DELETE", `/api/conversations/${randomUUID()}`],
      ["POST", `/api/conversations/${randomUUID()}/restore`],
    ] as const) {
      assert.equal((await ctx.app.inject({ method, url })).statusCode, 401);
    }
  } finally {
    await ctx.app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
