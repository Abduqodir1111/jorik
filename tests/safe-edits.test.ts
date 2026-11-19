import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/app.js";
import { generateOrderReport } from "../shared/order-report.js";
import { DraftSync } from "../src/draft-sync.js";
import { generateDeliveryWorksheet } from "../shared/delivery-export.js";
const base = {
  conversationId: null,
  client: "Synthetic",
  source: "Офлайн",
  date: "2026-11-20",
  phone: "+998901234567",
  deliveryType: "pickup",
  district: "",
  address: "",
  coordinates: "",
  amount: 100,
  isPaid: false,
  items: "Book",
};
async function fixture(
  run: (
    ctx: Awaited<ReturnType<typeof createApp>>,
    dir: string,
  ) => Promise<void>,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-safe-edits-"));
  const ctx = await createApp({
    dataDir: dir,
    mode: "demo",
    localAccess: true,
    worker: false,
  });
  try {
    await run(ctx, dir);
  } finally {
    await ctx.app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
test("Order create retries are persistent, same-key edits conflict, and every mutation requires a current version", () =>
  fixture(async ({ app, db }, dir) => {
    const key = randomUUID(),
      headers = { "Idempotency-Key": key };
    const replies = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({
          method: "POST",
          url: "/api/orders",
          headers,
          payload: base,
        }),
      ),
    );
    assert.equal(replies.filter((r) => r.statusCode === 201).length, 1);
    assert.equal(replies.filter((r) => r.statusCode === 200).length, 4);
    const order = replies[0].json();
    assert.ok(replies.every((r) => r.json().id === order.id));
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/orders",
          headers,
          payload: { ...base, amount: 200 },
        })
      ).statusCode,
      409,
    );
    for (const [method, suffix, payload] of [
      ["PUT", "", base],
      ["PATCH", "/refused", { refused: true }],
      ["DELETE", "", undefined],
    ] as const)
      assert.equal(
        (
          await app.inject({
            method,
            url: "/api/orders/" + order.id + suffix,
            payload,
          })
        ).statusCode,
        428,
      );
    const changed = await app.inject({
      method: "PUT",
      url: "/api/orders/" + order.id,
      headers: { "If-Match": JSON.stringify(order.updatedAt) },
      payload: { ...base, amount: 200 },
    });
    assert.equal(changed.statusCode, 200);
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: "/api/orders/" + order.id,
          headers: { "If-Match": JSON.stringify(order.updatedAt) },
          payload: base,
        })
      ).statusCode,
      409,
    );
    // Reopen the database to prove replay protection is not process-local.
    const Database = (await import("better-sqlite3")).default;
    const other = new Database(path.join(dir, "demo.sqlite"));
    assert.equal(
      (
        other
          .prepare("SELECT order_id FROM order_requests WHERE key=?")
          .get(key) as any
      ).order_id,
      order.id,
    );
    other.close();
    assert.equal(
      (db.prepare("SELECT count(*) n FROM orders").get() as any).n,
      1,
    );
    // A deleted order must not be recreated by a delayed replay.
    await app.inject({
      method: "DELETE",
      url: "/api/orders/" + order.id,
      headers: { "If-Match": JSON.stringify(changed.json().updatedAt) },
    });
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/orders",
          headers,
          payload: base,
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (db.prepare("SELECT count(*) n FROM orders").get() as any).n,
      0,
    );
  }));
test("Shop identity survives account renames, subsequent edits, SQL exports and browser worksheet filters", () =>
  fixture(async ({ app, store, db }) => {
    db.prepare(
      "UPDATE accounts SET name='STOREBOOKS' WHERE id='telegram-1'",
    ).run();
    const cid = store.incoming("telegram-1", {
      externalConversationId: "safe",
      externalMessageId: "1",
      name: "Synthetic",
      username: "synthetic",
      text: "hi",
    });
    const create = async () =>
      (
        await app.inject({
          method: "POST",
          url: "/api/orders",
          payload: {
            ...base,
            conversationId: cid,
            deliveryType: "delivery",
            district: "Мирабад",
          },
        })
      ).json();
    const old = await create();
    assert.equal(old.storeId, "STOREBOOKS");
    db.prepare(
      "UPDATE accounts SET name='Renamed shop' WHERE id='telegram-1'",
    ).run();
    const fresh = await create();
    assert.equal(fresh.storeId, "STOREBOOKS");
    const { id, refused, createdAt, updatedAt, ...input } = old;
    const edited = await app.inject({
      method: "PUT",
      url: "/api/orders/" + id,
      headers: { "If-Match": JSON.stringify(updatedAt) },
      payload: { ...input, items: "Changed" },
    });
    assert.equal(edited.statusCode, 200);
    assert.equal(edited.json().storeId, "STOREBOOKS");
    const rows = (
      await app.inject(
        "/api/orders/export?startDate=2026-11-20&endDate=2026-11-20&scope=all&source=STOREBOOKS",
      )
    ).json();
    assert.equal(rows.length, 2);
    assert.equal(
      generateOrderReport(rows, {
        startDate: "2026-11-20",
        endDate: "2026-11-20",
        source: "STOREBOOKS",
      }).rows.length,
      2,
    );
    assert.equal(
      generateDeliveryWorksheet(rows, {
        startDate: "2026-11-20",
        endDate: "2026-11-20",
        source: "STOREBOOKS",
      }).rows.length,
      2,
    );
  }));
