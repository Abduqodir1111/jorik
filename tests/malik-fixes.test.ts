import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Api, TelegramClient } from "teleproto";
import { createApp } from "../server/app.js";
import { TelegramIntegration } from "../server/telegram.js";
import { openDb } from "../server/db.js";
import { Store } from "../server/store.js";
import { generateDeliveryWorksheet } from "../shared/delivery-export.js";
const input = {
  conversationId: null,
  client: "Test",
  source: "Офлайн",
  date: "2026-11-08",
  phone: "+998901234567",
  deliveryType: "delivery",
  district: "Мирабад",
  address: "Street",
  coordinates: "",
  amount: 100000,
  isPaid: false,
  items: "Book",
};
test("Additional phone is optional, validated, persists across restart, removable and exported in the existing phone column", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-extra-phone-"));
  let ctx = await createApp({
    dataDir: dir,
    mode: "demo",
    localAccess: true,
    worker: false,
  });
  try {
    const legacy = await ctx.app.inject({
      method: "POST",
      url: "/api/orders",
      payload: input,
    });
    assert.equal(legacy.statusCode, 201);
    assert.equal(legacy.json().additionalPhone, undefined);
    assert.equal(
      (
        await ctx.app.inject({
          method: "POST",
          url: "/api/orders",
          payload: { ...input, additionalPhone: "+99812" },
        })
      ).statusCode,
      400,
    );
    const extra = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/orders",
        payload: { ...input, additionalPhone: "+998991234567" },
      })
    ).json();
    assert.equal(extra.additionalPhone, "+998991234567");
    await ctx.app.close();
    ctx = await createApp({
      dataDir: dir,
      mode: "demo",
      localAccess: true,
      worker: false,
    });
    const data = (await ctx.app.inject("/api/orders")).json();
    const order = data.find((o: any) => o.id === extra.id);
    assert.equal(order.additionalPhone, "+998991234567");
    const sheet = generateDeliveryWorksheet([order]);
    assert.equal(sheet.headers.length, 8);
    assert.equal(sheet.rows[0][2], "+998901234567, +998991234567");
    const changed = await ctx.app.inject({
      method: "PUT",
      url: "/api/orders/" + extra.id,
      payload: { ...input, additionalPhone: "" },
    });
    assert.equal(changed.statusCode, 200);
    assert.equal(changed.json().additionalPhone, undefined);
    assert.equal(
      generateDeliveryWorksheet([changed.json()]).rows[0][2],
      input.phone,
    );
  } finally {
    await ctx.app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("Telegram delete is scoped to own sent messages, awaits confirmation and keeps durable outbox/read/unread data", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-delete-"));
  const db = openDb(dir, "real"),
    store = new Store(db);
  const tg = new TelegramIntegration(store, {
    apiId: 123,
    apiHash: "a".repeat(32),
    encryptionKey: "b".repeat(64),
  });
  Object.defineProperty(tg, "authenticated", { value: true });
  const cid = randomUUID(),
    own = randomUUID(),
    incoming = randomUUID();
  db.prepare(
    "INSERT INTO conversations(id,account_id,external_id,name,updated_at,unread) VALUES(?,'telegram-1','123','Test',?,2)",
  ).run(cid, new Date().toISOString());
  for (const [id, external, direction, text] of [
    [incoming, "70", "in", "question"],
    [own, "71", "out", "answer"],
  ])
    db.prepare(
      "INSERT INTO messages(id,conversation_id,external_id,direction,text,status,created_at,read_at) VALUES(?,?,?,?,?,'sent',?,'read')",
    ).run(id, cid, external, direction, text, new Date().toISOString());
  let fails = true,
    calls = 0,
    events = 0;
  store.messageDeleted = (id, c) => {
    assert.equal(id, own);
    assert.equal(c, cid);
    events++;
  };
  tg.client = {
    connected: true,
    invoke: async (request: unknown) => {
      calls++;
      assert.ok(request instanceof Api.messages.DeleteMessages);
      assert.deepEqual(request.id, [71]);
      assert.equal(request.revoke, true);
      if (fails) throw new Error("network");
      return new Api.messages.AffectedMessages({ pts: 1, ptsCount: 1 });
    },
    destroy: async () => {},
  } as unknown as TelegramClient;
  try {
    await assert.rejects(tg.deleteMessage(incoming), /своё/);
    assert.equal(calls, 0);
    await assert.rejects(tg.deleteMessage(own));
    assert.equal(store.messages(cid).length, 2);
    assert.equal(events, 0);
    fails = false;
    await tg.deleteMessage(own);
    assert.equal(events, 1);
    assert.equal(store.messages(cid).length, 1);
    assert.equal(store.conversation(cid).preview, "question");
    assert.equal(store.conversation(cid).unread, 2);
    assert.ok(
      (
        db
          .prepare("SELECT deleted_at,read_at FROM messages WHERE id=?")
          .get(own) as any
      ).deleted_at,
    );
    assert.equal(
      (db.prepare("SELECT read_at FROM messages WHERE id=?").get(own) as any)
        .read_at,
      "read",
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) n FROM outbox").get() as any).n,
      0,
    );
    await assert.rejects(tg.deleteMessage(own));
    assert.equal(calls, 2);
  } finally {
    await tg.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
