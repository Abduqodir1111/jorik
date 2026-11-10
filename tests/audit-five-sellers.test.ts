import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { ServerResponse } from "node:http";
import { createApp } from "../server/app.js";
import { hashToken } from "../server/auth.js";
import { sendEvent } from "../server/event-stream.js";
import { reconcileList } from "../src/reconcile-list.js";
const base = {
  conversationId: null,
  client: "Synthetic customer",
  source: "Офлайн",
  date: "2026-11-10",
  phone: "+998901234567",
  deliveryType: "pickup",
  district: "",
  address: "",
  coordinates: "",
  amount: 100000,
  isPaid: false,
  items: "Synthetic book",
};
async function fixture(
  run: (ctx: Awaited<ReturnType<typeof createApp>>) => Promise<void>,
) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-audit-"));
  const ctx = await createApp({
    dataDir,
    mode: "demo",
    worker: false,
    disableRateLimit: true,
  });
  try {
    await run(ctx);
  } finally {
    await ctx.app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
function cookies(db: Awaited<ReturnType<typeof createApp>>["db"]) {
  return Array.from({ length: 5 }, () => {
    const token = randomUUID();
    db.prepare("INSERT INTO sessions VALUES(?,?)").run(
      hashToken(token),
      Date.now() + 60000,
    );
    return { session: token };
  });
}
test("Five sellers cannot overwrite, refuse or delete an order using a stale version", async () =>
  fixture(async ({ app, db }) => {
    const sellers = cookies(db),
      created = await app.inject({
        method: "POST",
        url: "/api/orders",
        cookies: sellers[0],
        payload: base,
      });
    assert.equal(created.statusCode, 201);
    const order = created.json(),
      headers = { "If-Match": JSON.stringify(order.updatedAt) };
    const writes = await Promise.all(
      sellers.map((cookie, i) =>
        app.inject({
          method: "PUT",
          url: "/api/orders/" + order.id,
          cookies: cookie,
          headers,
          payload: { ...base, items: "Seller " + i },
        }),
      ),
    );
    assert.equal(writes.filter((r) => r.statusCode === 200).length, 1);
    assert.equal(writes.filter((r) => r.statusCode === 409).length, 4);
    const current = writes.find((r) => r.statusCode === 200)!.json();
    assert.ok(current.updatedAt > order.updatedAt);
    for (const [method, suffix, payload] of [
      ["PATCH", "/refused", { refused: true }],
      ["DELETE", "", undefined],
    ] as const) {
      const r = await app.inject({
        method,
        url: "/api/orders/" + order.id + suffix,
        cookies: sellers[1],
        headers,
        payload,
      });
      assert.equal(r.statusCode, 409);
    }
    const valid = await app.inject({
      method: "PATCH",
      url: "/api/orders/" + order.id + "/refused",
      cookies: sellers[2],
      headers: { "If-Match": JSON.stringify(current.updatedAt) },
      payload: { refused: true },
    });
    assert.equal(valid.statusCode, 200);
    assert.ok(valid.json().updatedAt > current.updatedAt);
  }));
test("Reading a rendered message keeps newer unseen arrivals unread, including equal timestamps", async () =>
  fixture(async ({ app, store, db }) => {
    const seller = cookies(db)[0],
      id = store.incoming("telegram-1", {
        externalConversationId: "read-race",
        externalMessageId: "1",
        name: "Synthetic",
        username: "test",
        text: "first",
      });
    const first = store.messages(id)[0];
    store.incoming("telegram-1", {
      externalConversationId: "read-race",
      externalMessageId: "2",
      name: "Synthetic",
      username: "test",
      text: "second",
    });
    db.prepare("UPDATE messages SET created_at=? WHERE conversation_id=?").run(
      first.createdAt,
      id,
    );
    const read = await app.inject({
      method: "POST",
      url: "/api/conversations/" + id + "/read",
      cookies: seller,
      payload: { unread: false, throughId: first.id },
    });
    assert.equal(read.statusCode, 200);
    assert.equal(store.conversation(id).unread, 1);
    const other = store.incoming("telegram-2", {
      externalConversationId: "other",
      externalMessageId: "3",
      name: "Other",
      username: "other",
      text: "other",
    });
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/conversations/" + other + "/read",
          cookies: seller,
          payload: { unread: false, throughId: first.id },
        })
      ).statusCode,
      400,
    );
    const latest = store.messages(id).at(-1)!;
    await app.inject({
      method: "POST",
      url: "/api/conversations/" + id + "/read",
      cookies: seller,
      payload: { unread: false, throughId: latest.id },
    });
    assert.equal(store.conversation(id).unread, 0);
  }));
