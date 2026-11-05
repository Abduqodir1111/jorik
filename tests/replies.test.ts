import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bigInt from "big-integer";
import { Api, TelegramClient } from "teleproto";
import { openDb } from "../server/db.js";
import { Store } from "../server/store.js";
import { TelegramIntegration } from "../server/telegram.js";
import { InstagramIntegration } from "../server/instagram.js";

const envelope = (prefix: string) =>
  Buffer.from(`${prefix}ig_dm_item:1:IGMessageID:123:456:789`)
    .toString("base64")
    .replace(
      /[Z+/=]/g,
      (c) => ({ Z: "ZA", "+": "ZB", "/": "ZC", "=": "ZD" })[c]!,
    );
test("Instagram reply MID resolves canonical aliases, late originals and duplicate webhooks within its conversation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-replies-"));
  const db = openDb(dir, "real");
  const s = new Store(db);
  const ig = new InstagramIntegration(s, {
    token: "test",
    receiveMode: "webhook",
    fetcher: (async () =>
      Response.json({
        id: "page",
        instagram_business_account: { id: "shop", username: "shop" },
      })) as typeof fetch,
  });
  try {
    await ig.sync();
    const send = (
      mid: string,
      text: string,
      reply?: string,
      peer = "customer",
      out = false,
    ) =>
      ig.receiveWebhook({
        id: "shop",
        messaging: [
          {
            sender: { id: out ? "shop" : peer },
            recipient: { id: out ? peer : "shop" },
            timestamp: Date.now(),
            message: {
              mid,
              text,
              reply_to: reply ? { mid: reply } : undefined,
              is_echo: out,
            },
          },
        ],
      });
    send("answer", "Ответ", envelope("new_"));
    const c = s.conversations()[0];
    const unread = c.unread;
    assert.equal(
      s.messages(c.id)[0].reply_to?.sender_name,
      "Сообщение недоступно",
    );
    send(envelope(""), "Оригинал", undefined, "another", true);
    assert.equal(
      s.messages(c.id)[0].reply_to?.sender_name,
      "Сообщение недоступно",
    );
    send(envelope(""), "Оригинал", undefined, "customer", true);
    let answer = s.messages(c.id).find((m) => m.externalId === "answer")!;
    assert.equal(answer.reply_to?.text, "Оригинал");
    assert.equal(answer.reply_to?.sender_name, "shop");
    assert.ok(answer.replyToId);
    send("answer", "Ответ", envelope("new_"));
    answer = s.messages(c.id).find((m) => m.externalId === "answer")!;
    assert.equal(answer.reply_to?.text, "Оригинал");
    assert.equal(s.messages(c.id).length, 2);
    assert.equal(s.conversation(c.id).unread, 0); // Native outgoing echo acknowledges the earlier incoming.
    send("plain", "Без цитаты");
    assert.equal(
      s.messages(c.id).find((m) => m.externalId === "plain")!.reply_to,
      undefined,
    );
  } finally {
    await ig.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Telegram imports native reply header, fetches a missing original without importing/unread, and preserves partial quotes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-tg-replies-"));
  const db = openDb(dir, "real");
  const s = new Store(db);
  const tg = new TelegramIntegration(s, {
    apiId: 1,
    apiHash: "a".repeat(32),
    encryptionKey: "b".repeat(64),
  });
  try {
    db.prepare("INSERT INTO telegram_peers VALUES(?,?,?,?,?)").run(
      "telegram-1",
      "123",
      "456",
      "Анна",
      "anna",
    );
    const original = new Api.Message({
      id: 7,
      peerId: new Api.PeerUser({ userId: bigInt(123) }),
      date: 1,
      message: "Полный исходный текст",
      out: true,
    });
    let fetches = 0;
    tg.client = {
      connected: true,
      getMessages: async () => {
        fetches++;
        return [original];
      },
      destroy: async () => {},
    } as unknown as TelegramClient;
    const imp = (m: Api.Message) =>
      (
        tg as unknown as {
          importMessage(m: Api.Message, unread: boolean): Promise<void>;
        }
      ).importMessage(m, true);
    const reply = new Api.Message({
      id: 9,
      peerId: new Api.PeerUser({ userId: bigInt(123) }),
      date: 2,
      message: "Ответ",
      replyTo: new Api.MessageReplyHeader({
        replyToMsgId: 7,
        quoteText: "исходный текст",
      }),
    });
    await imp(reply);
    const c = s.conversations()[0];
    assert.equal(s.messages(c.id).length, 1);
    assert.equal(c.unread, 1);
    assert.deepEqual(s.messages(c.id)[0].reply_to, {
      sender_name: "Telegram 1",
      text: "исходный текст",
      message_id: "7",
    });
    await imp(reply);
    assert.equal(fetches, 1);
    assert.equal(s.conversation(c.id).unread, 1);
    await imp(original);
    assert.equal(
      s.messages(c.id).find((m) => m.externalId === "9")!.reply_to?.text,
      "исходный текст",
    );
    const other = new Api.Message({
      id: 10,
      peerId: new Api.PeerUser({ userId: bigInt(123) }),
      date: 3,
      message: "Из другого чата",
      replyTo: new Api.MessageReplyHeader({
        replyToMsgId: 7,
        replyToPeerId: new Api.PeerUser({ userId: bigInt(999) }),
        quoteText: "Внешняя цитата",
      }),
    });
    await imp(other);
    assert.equal(fetches, 1);
    assert.equal(
      s.messages(c.id).find((m) => m.externalId === "10")!.reply_to?.text,
      "Внешняя цитата",
    );
  } finally {
    await tg.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
