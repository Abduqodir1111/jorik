import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Api } from "teleproto";
import { createApp } from "../server/app.js";
import { hashToken } from "../server/auth.js";
import { TelegramIntegration } from "../server/telegram.js";

const options = {
  apiId: 123,
  apiHash: "a".repeat(32),
  encryptionKey: "b".repeat(64),
};
test("Web read awaits Telegram acknowledgement, preserves concurrent arrivals and never acknowledges manual unread", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-web-read-"));
  const ctx = await createApp({
    dataDir: dir,
    mode: "real",
    worker: false,
    disableRateLimit: true,
    telegram: options,
  });
  const original = TelegramIntegration.prototype.markSeen;
  const { db, store, app } = ctx;
  try {
    const token = randomUUID();
    db.prepare("INSERT INTO sessions VALUES(?,?)").run(
      hashToken(token),
      Date.now() + 60000,
    );
    const cookies = { session: token };
    const incoming = (externalMessageId: string) =>
      store.incoming("telegram-1", {
        externalConversationId: "123",
        externalMessageId,
        name: "Synthetic",
        username: "test",
        text: "test",
      });
    const id = incoming("10"),
      first = store.messages(id)[0];
    let calls = 0,
      fail = true;
    TelegramIntegration.prototype.markSeen = async function (cid, mid) {
      calls++;
      assert.equal(cid, id);
      assert.equal(mid, first.id);
      assert.equal(store.conversation(id).unread, 1);
      if (fail) throw new Error("Synthetic disconnected");
      incoming("20"); // Same timestamp still must survive the pending request.
      db.prepare(
        "UPDATE messages SET created_at=? WHERE conversation_id=?",
      ).run(first.createdAt, id);
    };
    const read = () =>
      app.inject({
        method: "POST",
        url: `/api/conversations/${id}/read`,
        cookies,
        payload: { unread: false, throughId: first.id },
      });
    assert.equal((await read()).statusCode, 400);
    assert.equal(store.conversation(id).unread, 1);
    fail = false;
    assert.equal((await read()).statusCode, 200);
    assert.equal(store.conversation(id).unread, 1);
    assert.equal(calls, 2);
    await app.inject({
      method: "POST",
      url: `/api/conversations/${id}/read`,
      cookies,
      payload: { unread: true },
    });
    assert.equal(calls, 2);
  } finally {
    TelegramIntegration.prototype.markSeen = original;
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Telegram web read uses a positive bounded maxId, isolates accounts, coalesces requests and persists watermark only after success", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-tg-seen-"));
  const ctx = await createApp({
    dataDir: dir,
    mode: "demo",
    worker: false,
    disableRateLimit: true,
  });
  const { db, store } = ctx;
  const tg = new TelegramIntegration(store, options);
  let calls = 0,
    fail = false;
  const internals = tg as any;
  try {
    const incoming = (account: string, mid: string) =>
      store.incoming(account, {
        externalConversationId: "123",
        externalMessageId: mid,
        name: "Synthetic",
        username: "test",
        text: "test",
      });
    const id = incoming("telegram-1", "10"),
      first = store.messages(id)[0];
    incoming("telegram-1", "20");
    const other = incoming("telegram-2", "10");
    db.prepare("INSERT INTO telegram_peers VALUES(?,?,?,?,?)").run(
      "telegram-1",
      "123",
      "456",
      "Synthetic",
      "test",
    );
    internals.authenticated = true;
    internals.client = {
      connected: true,
      invoke: async (request: Api.messages.ReadHistory) => {
        calls++;
        assert.ok(request instanceof Api.messages.ReadHistory);
        assert.equal(request.maxId, 10);
        assert.equal(
          (request.peer as Api.InputPeerUser).userId.toString(),
          "123",
        );
        await new Promise((resolve) => setImmediate(resolve));
        if (fail) throw new Error("Synthetic network failure");
        return new Api.messages.AffectedMessages({ pts: 1, ptsCount: 1 });
      },
    };
    await Promise.all([tg.markSeen(id, first.id), tg.markSeen(id, first.id)]);
    assert.equal(calls, 1);
    assert.equal(store.conversation(id).unread, 1);
    assert.equal(store.conversation(other).unread, 1);
    assert.equal(
      (
        db
          .prepare(
            "SELECT telegram_read_inbox_max_id AS n FROM conversations WHERE id=?",
          )
          .get(id) as any
      ).n,
      10,
    );
    await assert.rejects(
      tg.markSeen(other, store.messages(other)[0].id),
      /Неверный аккаунт/,
    );
    await assert.rejects(
      tg.markSeen(id, store.messages(other)[0].id),
      /не найдено/,
    );
    db.prepare(
      "UPDATE conversations SET telegram_read_inbox_max_id=0,unread=2 WHERE id=?",
    ).run(id);
    fail = true;
    await assert.rejects(tg.markSeen(id, first.id));
    assert.equal(store.conversation(id).unread, 2);
    assert.equal(
      (
        db
          .prepare(
            "SELECT telegram_read_inbox_max_id AS n FROM conversations WHERE id=?",
          )
          .get(id) as any
      ).n,
      0,
    );
    fail = false;
    await tg.markSeen(id, first.id);
    internals.client.connected = false;
    await assert.rejects(tg.markSeen(id, first.id), /не подключён/);
  } finally {
    internals.client = undefined;
    await tg.close();
    await ctx.app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Instagram read failure leaves unread intact; acknowledgement preserves arrivals and skips partial-history reads", async () => {
  const { InstagramIntegration } = await import("../server/instagram.js");
  const start = InstagramIntegration.prototype.start;
  const seen = InstagramIntegration.prototype.markSeen;
  InstagramIntegration.prototype.start = function () {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-ig-seen-"));
  const ctx = await createApp({
    dataDir: dir,
    mode: "real",
    worker: false,
    disableRateLimit: true,
    instagram: { token: "synthetic-only" },
  });
  try {
    const { app, db, store } = ctx;
    const token = randomUUID();
    db.prepare("INSERT INTO sessions VALUES(?,?)").run(
      hashToken(token),
      Date.now() + 60000,
    );
    const incoming = (mid: string) =>
      store.incoming("instagram-1", {
        externalConversationId: "synthetic",
        externalMessageId: mid,
        name: "Synthetic",
        username: "test",
        text: "test",
      });
    const id = incoming("first"),
      first = store.messages(id)[0];
    let fail = true,
      calls = 0;
    InstagramIntegration.prototype.markSeen = async function (cid) {
      assert.equal(cid, id);
      calls++;
      if (fail) throw new Error("Synthetic Meta rejection");
      incoming("second");
      db.prepare(
        "UPDATE messages SET created_at=? WHERE conversation_id=?",
      ).run(first.createdAt, id);
    };
    const read = () =>
      app.inject({
        method: "POST",
        url: `/api/conversations/${id}/read`,
        cookies: { session: token },
        payload: { unread: false, throughId: first.id },
      });
    assert.equal((await read()).statusCode, 400);
    assert.equal(store.conversation(id).unread, 1);
    fail = false;
    assert.equal((await read()).statusCode, 200);
    assert.equal(store.conversation(id).unread, 1);
    assert.equal(calls, 2);
    assert.equal((await read()).statusCode, 200);
    assert.equal(
      calls,
      2,
      "Meta mark_seen has no message boundary, so partial history must not acknowledge newer messages",
    );
  } finally {
    InstagramIntegration.prototype.start = start;
    InstagramIntegration.prototype.markSeen = seen;
    await ctx.app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