test("Single-message operations do not deserialize unrelated history and preserve quotes", async () =>
  fixture(async ({ store, db }) => {
    const id = store.incoming("telegram-1", {
        externalConversationId: "single",
        externalMessageId: "1",
        name: "Synthetic",
        username: "test",
        text: "quote",
      }),
      first = store.messages(id)[0];
    store.incoming("telegram-1", {
      externalConversationId: "single",
      externalMessageId: "2",
      name: "Synthetic",
      username: "test",
      text: "unrelated",
    });
    db.prepare(
      "UPDATE messages SET attachments='broken' WHERE external_id='2' AND conversation_id=?",
    ).run(id);
    const reply = store.enqueue(id, "reply", randomUUID(), {
      replyToId: first.id,
    });
    assert.equal(store.message(id, reply)?.reply_to?.text, "quote");
    assert.equal(store.message(id, first.id)?.text, "quote");
    assert.equal(store.message("other", reply), undefined);
    store.publishMessage(reply, id);
    await store.tick();
    assert.equal(store.message(id, reply)?.status, "sent");
  }));
test("Five authenticated sellers browse 500 chats and 10000 messages without provider calls", async () =>
  fixture(async ({ app, db }) => {
    const sellers = cookies(db),
      ids: string[] = [];
    const conv = db.prepare(
        "INSERT INTO conversations(id,account_id,external_id,name,updated_at) VALUES(?,?,?,?,?)",
      ),
      msg = db.prepare(
        "INSERT INTO messages(id,conversation_id,external_id,direction,text,status,created_at) VALUES(?,?,?,'in',?,'sent',?)",
      );
    db.transaction(() => {
      for (let i = 0; i < 500; i++) {
        const id = randomUUID();
        ids.push(id);
        conv.run(
          id,
          "telegram-1",
          String(i),
          "Synthetic " + i,
          "2026-11-10T10:00:00.000Z",
        );
        for (let m = 0; m < 20; m++)
          msg.run(
            randomUUID(),
            id,
            String(m),
            "Synthetic message " + m,
            "2026-11-10T10:00:00.000Z",
          );
      }
    })();
    const timings: number[] = [];
    const start = performance.now();
    await Promise.all(
      sellers.map(async (cookie, i) => {
        for (let n = 0; n < 12; n++) {
          for (const url of [
            "/api/state",
            "/api/conversations/" + ids[i] + "/messages?limit=40",
            "/api/orders",
          ]) {
            const at = performance.now(),
              r = await app.inject({ url, cookies: cookie });
            assert.equal(r.statusCode, 200);
            timings.push(performance.now() - at);
            if (url === "/api/state")
              assert.equal(r.json().conversations.length, 500);
          }
        }
      }),
    );
    timings.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        syntheticOnly: true,
        sellers: 5,
        conversations: 500,
        messages: 10000,
        requests: timings.length,
        totalMs: Math.round(performance.now() - start),
        p95Ms: Math.round(timings[Math.floor(timings.length * 0.95)]),
        rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      }),
    );
  }));
test("Unchanged rows retain render references while changes and reordering remain visible", () => {
  const old = [
    { id: "a", name: "A", nested: { online: true } },
    { id: "b", name: "B", nested: { online: true } },
  ];
  assert.equal(reconcileList(old, structuredClone(old)), old);
  const next = reconcileList(old, [
    { ...old[1], name: "changed" },
    structuredClone(old[0]),
  ]);
  assert.equal(next[1], old[0]);
  assert.equal(next[0].name, "changed");
  assert.notEqual(next[0], old[1]);
});
test("Slow SSE consumers disconnect without buffering or affecting the other four sellers", () => {
  let delivered = 0,
    destroyed = 0;
  const clients = new Set<ServerResponse>();
  for (let i = 0; i < 5; i++)
    clients.add({
      write: () => {
        if (i === 0) return false;
        delivered++;
        return true;
      },
      destroy: () => {
        destroyed++;
      },
    } as unknown as ServerResponse);
  for (const client of clients) sendEvent(clients, client, "data: changed\n\n");
  assert.equal(clients.size, 4);
  assert.equal(delivered, 4);
  assert.equal(destroyed, 1);
});

test("Five sellers cannot overwrite quick replies from a stale settings snapshot", async () =>
  fixture(async ({ app, db }) => {
    const sellers = cookies(db);
    const state = (
      await app.inject({ url: "/api/state", cookies: sellers[0] })
    ).json();
    const headers = { "If-Match": JSON.stringify(state.quickRepliesVersion) };
    const results = await Promise.all(
      sellers.map((cookie, i) =>
        app.inject({
          method: "PUT",
          url: "/api/quick-replies",
          cookies: cookie,
          headers,
          payload: [{ id: "slot", title: "Seller " + i, text: "reply" }],
        }),
      ),
    );
    assert.equal(results.filter((r) => r.statusCode === 200).length, 1);
    assert.equal(results.filter((r) => r.statusCode === 409).length, 4);
    const version = results.find((r) => r.statusCode === 200)!.json().version;
    assert.notEqual(version, state.quickRepliesVersion);
    assert.equal(
      (await app.inject({ url: "/api/state", cookies: sellers[1] })).json()
        .quickRepliesVersion,
      version,
    );
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: "/api/quick-replies",
          cookies: sellers[0],
          headers: { "If-Match": JSON.stringify(version) },
          payload: [],
        })
      ).statusCode,
      200,
    );
  }));
