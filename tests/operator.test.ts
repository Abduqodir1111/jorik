import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/app.js";
import { InstagramIntegration } from "../server/instagram.js";
import { TelegramIntegration } from "../server/telegram.js";
import { Api, TelegramClient } from "teleproto";
const jpeg = Buffer.from([255, 216, 255, 0, 1, 2]);

test("Operator: persisted slots/statuses, validated uploads/replies, idempotency and draft preservation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-operator-"));
  const { app, store, db } = await createApp({
    dataDir: dir,
    mode: "demo",
    localAccess: true,
    worker: false,
  });
  try {
    const event = {
      externalConversationId: "1",
      externalMessageId: "50",
      name: "Test",
      username: "test",
      text: "Question",
    };
    const a = store.incoming("telegram-1", event),
      b = store.incoming("telegram-2", event);
    const slots = Array.from({ length: 4 }, (_, i) => ({
      title: "Slot " + i,
      text: "Answer " + i,
    }));
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: "/api/quick-replies",
          payload: slots,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: "/api/quick-replies",
          payload: slots.slice(1),
        })
      ).statusCode,
      400,
    );
    assert.deepEqual(
      JSON.parse((await app.inject("/api/state")).json().settings.quickReplies),
      slots,
    );
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/conversations/${a}/stage`,
          payload: { stage: "paid" },
        })
      ).statusCode,
      200,
    );
    assert.equal(store.conversation(a).stage, "paid");
    assert.equal(store.conversation(b).stage, "");
    const uploaded = await app.inject({
      method: "POST",
      url: `/api/conversations/${a}/uploads`,
      payload: { name: "test.jpg", data: jpeg.toString("base64") },
    });
    assert.equal(uploaded.statusCode, 200);
    const uploadId = uploaded.json().id;
    assert.equal(
      (await app.inject("/api/uploads/" + uploadId)).headers["content-type"],
      "image/jpeg",
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/conversations/${a}/uploads`,
          payload: {
            name: "x.jpg",
            data: Buffer.from("<script>bad</script>").toString("base64"),
          },
        })
      ).statusCode,
      400,
    );
    const quote = store.messages(a)[0].id;
    assert.throws(() =>
      store.enqueue(b, "wrong", randomUUID(), { replyToId: quote }),
    );
    assert.throws(() => store.enqueue(b, "wrong", randomUUID(), { uploadId }));
    db.prepare("UPDATE conversations SET draft='Keep me' WHERE id=?").run(a);
    const key = randomUUID(),
      id = store.enqueue(a, "", key, {
        uploadId,
        replyToId: quote,
        preserveDraft: true,
      });
    assert.equal(store.enqueue(a, "", key, { uploadId }), id);
    await store.tick();
    const sent = store.messages(a).find((m) => m.id === id)!;
    assert.equal(sent.status, "sent");
    assert.equal(sent.replyToId, quote);
    assert.equal(sent.readAt, null);
    assert.equal(sent.attachments[0].url, "/api/uploads/" + uploadId);
    assert.equal(store.conversation(a).draft, "Keep me");
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Telegram: native replies and image delivery target the selected peer; uncertain uploads never auto-retry", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-tg-media-"));
  const { app, db, store } = await createApp({
    dataDir: dir,
    mode: "demo",
    localAccess: true,
    worker: false,
  });
  const integration = new TelegramIntegration(store, {
    accountId: "telegram-1",
    apiId: 123,
    apiHash: "a".repeat(32),
    encryptionKey: "b".repeat(64),
  });
  try {
    const cid = store.incoming("telegram-1", {
      externalConversationId: "123",
      externalMessageId: "50",
      name: "Test",
      username: "test",
      text: "Question",
    });
    db.prepare("INSERT INTO telegram_peers VALUES(?,?,?,?,?)").run(
      "telegram-1",
      "123",
      "456",
      "Test",
      "test",
    );
    Object.defineProperty(integration, "authenticated", { value: true });
    let fileCalls = 0;
    integration.client = {
      connected: true,
      destroy: async () => {},
      invoke: async (req: Api.messages.SendMessage) => {
        assert.equal((req.peer as Api.InputPeerUser).userId.toString(), "123");
        assert.equal((req.replyTo as Api.InputReplyToMessage).replyToMsgId, 50);
        return new Api.UpdateShortSentMessage({
          id: 60,
          pts: 1,
          ptsCount: 1,
          date: 1,
          out: true,
        });
      },
      sendFile: async (
        peer: Api.InputPeerUser,
        options: { replyTo: number; file: { buffer: Buffer } },
      ) => {
        fileCalls++;
        assert.equal(peer.userId.toString(), "123");
        assert.equal(options.replyTo, 50);
        if (fileCalls > 1) throw Error("timeout");
        return { id: 61 };
      },
    } as unknown as TelegramClient;
    store.resolveAdapter = () => integration.adapter;
    db.prepare(
      "UPDATE accounts SET state='connected' WHERE id='telegram-1'",
    ).run();
    const quote = store.messages(cid)[0].id;
    store.enqueue(cid, "Answer", randomUUID(), { replyToId: quote });
    await store.tick();
    assert.equal(store.messages(cid).at(-1)?.externalId, "60");
    const uploadId = randomUUID();
    db.prepare("INSERT INTO uploads VALUES(?,?,?,?,?,?)").run(
      uploadId,
      cid,
      "x.jpg",
      "image/jpeg",
      jpeg,
      new Date().toISOString(),
    );
    store.enqueue(cid, "", randomUUID(), { uploadId, replyToId: quote });
    await store.tick();
    assert.equal(store.messages(cid).at(-1)?.externalId, "61");
    store.enqueue(cid, "", randomUUID(), { uploadId, replyToId: quote });
    await store.tick();
    await store.tick();
    assert.equal(fileCalls, 2);
    assert.equal(store.messages(cid).at(-1)?.status, "unknown");
  } finally {
    await integration.close();
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Instagram: image upload then send uses same account and preserves ambiguity", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-ig-media-"));
  const { app, db, store } = await createApp({
    dataDir: dir,
    mode: "demo",
    localAccess: true,
    worker: false,
  });
  let uploads = 0,
    sends = 0;
  const fetcher = (async (url: string, options: RequestInit) => {
    if (url.includes("/message_attachments")) {
      uploads++;
      assert.ok(options.body instanceof FormData);
      assert.equal(
        (options.headers as Record<string, string>)["Content-Type"],
        undefined,
      );
      assert.equal(options.body.get("platform"), "instagram");
      assert.ok(options.body.get("filedata") instanceof Blob);
      return Response.json({ attachment_id: "asset" });
    }
    if (options.method === "POST") {
      sends++;
      const body = JSON.parse(options.body as string);
      assert.equal(body.recipient.id, "client");
      assert.equal(body.message.attachment.payload.attachment_id, "asset");
      if (sends > 1) throw new Error("lost confirmation");
      return Response.json({ message_id: "sent" });
    }
    if (url.includes("/me?"))
      return Response.json({
        id: "page",
        instagram_business_account: { id: "ig", username: "test" },
      });
    return Response.json({
      data: [
        {
          id: "thread",
          updated_time: new Date().toISOString(),
          participants: {
            data: [{ id: "ig" }, { id: "client", username: "test" }],
          },
          messages: {
            data: [
              {
                id: "incoming",
                created_time: new Date().toISOString(),
                from: { id: "client" },
                message: "Hello",
              },
            ],
          },
        },
      ],
    });
  }) as typeof fetch;
  const ig = new InstagramIntegration(store, { token: "test", fetcher });
  try {
    await ig.sync();
    store.resolveAdapter = () => ig.adapter;
    const cid = store.conversations()[0].id,
      uploadId = randomUUID();
    db.prepare("INSERT INTO uploads VALUES(?,?,?,?,?,?)").run(
      uploadId,
      cid,
      "x.jpg",
      "image/jpeg",
      jpeg,
      new Date().toISOString(),
    );
    store.enqueue(cid, "", randomUUID(), { uploadId });
    await store.tick();
    assert.equal(uploads, 1);
    assert.equal(sends, 1);
    assert.equal(store.messages(cid).at(-1)?.status, "sent");
    store.enqueue(cid, "", randomUUID(), { uploadId });
    await store.tick();
    await store.tick();
    assert.equal(sends, 2);
    assert.equal(store.messages(cid).at(-1)?.status, "unknown");
  } finally {
    await ig.close();
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
