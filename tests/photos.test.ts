import { test } from "node:test";
import assert from "node:assert/strict";
import { Api, TelegramClient } from "teleproto";
import bigInt from "big-integer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openDb } from "../server/db.js";
import { Store } from "../server/store.js";
import { TelegramIntegration } from "../server/telegram.js";
import {
  photoInfo,
  imageMime,
  videoInfo,
  videoMime,
} from "../server/telegram-photos.js";
function message(ttlSeconds?: number) {
  return new Api.Message({
    id: 70,
    peerId: new Api.PeerUser({ userId: bigInt(123) }),
    date: 1,
    message: "Подпись",
    media: new Api.MessageMediaPhoto({
      ttlSeconds,
      photo: new Api.Photo({
        id: bigInt(7),
        accessHash: bigInt(8),
        fileReference: Buffer.alloc(0),
        date: 1,
        dcId: 2,
        sizes: [new Api.PhotoSize({ type: "x", w: 100, h: 100, size: 300 })],
      }),
    }),
  });
}
test("Фото: определение медиа, исключение таймера, проверка формата", () => {
  assert.equal(photoInfo(message())?.mime, "image/jpeg");
  assert.equal(photoInfo(message(10)), undefined);
  assert.equal(imageMime(Buffer.from([255, 216, 255, 0])), "image/jpeg");
  assert.throws(() => imageMime(Buffer.from("<html>not an image</html>")));
});
for (const video of [false, true])
  test(`${video ? "Видео" : "Фото"}: повторный импорт обновляет старое сообщение; загрузка через правильный аккаунт и дисковый кэш`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-photo-")),
      db = openDb(dir, "real"),
      store = new Store(db),
      integration = new TelegramIntegration(store, {
        apiId: 123,
        apiHash: "a".repeat(32),
        encryptionKey: "b".repeat(64),
        attachmentDir: path.join(dir, "attachments"),
      });
    try {
      db.prepare("INSERT INTO telegram_peers VALUES(?,?,?,?,?)").run(
        "telegram-1",
        "123",
        "456",
        "Клиент",
        "client",
      );
      const cid = randomUUID();
      db.prepare(
        "INSERT INTO conversations(id,account_id,external_id,name,updated_at) VALUES(?,?,?,?,?)",
      ).run(cid, "telegram-1", "123", "Клиент", new Date().toISOString());
      const mid = randomUUID();
      db.prepare(
        "INSERT INTO messages(id,conversation_id,external_id,direction,text,status,created_at) VALUES(?,?,?,'in','старое вложение','sent',?)",
      ).run(mid, cid, "70", new Date().toISOString());
      const sample = message();
      const bytes = video
        ? Buffer.from("0000ftypisom0000")
        : Buffer.from([255, 216, 255, 0, 1, 2]);
      if (video)
        sample.media = new Api.MessageMediaDocument({
          document: new Api.Document({
            id: bigInt(90),
            accessHash: bigInt(80),
            fileReference: Buffer.alloc(0),
            date: 1,
            mimeType: "video/mp4",
            size: bigInt(bytes.length),
            dcId: 2,
            attributes: [
              new Api.DocumentAttributeVideo({
                roundMessage: true,
                duration: 3,
                w: 240,
                h: 240,
              }),
            ],
          }),
        });
      if (video) {
        assert.equal(videoInfo(sample)?.name, "Видеосообщение");
        assert.equal(videoMime(bytes), "video/mp4");
        assert.throws(() => videoMime(Buffer.from("<html>bad</html>")));
        (sample.media as Api.MessageMediaDocument).ttlSeconds = 10;
        assert.equal(videoInfo(sample), undefined);
        (sample.media as Api.MessageMediaDocument).ttlSeconds = undefined;
      }
      let downloads = 0;
      integration.client = {
        connected: true,
        getMessages: async (peer: Api.InputPeerUser) => {
          assert.equal(peer.userId.toString(), "123");
          return [sample];
        },
        downloadMedia: async () => {
          downloads++;
          return bytes;
        },
        destroy: async () => {},
      } as unknown as TelegramClient;
      Object.defineProperty(integration, "authenticated", { value: true });
      await (
        integration as unknown as {
          importMessage: (m: Api.Message, u: boolean) => Promise<void>;
        }
      ).importMessage(sample, true);
      assert.equal(store.messages(cid).length, 1);
      assert.equal(store.conversation(cid).unread, 0);
      assert.equal(store.messages(cid)[0].text, "Подпись");
      assert.equal(
        store.messages(cid)[0].attachments[0].url,
        `/api/telegram/${video ? "videos" : "photos"}/${mid}`,
      );
      const [a, b] = await Promise.all([
        integration.photo(mid, video),
        integration.photo(mid, video),
      ]);
      assert.equal(downloads, 1);
      assert.equal(a.mime, video ? "video/mp4" : "image/jpeg");
      assert.deepEqual(a.bytes, b.bytes);
      await integration.photo(mid, video);
      assert.equal(downloads, 1);
      await assert.rejects(
        integration.photo(randomUUID(), video),
        /не найдена/,
      );
    } finally {
      await integration.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

test("Telegram: a burst of photos queues instead of failing; duplicates share work and a failure releases its slot", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-photo-burst-")),
    db = openDb(dir, "real"),
    store = new Store(db);
  const tg = new TelegramIntegration(store, {
    apiId: 1,
    apiHash: "test",
    encryptionKey: "test",
  });
  let active = 0,
    peak = 0,
    calls = 0;
  const internal = tg as unknown as {
    downloadPhoto: (
      id: string,
      video: boolean,
    ) => Promise<{ bytes: Buffer; mime: string }>;
  };
  internal.downloadPhoto = async (id) => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    try {
      await new Promise((r) => setImmediate(r));
      if (id === "bad") throw new Error("Unavailable");
      return { bytes: Buffer.from([255, 216, 255, 0]), mime: "image/jpeg" };
    } finally {
      active--;
    }
  };
  try {
    const jobs = Array.from({ length: 15 }, (_, i) => tg.photo(String(i)));
    const duplicate = tg.photo("14");
    const bad = tg.photo("bad");
    const results = await Promise.allSettled([
      ...jobs,
      duplicate,
      bad,
      tg.photo("after", true),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 17);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    assert.equal(peak, 3);
    assert.equal(active, 0);
    assert.equal(calls, 17);
    assert.deepEqual(await tg.photo("next"), {
      bytes: Buffer.from([255, 216, 255, 0]),
      mime: "image/jpeg",
    });
  } finally {
    await tg.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
