import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bigInt from "big-integer";
import { Api, TelegramClient } from "teleproto";
import { openDb } from "../server/db.js";
import { Store } from "../server/store.js";
import { seal } from "../server/secrets.js";
import { TelegramIntegration } from "../server/telegram.js";
import { InstagramIntegration } from "../server/instagram.js";
import {
  recoveryDelay,
  recoveryCode,
  telegramNeedsLogin,
} from "../server/integration-recovery.js";
const flush = async () => {
  await new Promise(setImmediate);
  await new Promise(setImmediate);
};
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-recovery-"));
  const db = openDb(dir, "real");
  return { dir, db, s: new Store(db) };
}
function tgFixture() {
  const f = fixture();
  const key = "b".repeat(64);
  f.db
    .prepare("INSERT INTO telegram_sessions(account_id,ciphertext) VALUES(?,?)")
    .run("telegram-1", seal("saved-session", key, "telegram-1"));
  return {
    ...f,
    tg: new TelegramIntegration(f.s, {
      apiId: 1,
      apiHash: "a".repeat(32),
      encryptionKey: key,
    }),
  };
}
test("Recovery backoff is bounded, honors provider waits and never exposes arbitrary errors", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 20].map((n) => recoveryDelay(n)),
    [5000, 10000, 20000, 40000, 60000, 60000],
  );
  assert.equal(recoveryDelay(1, 120000), 120000);
  assert.equal(
    recoveryCode(
      new Error(
        "Cannot send requests while disconnected. Please connect first.",
      ),
    ),
    "DISCONNECTED",
  );
  assert.equal(
    recoveryCode(Object.assign(new Error("private"), { name: "TimeoutError" })),
    "TIMEOUT",
  );
  assert.equal(
    recoveryCode(new Error("SECRET token customer payload")),
    "NETWORK_OR_PROVIDER_ERROR",
  );
  assert.equal(telegramNeedsLogin({ errorMessage: "SESSION_REVOKED" }), true);
  assert.equal(telegramNeedsLogin({ code: "ETIMEDOUT" }), false);
});
test("Telegram cold start retries offline sessions, replaces dead clients, catches up without duplicates and leaves unknown sends alone", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { dir, db, s, tg } = tgFixture();
  let online = false,
    clients = 0,
    destroys = 0,
    imports = 0;
  const internal = tg as any;
  internal.newClient = (session: string) => {
    assert.equal(session, "saved-session");
    clients++;
    const c = {
      connected: false,
      connect: async () => {
        if (!online) throw { code: "ETIMEDOUT" };
        c.connected = true;
      },
      invoke: async () => ({}),
      destroy: async () => {
        destroys++;
        c.connected = false;
      },
      session: { save: () => session },
      iterDialogs: async function* () {},
    };
    tg.client = c as unknown as TelegramClient;
    return c;
  };
  internal.difference = async () => {
    imports++;
    db.prepare("INSERT OR IGNORE INTO telegram_peers VALUES(?,?,?,?,?)").run(
      "telegram-1",
      "123",
      "456",
      "Клиент",
      "client",
    );
    await internal.importMessage(
      new Api.Message({
        id: 1,
        peerId: new Api.PeerUser({ userId: bigInt(123) }),
        date: Math.floor(Date.now() / 1000),
        message: "missed",
      }),
      true,
    );
  };
  try {
    tg.restore();
    await flush();
    assert.equal(clients, 1);
    assert.equal(s.account("telegram-1").state, "offline");
    assert.equal(tg.status().recovery.attempt, 1);
    t.mock.timers.tick(5000);
    await flush();
    assert.equal(clients, 2);
    assert.equal(tg.status().recovery.attempt, 2);
    online = true;
    t.mock.timers.tick(10000);
    await flush();
    assert.equal(clients, 3);
    assert.equal(tg.status().connected, true);
    assert.equal(tg.status().error, null);
    assert.equal(imports, 1);
    const conv = s.conversations()[0];
    assert.equal(s.messages(conv.id).length, 1);
    assert.equal(conv.unread, 1);
    const mid = s.enqueue(conv.id, "uncertain", "uncertain-send");
    db.prepare("UPDATE outbox SET state='unknown' WHERE message_id=?").run(mid);
    db.prepare("UPDATE messages SET status='unknown' WHERE id=?").run(mid);
    (tg.client as any).connected = false;
    const a = tg.sync(),
      b = tg.sync();
    assert.equal(a, b);
    await a;
    assert.equal(clients, 4);
    assert.equal(destroys, 3);
    assert.equal(
      s.messages(conv.id).filter((m) => m.direction === "in").length,
      1,
    );
    assert.equal(s.conversation(conv.id).unread, 1);
    assert.equal(
      (
        db
          .prepare("SELECT state FROM outbox WHERE message_id=?")
          .get(mid) as any
      ).state,
      "unknown",
    );
    await tg.close();
    t.mock.timers.tick(300000);
    await flush();
    assert.equal(clients, 4);
  } finally {
    await tg.close();
    t.mock.timers.reset();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("Telegram revoked sessions stop retries without deleting credentials", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { dir, db, s, tg } = tgFixture();
  let clients = 0;
  (tg as any).newClient = () => {
    clients++;
    const c = {
      connected: true,
      connect: async () => {},
      invoke: async () => {
        throw { errorMessage: "SESSION_REVOKED" };
      },
      destroy: async () => {},
    };
    tg.client = c as unknown as TelegramClient;
    return c;
  };
  try {
    tg.restore();
    await flush();
    assert.equal(s.account("telegram-1").state, "unconfigured");
    assert.equal(tg.status().recovery.requiresLogin, true);
    assert.equal(tg.status().recovery.nextAttemptAt, null);
    t.mock.timers.tick(300000);
    await flush();
    assert.equal(clients, 1);
    assert.ok(db.prepare("SELECT 1 FROM telegram_sessions").get());
  } finally {
    await tg.close();
    t.mock.timers.reset();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("Telegram shutdown during connect cannot resurrect a client", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { dir, db, tg } = tgFixture();
  let release!: () => void;
  let clients = 0;
  (tg as any).newClient = () => {
    clients++;
    const c = {
      connected: false,
      connect: () =>
        new Promise<void>((r) => {
          release = r;
        }),
      invoke: async () => {
        throw Error("must not authorize after close");
      },
      destroy: async () => {
        release?.();
      },
    };
    tg.client = c as unknown as TelegramClient;
    return c;
  };
  try {
    tg.restore();
    await flush();
    await tg.close();
    t.mock.timers.tick(300000);
    await flush();
    assert.equal(clients, 1);
    assert.equal(tg.status().connected, false);
  } finally {
    await tg.close();
    t.mock.timers.reset();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("Telegram provider cooldown prevents early network calls", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { dir, db, tg } = tgFixture();
  let requests = 0;
  (tg as any).authenticated = true;
  tg.client = {
    connected: true,
    destroy: async () => {},
  } as unknown as TelegramClient;
  (tg as any).syncConnected = async () => {
    requests++;
    throw { errorMessage: "FLOOD_WAIT", seconds: 120 };
  };
  try {
    await assert.rejects(tg.sync());
    assert.equal(tg.status().recovery.nextAttemptAt! - Date.now(), 120000);
    t.mock.timers.tick(119000);
    await flush();
    assert.equal(requests, 1);
  } finally {
    await tg.close();
    t.mock.timers.reset();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("Instagram retries after network loss, catches up once and continues webhook-only operation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { dir, db, s } = fixture();
  let online = false,
    checks = 0,
    archives = 0;
  const now = Date.now();
  const since = new Date(now - 120000).toISOString();
  db.prepare("UPDATE accounts SET last_sync=? WHERE id=?").run(
    since,
    "instagram-1",
  );
  const ig = new InstagramIntegration(s, {
    token: "NEVER_LOG_TOKEN",
    receiveMode: "webhook",
    fetcher: (async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/me")) {
        checks++;
        if (!online) throw Error("NEVER_LOG_TOKEN");
        return Response.json({
          id: "page",
          instagram_business_account: { id: "shop", username: "shop" },
        });
      }
      if (u.pathname.endsWith("/conversations")) {
        archives++;
        return Response.json({
          data: [{ id: "thread", updated_time: new Date(now).toISOString() }],
        });
      }
      assert.ok(u.searchParams.get("fields")?.includes("messages.limit(30)"));
      return Response.json({
        id: "thread",
        updated_time: new Date(now).toISOString(),
        participants: {
          data: [{ id: "shop" }, { id: "customer", name: "Клиент" }],
        },
        messages: {
          data: [
            {
              id: "missed",
              created_time: new Date(now - 60000).toISOString(),
              from: { id: "customer" },
              message: "new",
            },
            {
              id: "old",
              created_time: new Date(now - 300000).toISOString(),
              from: { id: "customer" },
              message: "old",
            },
          ],
        },
      });
    }) as typeof fetch,
  });
  try {
    ig.start();
    await assert.rejects(ig.sync());
    assert.equal(checks, 1);
    assert.equal(ig.recoveryStatus().attempt, 1);
    online = true;
    t.mock.timers.tick(5000);
    await flush();
    assert.equal(s.account("instagram-1").state, "connected");
    assert.equal(archives, 1);
    assert.equal(s.conversations()[0].unread, 1);
    assert.equal(s.messages(s.conversations()[0].id).length, 2);
    t.mock.timers.tick(60000);
    await flush();
    assert.equal(checks, 3);
    assert.equal(archives, 1); // Health checks do not poll the archive.
    online = false;
    t.mock.timers.tick(60000);
    await flush();
    assert.equal(ig.recoveryStatus().attempt, 1);
    online = true;
    t.mock.timers.tick(5000);
    await flush();
    assert.equal(archives, 2);
    assert.equal(s.messages(s.conversations()[0].id).length, 2);
    assert.equal(s.conversations()[0].unread, 1);
    await ig.close();
    const before = checks;
    t.mock.timers.tick(300000);
    await flush();
    assert.equal(checks, before);
  } finally {
    await ig.close();
    t.mock.timers.reset();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("Instagram revoked tokens stop checks; incoming webhooks do not hide the invalid send credential", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { dir, db, s } = fixture();
  let checks = 0;
  db.prepare("INSERT INTO instagram_identity VALUES(?,?,?,?)").run(
    "instagram-1",
    "page",
    "shop",
    "shop",
  );
  const ig = new InstagramIntegration(s, {
    token: "test",
    receiveMode: "webhook",
    fetcher: (async () => {
      checks++;
      return Response.json(
        { error: { code: 190, message: "secret" } },
        { status: 400 },
      );
    }) as typeof fetch,
  });
  try {
    ig.start();
    await assert.rejects(ig.sync());
    assert.equal(ig.recoveryStatus().requiresLogin, true);
    t.mock.timers.tick(300000);
    await flush();
    assert.equal(checks, 1);
    ig.receiveWebhook({
      id: "shop",
      messaging: [
        {
          sender: { id: "customer" },
          recipient: { id: "shop" },
          timestamp: Date.now(),
          message: { mid: "one", text: "hi" },
        },
      ],
    });
    assert.equal(s.account("instagram-1").state, "unconfigured");
    assert.equal(s.conversations().length, 1);
  } finally {
    await ig.close();
    t.mock.timers.reset();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Instagram respects rate-limit cooldown and limits failed catch-up to three recovery attempts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { dir, db, s } = fixture();
  let checks = 0,
    archives = 0,
    limited = true;
  db.prepare("UPDATE accounts SET last_sync=? WHERE id=?").run(
    new Date(Date.now() - 120000).toISOString(),
    "instagram-1",
  );
  const ig = new InstagramIntegration(s, {
    token: "test",
    receiveMode: "webhook",
    fetcher: (async (url: string) => {
      if (new URL(url).pathname.endsWith("/me")) {
        checks++;
        if (limited)
          return Response.json({ error: { code: 4 } }, { status: 429 });
        return Response.json({
          id: "page",
          instagram_business_account: { id: "shop", username: "shop" },
        });
      }
      archives++;
      throw Error("network unavailable during catch-up");
    }) as typeof fetch,
  });
  try {
    ig.start();
    await assert.rejects(ig.sync());
    assert.equal(ig.recoveryStatus().nextAttemptAt! - Date.now(), 60000);
    t.mock.timers.tick(59999);
    await flush();
    assert.equal(checks, 1);
    limited = false;
    t.mock.timers.tick(1);
    await flush();
    assert.equal(archives, 1);
    t.mock.timers.tick(60000);
    await flush();
    assert.equal(archives, 2);
    t.mock.timers.tick(60000);
    await flush();
    assert.equal(archives, 3);
    t.mock.timers.tick(60000);
    await flush();
    assert.equal(archives, 3);
    assert.equal(s.account("instagram-1").state, "connected");
  } finally {
    await ig.close();
    t.mock.timers.reset();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Telegram applies an RPC deadline while preserving explicit call options", async (t) => {
  const { dir, db, tg } = tgFixture();
  let captured: any;
  t.mock.method(
    TelegramClient.prototype,
    "invoke",
    async (_request: any, _dc: any, options: any) => {
      captured = options;
      return new Api.updates.State({
        pts: 1,
        qts: 0,
        date: 1,
        seq: 1,
        unreadCount: 0,
      });
    },
  );
  try {
    const client = (tg as any).newClient() as TelegramClient;
    await client.invoke(new Api.updates.GetState());
    assert.equal(captured.timeout, 30000);
    await client.invoke(new Api.updates.GetState(), undefined, {
      timeout: 60000,
      maxRetryCount: 0,
    });
    assert.equal(captured.timeout, 60000);
    assert.equal(captured.maxRetryCount, 0);
  } finally {
    await tg.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Telegram network failure during authorization is retried, not mistaken for a revoked session", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { dir, db, s, tg } = tgFixture();
  let clients = 0;
  (tg as any).difference = async () => {};
  (tg as any).newClient = () => {
    const attempt = ++clients;
    const c = {
      connected: false,
      connect: async () => {
        c.connected = true;
      },
      invoke: async () => {
        if (attempt === 1) throw { code: "ETIMEDOUT" };
        return {};
      },
      session: { save: () => "" },
      iterDialogs: async function* () {},
      destroy: async () => {
        c.connected = false;
      },
    };
    tg.client = c as unknown as TelegramClient;
    return c;
  };
  try {
    tg.restore();
    await flush();
    assert.equal(tg.status().recovery.requiresLogin, false);
    assert.equal(s.account("telegram-1").state, "offline");
    t.mock.timers.tick(5000);
    await flush();
    assert.equal(clients, 2);
    assert.equal(s.account("telegram-1").state, "connected");
    assert.equal(tg.status().error, null);
  } finally {
    await tg.close();
    t.mock.timers.reset();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