test("Draft CAS acknowledges replay, rejects old clients and competing devices, and invalidates drafts cleared by send", () =>
  fixture(async ({ app, store }) => {
    const cid = store.incoming("telegram-1", {
      externalConversationId: "draft",
      externalMessageId: "1",
      name: "Synthetic",
      username: "synthetic",
      text: "hi",
    });
    const write = (payload: any) =>
      app.inject({
        method: "PUT",
        url: `/api/conversations/${cid}/draft`,
        payload,
      });
    const first = { text: "First device", version: 0, key: randomUUID() };
    assert.equal((await write(first)).json().version, 1);
    assert.equal((await write(first)).json().version, 1);
    const competing = { text: "Keep my text", version: 0, key: randomUUID() };
    const conflict = await write(competing);
    assert.equal(conflict.statusCode, 409);
    assert.deepEqual(conflict.json().currentDraft, {
      text: first.text,
      version: 1,
    });
    assert.equal(
      (await write({ text: "legacy", revision: Date.now() * 1000 })).statusCode,
      428,
    );
    assert.equal((await write({ ...competing, version: 1 })).json().version, 2);
    store.enqueue(cid, "Sent", randomUUID());
    assert.equal(store.conversation(cid).draftVersion, 3);
    assert.equal(store.conversation(cid).draft, "");
    assert.equal(
      (await write({ ...first, version: 2, key: randomUUID() })).statusCode,
      409,
    );
  }));
test("DraftSync preserves in-flight edits, survives a lost acknowledgement and keeps conflicts until an explicit choice", async () => {
  let server = { text: "", version: 0, key: "" };
  let lost = false;
  let release: () => void = () => {};
  let wait = false;
  const sync = new DraftSync(async (_id, value) => {
    if (wait)
      await new Promise<void>((r) => {
        release = r;
      });
    if (server.key === value.key && server.text === value.text)
      return { version: server.version };
    if (value.version !== server.version)
      throw Object.assign(new Error("Conflict"), {
        currentDraft: { text: server.text, version: server.version },
      });
    server = { text: value.text, version: server.version + 1, key: value.key };
    if (lost) {
      lost = false;
      throw new Error("Lost response");
    }
    return { version: server.version };
  });
  sync.hydrate("chat", 0);
  sync.edit("chat", "first");
  lost = true;
  await assert.rejects(sync.flush());
  await sync.flush();
  assert.equal(server.version, 1);
  assert.equal(sync.pending.size, 0);
  sync.edit("chat", "during");
  wait = true;
  const saving = sync.flush();
  await new Promise((r) => setImmediate(r));
  sync.edit("chat", "latest");
  wait = false;
  release();
  await saving;
  assert.equal(server.text, "latest");
  assert.equal(sync.pending.size, 0);
  assert.equal(sync.hydrate("chat", 0), false);
  sync.edit("chat", "local");
  server = { text: "remote", version: server.version + 1, key: randomUUID() };
  await assert.rejects(sync.flush());
  assert.equal(sync.pending.get("chat")?.text, "local");
  await assert.rejects(sync.flush());
  sync.resolve("chat", true);
  await sync.flush();
  assert.equal(server.text, "local");
  sync.edit("chat", "another");
  server = {
    text: "choose remote",
    version: server.version + 1,
    key: randomUUID(),
  };
  await assert.rejects(sync.flush());
  assert.equal(sync.resolve("chat", false)?.text, "choose remote");
  assert.equal(sync.pending.size, 0);
});

test("Migration preserves existing drafts and records historical shop identity without rewriting message content", async () => {
  const Database = (await import("better-sqlite3")).default;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-migration-safe-"));
  const file = path.join(dir, "demo.sqlite");
  const db = new Database(file);
  try {
    db.exec("CREATE TABLE migrations(name TEXT PRIMARY KEY)");
    for (const name of fs
      .readdirSync("migrations")
      .filter((n) => /^\d{3}.*sql$/.test(n) && n < "022")
      .sort()) {
      db.exec(fs.readFileSync(path.join("migrations", name), "utf8"));
      db.prepare("INSERT INTO migrations VALUES(?)").run(name);
    }
    db.prepare(
      "INSERT INTO accounts(id,name,platform,adapter,mode,state,color) VALUES('telegram-1','STOREBOOKS','telegram','demo','demo','connected','#000')",
    ).run();
    const cid = randomUUID();
    db.prepare(
      "INSERT INTO conversations(id,account_id,external_id,name,updated_at,draft,draft_revision) VALUES(?,'telegram-1','old','Synthetic',?,'Keep draft',999999999999)",
    ).run(cid, new Date().toISOString());
    const old = { ...base, conversationId: cid, source: "Old alias" };
    db.prepare(
      "INSERT INTO orders(id,date,phone,data,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      base.date,
      base.phone,
      JSON.stringify(old),
      "2026-11-19",
      "2026-11-19",
    );
    const before = db
      .prepare("SELECT draft,draft_revision FROM conversations")
      .get();
    db.close();
    const { openDb } = await import("../server/db.js");
    const migrated = openDb(dir, "demo");
    try {
      assert.deepEqual(
        migrated
          .prepare("SELECT draft,draft_revision FROM conversations")
          .get(),
        before,
      );
      assert.equal(
        (
          migrated
            .prepare("SELECT draft_version n FROM conversations")
            .get() as any
        ).n,
        0,
      );
      const data = JSON.parse(
        (migrated.prepare("SELECT data FROM orders").get() as any).data,
      );
      assert.deepEqual(data, { ...old, storeId: "STOREBOOKS" });
      assert.equal(migrated.pragma("integrity_check", { simple: true }), "ok");
    } finally {
      migrated.close();
    }
  } finally {
    if (db.open) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
