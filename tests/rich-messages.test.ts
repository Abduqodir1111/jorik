import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import bigInt from "big-integer";
import { Api, TelegramClient } from "teleproto";
import { openDb } from "../server/db.js";
import { Store } from "../server/store.js";
import { TelegramIntegration } from "../server/telegram.js";
import { richMedia, telegramReactions } from "../server/telegram-rich-media.js";
import { instagramAttachments } from "../server/instagram-media.js";
function message(id = 71, out = false) {
  return new Api.Message({
    id,
    out,
    peerId: new Api.PeerUser({ userId: bigInt(123) }),
    date: 1700000000,
    message: "Текст",
  });
}
function document(mime: string, attrs: Api.TypeDocumentAttribute[]) {
  return new Api.MessageMediaDocument({
    document: new Api.Document({
      id: bigInt(1),
      accessHash: bigInt(2),
      fileReference: Buffer.alloc(0),
      date: 1,
      mimeType: mime,
      size: bigInt(50),
      dcId: 2,
      attributes: attrs,
    }),
  });
}
function reactions(chosen = true) {
  return new Api.MessageReactions({
    results: [
      new Api.ReactionCount({
        reaction: new Api.ReactionEmoji({ emoticon: "👍" }),
        count: 1,
        chosenOrder: chosen ? 0 : undefined,
      }),
    ],
  });
}
test("Rich Telegram: geo bounds, sticker priority, voice duration and expiring media", () => {
  const m = message();
  m.media = new Api.MessageMediaGeo({
    geo: new Api.GeoPoint({ long: 69.2, lat: 41.3, accessHash: bigInt(0) }),
  });
  assert.equal(richMedia(m)?.latitude, 41.3);
  (m.media.geo as Api.GeoPoint).lat = 100;
  assert.equal(richMedia(m), undefined);
  for (const mime of ["image/webp", "video/webm", "application/x-tgsticker"]) {
    m.media = document(mime, [
      new Api.DocumentAttributeSticker({
        alt: "😄",
        stickerset: new Api.InputStickerSetEmpty(),
      }),
    ]);
    assert.equal(richMedia(m)?.kind, "sticker");
    (m.media as Api.MessageMediaDocument).ttlSeconds = 1;
    assert.equal(richMedia(m), undefined);
  }
  m.media = document("audio/ogg", [
    new Api.DocumentAttributeAudio({ voice: true, duration: 15 }),
  ]);
  assert.equal(richMedia(m)?.duration, 15);
  assert.equal(richMedia(m)?.kind, "voice");
  assert.deepEqual(telegramReactions(reactions()), [
    { emoji: "👍", count: 1, chosen: true },
  ]);
  assert.equal(
    instagramAttachments(
      [{ audio_data: { url: "https://lookaside.fbsbx.com/voice.m4a" } }],
      "id",
    )[0].kind,
    "voice",
  );
  assert.deepEqual(
    instagramAttachments(
      [{ audio_data: { url: "https://127.0.0.1/secret" } }],
      "id",
    ),
    [],
  );
});
test("TG edit/reaction updates one identity, preserves unread/outbox/read status, rejects stale/foreign/incoming edits", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-rich-")),
    db = openDb(dir, "real"),
    store = new Store(db);
  const tg = new TelegramIntegration(store, {
    apiId: 123,
    apiHash: "a".repeat(32),
    encryptionKey: "b".repeat(64),
    attachmentDir: path.join(dir, "attachments"),
  });
  const patches: string[] = [];
  store.messageUpdated = (m) => patches.push(m.id);
  db.prepare("INSERT INTO telegram_peers VALUES(?,?,?,?,?)").run(
    "telegram-1",
    "123",
    "456",
    "Client",
    "client",
  );
  db.prepare(
    "INSERT INTO conversations(id,account_id,external_id,name,updated_at,unread) VALUES('chat','telegram-1','123','Client',?,3)",
  ).run(new Date().toISOString());
  Object.defineProperty(tg, "authenticated", { value: true });
  const m = message(71, true);
  let calls = 0;
  tg.client = {
    connected: true,
    invoke: async (req: unknown) => {
      calls++;
      assert.ok(
        req instanceof Api.messages.EditMessage ||
          req instanceof Api.messages.SendReaction,
      );
      return new Api.Updates({
        updates: [],
        users: [],
        chats: [],
        date: 1,
        seq: 1,
      });
    },
    getMessages: async () => {
      m.reactions = reactions();
      return [m];
    },
    destroy: async () => {},
  } as unknown as TelegramClient;
  const importer = tg as unknown as {
    importMessage(
      m: Api.Message,
      unread: boolean,
      edited?: boolean,
    ): Promise<void>;
  };
  try {
    await importer.importMessage(m, false);
    const before = store.messages("chat")[0];
    db.prepare("UPDATE messages SET read_at='2026-01-01' WHERE id=?").run(
      before.id,
    );
    db.prepare("UPDATE conversations SET unread=3 WHERE id='chat'").run();
    const edited = await tg.edit(before.id, "Новый текст", "Текст");
    assert.equal(edited.text, "Новый текст");
    assert.ok(edited.editedAt);
    assert.equal(edited.readAt, "2026-01-01");
    assert.equal(store.conversation("chat").unread, 3);
    assert.equal(store.messages("chat").length, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM outbox").get()!.n, 0);
    await assert.rejects(
      tg.edit(before.id, "Другое", "Текст"),
      /уже изменилось/,
    );
    assert.equal(calls, 1);
    await importer.importMessage(m, false);
    assert.equal(store.messages("chat")[0].text, "Новый текст");
    await tg.react(before.id, "👍");
    assert.equal(store.messages("chat")[0].reactions?.[0].chosen, true);
    assert.ok(patches.length >= 2);
    m.out = false;
    m.id = 72;
    await importer.importMessage(m, true);
    const incoming = store.messages("chat").find((x) => x.externalId === "72")!;
    await assert.rejects(
      tg.edit(incoming.id, "No", incoming.text),
      /только отправленный/,
    );
    const other = new TelegramIntegration(store, {
      accountId: "telegram-2",
      apiId: 123,
      apiHash: "a".repeat(32),
      encryptionKey: "b".repeat(64),
    });
    await assert.rejects(other.react(before.id, "👍"), /недоступно/);
    await other.close();
  } finally {
    await tg.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("TG voice/sticker media cache, same-message dedup, TGS safe decompression and asset rejection", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-sticker-")),
    db = openDb(dir, "real"),
    store = new Store(db);
  const tg = new TelegramIntegration(store, {
    apiId: 123,
    apiHash: "a".repeat(32),
    encryptionKey: "b".repeat(64),
    attachmentDir: path.join(dir, "attachments"),
  });
  db.prepare("INSERT INTO telegram_peers VALUES(?,?,?,?,?)").run(
    "telegram-1",
    "123",
    "456",
    "Client",
    "client",
  );
  db.prepare(
    "INSERT INTO conversations(id,account_id,external_id,name,updated_at) VALUES('chat','telegram-1','123','Client',?)",
  ).run(new Date().toISOString());
  Object.defineProperty(tg, "authenticated", { value: true });
  let downloads = 0;
  const m = message();
  m.message = "";
  m.media = document("application/x-tgsticker", [
    new Api.DocumentAttributeSticker({
      alt: "😄",
      stickerset: new Api.InputStickerSetEmpty(),
    }),
  ]);
  tg.client = {
    connected: true,
    getMessages: async () => [m],
    downloadMedia: async () => {
      downloads++;
      return gzipSync(JSON.stringify({ v: "5.5.7", layers: [], assets: [] }));
    },
    destroy: async () => {},
  } as unknown as TelegramClient;
  try {
    await (tg as any).importMessage(m, false);
    const saved = store.messages("chat")[0];
    assert.equal(saved.attachments[0].kind, "sticker");
    const [a, b] = await Promise.all([
      tg.specialMedia(saved.id),
      tg.specialMedia(saved.id),
    ]);
    assert.equal(downloads, 1);
    assert.equal(a.mime, "application/json");
    assert.deepEqual(a.bytes, b.bytes);
    assert.deepEqual(JSON.parse(a.bytes.toString()).layers, []);
    await tg.specialMedia(saved.id);
    assert.equal(downloads, 1);
    const files = fs.readdirSync(path.join(dir, "attachments"));
    fs.writeFileSync(
      path.join(dir, "attachments", files[0]),
      gzipSync(
        JSON.stringify({
          layers: [],
          assets: [{ p: "http://external.example/img" }],
        }),
      ),
    );
    await assert.rejects(tg.specialMedia(saved.id), /стикер/);
  } finally {
    await tg.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Rich media endpoints retain auth and reject unsupported targets/invalid reaction input", async () => {
  const { createApp } = await import("../server/app.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-rich-api-"));
  const { app, store, db } = await createApp({
    dataDir: dir,
    mode: "demo",
    worker: false,
    localAccess: true,
  });
  try {
    const c = store.incoming("instagram-1", {
      externalConversationId: "client",
      externalMessageId: "mid",
      text: "test",
      name: "Test",
      username: "test",
    });
    const m = store.messages(c)[0];
    const denied = await app.inject({
      method: "PATCH",
      url: `/api/messages/${m.id}/text`,
      payload: { text: "new", expectedText: "test" },
    });
    assert.notEqual(denied.statusCode, 200);
    assert.equal(store.messages(c)[0].text, "test");
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: `/api/messages/${m.id}/reaction`,
          payload: { emoji: "💰" },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await app.inject("/api/telegram/media/not-found")).statusCode,
      404,
    );
    assert.equal(db.prepare("SELECT COUNT(*) n FROM outbox").get()!.n, 0);
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const secure = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-rich-auth-"));
  const locked = await createApp({
    dataDir: secure,
    mode: "demo",
    worker: false,
  });
  try {
    for (const [method, url, payload] of [
      ["GET", "/api/telegram/media/any", undefined],
      ["PATCH", "/api/messages/any/text", { text: "new", expectedText: "old" }],
      ["PUT", "/api/messages/any/reaction", { emoji: "👍" }],
    ] as const) {
      assert.equal(
        (await locked.app.inject({ method, url, payload })).statusCode,
        401,
      );
    }
  } finally {
    await locked.app.close();
    fs.rmSync(secure, { recursive: true, force: true });
  }
});

test("SSE delivers a targeted message update without a new incoming notification or changing unread", async () => {
  const { createApp } = await import("../server/app.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-rich-sse-"));
  const { app, store, db } = await createApp({
    dataDir: dir,
    mode: "demo",
    worker: false,
    localAccess: true,
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const cid = store.incoming("telegram-1", {
      externalConversationId: "sse-client",
      externalMessageId: "1",
      text: "before",
      name: "Test",
      username: "test",
    });
    const m = store.messages(cid)[0],
      unread = store.conversation(cid).unread;
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    assert.ok(addr && typeof addr === "object");
    const response = await fetch(`http://127.0.0.1:${addr.port}/api/events`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    reader = response.body!.getReader();
    await reader.read();
    db.prepare("UPDATE messages SET text=?,edited_at=? WHERE id=?").run(
      "after",
      new Date().toISOString(),
      m.id,
    );
    store.publishMessage(m.id, cid);
    let result = "";
    while (!result.includes("message-update")) {
      const chunk = await reader.read();
      assert.ok(!chunk.done);
      result += new TextDecoder().decode(chunk.value);
    }
    assert.match(result, /event: message-update/);
    assert.ok(result.includes('"text":"after"'));
    assert.ok(!result.includes("event: incoming"));
    assert.equal(store.conversation(cid).unread, unread);
    assert.equal(store.messages(cid).length, 1);
  } finally {
    await reader?.cancel();
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
