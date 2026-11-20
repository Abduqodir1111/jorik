import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../server/app.js";
import { hashToken } from "../server/auth.js";
import { InboxSyncClient } from "../src/inbox-sync.js";
import { coalesceAsync } from "../src/refresh-queue.js";
import type { InboxState } from "../shared/inbox-sync.js";

test("Inbox indexes preserve deleted/incoming/timestamp tie semantics", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-inbox-index-"));
  const ctx = await createApp({
    dataDir: dir,
    mode: "demo",
    localAccess: true,
    worker: false,
  });
  try {
    const ids = ["telegram-1", "instagram-1"].map((account) =>
      ctx.store.incoming(account, {
        externalConversationId: "same-contact",
        externalMessageId: "one",
        name: "Synthetic",
        username: "synthetic",
        text: "original",
      }),
    );
    const insert = ctx.db.prepare(
      "INSERT INTO messages(id,conversation_id,external_id,direction,text,status,created_at,deleted_at) VALUES(?,?,?,?,?,'sent',?,?)",
    );
    for (const id of ids) {
      insert.run(
        randomUUID(),
        id,
        "out-one",
        "out",
        "first tie",
        "2026-12-01T00:00:00.000Z",
        null,
      );
      insert.run(
        randomUUID(),
        id,
        "out-two",
        "out",
        "last tie",
        "2026-12-01T00:00:00.000Z",
        null,
      );
      insert.run(
        randomUUID(),
        id,
        "deleted-in",
        "in",
        "deleted latest incoming",
        "2026-12-02T00:00:00.000Z",
        "2026-12-02T00:01:00.000Z",
      );
      insert.run(
        randomUUID(),
        id,
        "deleted-out",
        "out",
        "must not preview",
        "2026-12-03T00:00:00.000Z",
        "2026-12-03T00:01:00.000Z",
      );
    }
    const indexed = ctx.store.conversations();
    assert.ok(
      indexed.every(
        (c) =>
          c.preview === "last tie" &&
          c.lastIncomingAt === "2026-12-02T00:00:00.000Z",
      ),
    );
    ctx.db.exec(
      "DROP INDEX messages_incoming_latest; DROP INDEX messages_visible_latest;",
    );
    assert.deepEqual(ctx.store.conversations(), indexed);
    ctx.db.exec(
      fs.readFileSync("migrations/024_inbox_lookup_indexes.sql", "utf8"),
    );
    assert.deepEqual(ctx.store.conversations(), indexed);
    const plan = ctx.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT (SELECT MAX(created_at) FROM messages WHERE conversation_id=c.id AND direction='in'),(SELECT text FROM messages WHERE conversation_id=c.id AND deleted_at IS NULL ORDER BY created_at DESC,rowid DESC LIMIT 1) FROM conversations c",
      )
      .all() as { detail: string }[];
    assert.ok(
      plan.some((p) =>
        p.detail.includes("COVERING INDEX messages_incoming_latest"),
      ),
    );
    assert.ok(
      plan.some((p) => p.detail.includes("INDEX messages_visible_latest")),
    );
  } finally {
    await ctx.app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "Five authenticated HTTP/SSE sellers send, read, create orders, resolve conflicts and reconnect without lost updates",
  { timeout: 30000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-inbox-workload-"));
    const ctx = await createApp({
      dataDir: dir,
      mode: "demo",
      worker: false,
      disableRateLimit: true,
    });
    const streams: AbortController[] = [],
      pumps: Promise<void>[] = [],
      errors: unknown[] = [],
      timings: number[] = [];
    const snapshots: (InboxState | undefined)[] = Array(5);
    const pending = new Set<Promise<void>>();
    const samples: {
      round: number;
      heapMiB: number;
      rssMiB: number;
      externalMiB: number;
    }[] = [];
    let active = true;
    try {
      const accounts = [
        "telegram-1",
        "telegram-2",
        "instagram-1",
        "instagram-2",
        "telegram-1",
      ];
      const ids = accounts.map((account, i) =>
        ctx.store.incoming(account, {
          externalConversationId: "seller-" + i,
          externalMessageId: "initial",
          name: "Synthetic " + i,
          username: "synthetic" + i,
          text: "initial",
        }),
      );
      const insertC = ctx.db.prepare(
        "INSERT INTO conversations(id,account_id,external_id,name,updated_at) VALUES(?,'telegram-1',?,?,'2026-11-10T00:00:00.000Z')",
      );
      const insertM = ctx.db.prepare(
        "INSERT INTO messages(id,conversation_id,external_id,direction,text,status,created_at) VALUES(?,?,?,'in','Synthetic history','sent','2026-11-10T00:00:00.000Z')",
      );
      ctx.db.transaction(() => {
        for (let n = 0; n < 495; n++) {
          const id = randomUUID();
          insertC.run(id, "extra-" + n, "Synthetic");
          for (let m = 0; m < 20; m++) insertM.run(randomUUID(), id, String(m));
        }
      })();
      const cookies = Array.from({ length: 5 }, () => {
        const token = randomUUID();
        ctx.db
          .prepare("INSERT INTO sessions VALUES(?,?)")
          .run(hashToken(token), Date.now() + 120000);
        return "session=" + token;
      });
      const base = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
      async function request(
        i: number,
        url: string,
        method = "GET",
        body?: unknown,
        headers: Record<string, string> = {},
      ) {
        const start = performance.now();
        const r = await fetch(base + "/api" + url, {
          method,
          headers: {
            Cookie: cookies[i],
            ...(body ? { "Content-Type": "application/json" } : {}),
            ...headers,
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(10000),
        });
        const data = await r.json();
        timings.push(performance.now() - start);
        return { status: r.status, data };
      }
      const clients = cookies.map(
        (_, i) =>
          new InboxSyncClient(async (url) => {
            const r = await request(i, url);
            assert.equal(r.status, 200);
            return r.data;
          }),
      );
      const updates = clients.map((client, i) =>
        coalesceAsync(async () => {
          const state = await client.read();
          if (active) snapshots[i] = state;
        }),
      );
      function update(i: number) {
        const task = updates[i]();
        pending.add(task);
        task.catch((e) => errors.push(e)).finally(() => pending.delete(task));
        return task;
      }
      async function connect(i: number) {
        const controller = new AbortController();
        streams[i] = controller;
        const r = await fetch(base + "/api/events", {
          headers: { Cookie: cookies[i] },
          signal: controller.signal,
        });
        assert.equal(r.status, 200);
        const reader = r.body!.getReader();
        const pump = (async () => {
          let buffer = "";
          const decoder = new TextDecoder();
          try {
            while (active) {
              const next = await reader.read();
              if (next.done) break;
              buffer += decoder.decode(next.value, { stream: true });
              let at;
              while ((at = buffer.indexOf("\n\n")) >= 0) {
                const event = buffer.slice(0, at);
                buffer = buffer.slice(at + 2);
                if (!event.startsWith("event:") && event.includes("data:"))
                  void update(i);
              }
            }
          } catch (e) {
            if (!controller.signal.aborted) errors.push(e);
          } finally {
            reader.releaseLock();
          }
        })();
        pumps.push(pump);
      }
      async function settled() {
        await Promise.all([...pending]);
      }
      async function until(check: () => boolean) {
        const deadline = Date.now() + 7000;
        while (!check()) {
          assert.equal(errors.length, 0, String(errors[0]));
          assert.ok(Date.now() < deadline, "SSE did not converge");
          await delay(20);
        }
        await settled();
      }
      await Promise.all(clients.map((_, i) => update(i)));
      await Promise.all(clients.map((_, i) => connect(i)));
      await until(() =>
        snapshots.every((s) => s?.conversations.length === 500),
      );
      const orderBase = {
        conversationId: null,
        client: "Synthetic customer",
        source: "Офлайн",
        date: "2026-11-24",
        phone: "+998901234567",
        deliveryType: "pickup",
        district: "",
        address: "",
        coordinates: "",
        amount: 100000,
        isPaid: false,
        items: "Synthetic book",
      };
      const outgoing: string[] = [];
      const rounds = Number(process.env.JORIK_WORKLOAD_ROUNDS ?? 20);
      assert.ok(Number.isInteger(rounds) && rounds >= 20 && rounds <= 200);
      for (let round = 0; round < rounds; round++) {
        await Promise.all(
          clients.map(async (_, i) => {
            const id = ids[i],
              key = randomUUID();
            ctx.store.incoming(accounts[i], {
              externalConversationId: "seller-" + i,
              externalMessageId: "incoming-" + round,
              name: "Synthetic " + i,
              username: "synthetic" + i,
              text: "incoming " + round,
            });
            const boundary = ctx.store
              .messages(id)
              .filter((m) => m.direction === "in")
              .at(-1)!;
            assert.equal(
              (
                await request(i, `/conversations/${id}/read`, "POST", {
                  unread: false,
                  throughId: boundary.id,
                })
              ).status,
              200,
            );
            const body = { text: `seller ${i} round ${round}`, key };
            const sent = await request(
              i,
              `/conversations/${id}/messages`,
              "POST",
              body,
            );
            assert.equal(sent.status, 200);
            outgoing.push(sent.data.id);
            assert.equal(
              (await request(i, `/conversations/${id}/messages`, "POST", body))
                .data.id,
              sent.data.id,
            );
            const orderKey = randomUUID();
            const order = await request(i, "/orders", "POST", orderBase, {
              "Idempotency-Key": orderKey,
            });
            assert.equal(order.status, 201);
            const duplicate = await request(i, "/orders", "POST", orderBase, {
              "Idempotency-Key": orderKey,
            });
            assert.equal(duplicate.status, 200);
            assert.equal(duplicate.data.id, order.data.id);
            assert.equal(
              (await request(i, `/conversations/${id}/messages?limit=40`))
                .status,
              200,
            );
          }),
        );
        for (let i = 0; i < 5; i++) await ctx.store.tick();
        if (round % 10 === 9) {
          await settled();
          global.gc?.();
          samples.push({
            round,
            heapMiB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024),
            externalMiB: Math.round(
              process.memoryUsage().external / 1024 / 1024,
            ),
          });
        }
      }
      await until(() =>
        snapshots.every((s) =>
          ids.every((id) =>
            s?.conversations
              .find((c) => c.id === id)
              ?.preview.includes(`round ${rounds - 1}`),
          ),
        ),
      );
      for (const id of outgoing) {
        const message = ctx.db
          .prepare("SELECT status FROM messages WHERE id=?")
          .get(id) as { status: string };
        assert.equal(message.status, "sent");
      }
      assert.equal(
        ctx.db.prepare("SELECT count(*) AS n FROM orders").get()!.n,
        5 * rounds,
      );
      assert.equal(
        ctx.db.prepare("SELECT count(*) AS n FROM outbox").get()!.n,
        5 * rounds,
      );
      const version = ctx.store.conversation(ids[0]).draftVersion!;
      const writes = await Promise.all(
        clients.map((_, i) =>
          request(i, `/conversations/${ids[0]}/draft`, "PUT", {
            text: "Seller " + i,
            version,
            key: randomUUID(),
          }),
        ),
      );
      assert.equal(writes.filter((r) => r.status === 200).length, 1);
      assert.equal(writes.filter((r) => r.status === 409).length, 4);
      streams[4].abort();
      await delay(30);
      ctx.store.incoming(accounts[4], {
        externalConversationId: "seller-4",
        externalMessageId: "missed",
        name: "Synthetic 4",
        username: "synthetic4",
        text: "while disconnected",
      });
      await connect(4);
      await until(() =>
        snapshots.every(
          (s) =>
            s?.conversations.find((c) => c.id === ids[4])?.preview ===
            "while disconnected",
        ),
      );
      const canonical = (await request(0, "/state")).data as InboxState;
      await Promise.all(clients.map((_, i) => update(i)));
      for (const snapshot of snapshots) assert.deepEqual(snapshot, canonical);
      assert.equal(errors.length, 0, String(errors[0]));
      timings.sort((a, b) => a - b);
      console.log(
        JSON.stringify({
          syntheticOnly: true,
          operators: 5,
          conversations: 500,
          orders: 5 * rounds,
          uniqueSends: 5 * rounds,
          requests: timings.length,
          p50Ms: Math.round(timings[Math.floor(timings.length * 0.5)]),
          p95Ms: Math.round(timings[Math.floor(timings.length * 0.95)]),
          samples,
          gcAvailable: !!global.gc,
          reconnect: true,
          converged: true,
        }),
      );
    } finally {
      active = false;
      streams.forEach((c) => c.abort());
      await Promise.allSettled(pumps);
      await Promise.allSettled([...pending]);
      await ctx.app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
