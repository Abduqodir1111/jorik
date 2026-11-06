import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import * as webpush from "web-push";
import { openDb } from "../server/db.js";
import { Store } from "../server/store.js";
import { PushService, loadVapid, validPushEndpoint } from "../server/push.js";
import { createApp } from "../server/app.js";
import { hashPassword } from "../server/auth.js";
const endpoint = "https://fcm.googleapis.com/fcm/send/test-device";
const subscription = {
  endpoint,
  keys: { p256dh: "A".repeat(87), auth: "A".repeat(22) },
};
function fixture(sender: typeof webpush.sendNotification) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-push-"));
  const db = openDb(dir, "demo");
  db.prepare("INSERT INTO sessions(token_hash,expires_at) VALUES(?,?)").run(
    "device",
    Date.now() + 3600000,
  );
  db.prepare(
    "INSERT INTO push_subscriptions(endpoint,session_hash,subscription,updated_at) VALUES(?,?,?,?)",
  ).run(endpoint, "device", JSON.stringify(subscription), Date.now());
  const push = new PushService(
    db,
    loadVapid(dir),
    "https://example.org",
    sender,
  );
  const store = new Store(
    db,
    () => {},
    (event) => {
      if (event) push.enqueue(event);
    },
  );
  const incoming = () =>
    store.incoming("telegram-1", {
      externalConversationId: "peer",
      externalMessageId: "msg1",
      name: "Client",
      username: "client",
      text: "Hello",
    });
  return {
    db,
    push,
    store,
    incoming,
    close: async () => {
      await push.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("push queue is durable, deduplicates incoming, and carries the correct deep link", async () => {
  const sent: unknown[] = [];
  const f = fixture((async (sub, payload) => {
    sent.push(JSON.parse(String(payload)));
    return { statusCode: 201, body: "", headers: {} };
  }) as typeof webpush.sendNotification);
  try {
    const id = f.incoming();
    f.incoming();
    assert.equal(f.db.prepare("SELECT count(*) n FROM push_jobs").get()!.n, 1);
    await f.push.flush();
    assert.equal(sent.length, 1);
    assert.equal((sent[0] as any).url, "/?conversation=" + id);
    assert.equal((sent[0] as any).body, "Hello");
    assert.equal(f.db.prepare("SELECT count(*) n FROM push_jobs").get()!.n, 0);
    await f.push.flush();
    assert.equal(sent.length, 1);
  } finally {
    await f.close();
  }
});
test("expired push endpoint is removed; transient failure is retried; logout prevents delivery", async () => {
  let status = 503;
  let calls = 0;
  const f = fixture((async () => {
    calls++;
    throw { statusCode: status };
  }) as typeof webpush.sendNotification);
  try {
    f.incoming();
    await f.push.flush();
    assert.equal(calls, 1);
    assert.equal(
      (f.db.prepare("SELECT attempts FROM push_jobs").get() as any).attempts,
      1,
    );
    await f.push.flush();
    assert.equal(calls, 1);
    f.db.prepare("UPDATE push_jobs SET next_attempt=0").run();
    status = 410;
    await f.push.flush();
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM push_subscriptions").get()!.n,
      0,
    );
    assert.equal(f.db.prepare("SELECT count(*) n FROM push_jobs").get()!.n, 0);
  } finally {
    await f.close();
  }
  const g = fixture((async () => {
    throw Error("must not send after logout");
  }) as typeof webpush.sendNotification);
  try {
    g.incoming();
    g.db.prepare("DELETE FROM sessions").run();
    await g.push.flush();
    assert.equal(g.db.prepare("SELECT count(*) n FROM push_jobs").get()!.n, 0);
  } finally {
    await g.close();
  }
});
test("push API requires login, validates endpoints, updates one device, and revokes on logout", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-push-api-"));
  const { app, db } = await createApp({
    dataDir: dir,
    mode: "demo",
    worker: false,
  });
  try {
    db.prepare("INSERT INTO owner VALUES(1,?)").run(
      hashPassword("test-push-password"),
    );
    assert.equal((await app.inject("/api/push/config")).statusCode, 401);
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: "test-push-password" },
    });
    const headers = {
      cookie: String(login.headers["set-cookie"]).split(";")[0],
    };
    const key = (await app.inject({ url: "/api/push/config", headers })).json();
    assert.ok(key.publicKey);
    assert.equal(key.privateKey, undefined);
    for (let i = 0; i < 2; i++)
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/push/subscriptions",
            headers,
            payload: subscription,
          })
        ).statusCode,
        200,
      );
    assert.equal(
      db.prepare("SELECT count(*) n FROM push_subscriptions").get()!.n,
      1,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/push/subscriptions",
          headers,
          payload: { ...subscription, endpoint: "https://127.0.0.1/internal" },
        })
      ).statusCode,
      400,
    );
    await app.inject({
      method: "POST",
      url: "/api/logout",
      headers,
      payload: {},
    });
    assert.equal(
      db.prepare("SELECT count(*) n FROM push_subscriptions").get()!.n,
      0,
    );
    const sw = await app.inject("/sw.js");
    assert.equal(sw.statusCode, 200);
    assert.equal(sw.headers["cache-control"], "no-store");
    const first = loadVapid(dir),
      second = loadVapid(dir);
    assert.deepEqual(first, second);
    assert.equal(fs.statSync(path.join(dir, "vapid.json")).mode & 0o777, 0o600);
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("push endpoint allowlist rejects private hosts, credentials, suffix tricks and ports", () => {
  for (const host of [
    "https://web.push.apple.com/test",
    "https://updates.push.services.mozilla.com/test",
    endpoint,
  ])
    assert.equal(validPushEndpoint(host), true);
  for (const host of [
    "http://fcm.googleapis.com/test",
    "https://fcm.googleapis.com.evil.test/",
    "https://user@fcm.googleapis.com/",
    "https://fcm.googleapis.com:444/",
    "https://localhost/",
  ])
    assert.equal(validPushEndpoint(host), false);
});
test("service worker shows notifications and rejects external click destinations", async () => {
  const handlers: Record<string, Function> = {};
  let shown: any;
  let opened = "";
  let focused = false;
  let posted: any;
  let windows: any[] = [];
  const context = {
    self: {
      location: { origin: "https://inbox.example.org" },
      addEventListener: (name: string, fn: Function) => (handlers[name] = fn),
      registration: {
        showNotification: async (title: string, options: any) => {
          shown = { title, ...options };
        },
      },
      clients: {
        matchAll: async () => windows,
        openWindow: async (url: string) => {
          opened = url;
        },
      },
    },
    URL,
  };
  vm.runInNewContext(fs.readFileSync("public/sw.js", "utf8"), context);
  let task: Promise<unknown> = Promise.resolve();
  const waitUntil = (p: Promise<unknown>) => {
    task = p;
  };
  handlers.push({
    data: {
      json: () => ({
        title: "Client",
        body: "Message",
        url: "/?conversation=abc",
      }),
    },
    waitUntil,
  });
  await task;
  assert.equal(shown.data.url, "https://inbox.example.org/?conversation=abc");
  handlers.notificationclick({
    notification: { data: shown.data, close() {} },
    waitUntil,
  });
  await task;
  assert.equal(opened, shown.data.url);
  windows = [
    {
      url: "https://inbox.example.org/",
      postMessage: (data: any) => {
        posted = data;
      },
      focus: async () => {
        focused = true;
      },
    },
  ];
  handlers.notificationclick({
    notification: { data: shown.data, close() {} },
    waitUntil,
  });
  await task;
  assert.equal(posted.conversationId, "abc");
  assert.ok(focused);
  opened = "";
  handlers.notificationclick({
    notification: { data: { url: "https://evil.example/" }, close() {} },
    waitUntil,
  });
  await task;
  assert.equal(opened, "");
  handlers.push({
    data: {
      json: () => {
        throw Error();
      },
    },
    waitUntil,
  });
  await task;
  assert.equal(shown.title, "Jorik");
});
test("native Telegram and Instagram webhooks enqueue once; archive and outgoing events do not push", async () => {
  const { TelegramIntegration } = await import("../server/telegram.js");
  const { InstagramIntegration } = await import("../server/instagram.js");
  const { Api } = await import("teleproto");
  const { default: bigInt } = await import("big-integer");
  const f = fixture((async () => ({
    statusCode: 201,
    body: "",
    headers: {},
  })) as typeof webpush.sendNotification);
  const tg = new TelegramIntegration(f.store, {
    apiId: 1,
    apiHash: "a".repeat(32),
    encryptionKey: "b".repeat(64),
  });
  const ig = new InstagramIntegration(f.store, {
    token: "test",
    receiveMode: "webhook",
    fetcher: (async () =>
      Response.json({
        id: "page",
        instagram_business_account: { id: "shop", username: "shop" },
        data: [],
      })) as typeof fetch,
  });
  try {
    f.db
      .prepare("INSERT INTO telegram_peers VALUES(?,?,?,?,?)")
      .run("telegram-1", "123", "456", "Peer", "peer");
    const m = new Api.Message({
      id: 1,
      peerId: new Api.PeerUser({ userId: bigInt(123) }),
      date: Math.floor(Date.now() / 1000),
      message: "Telegram incoming",
    });
    await (tg as any).importMessage(m, true);
    await (tg as any).importMessage(m, true);
    assert.equal(f.db.prepare("SELECT count(*) n FROM push_jobs").get()!.n, 1);
    await (tg as any).importMessage(
      new Api.Message({ ...m, id: 2, out: true }),
      true,
    );
    await (tg as any).importMessage(new Api.Message({ ...m, id: 3 }), false);
    assert.equal(f.db.prepare("SELECT count(*) n FROM push_jobs").get()!.n, 1);
    await ig.sync();
    const entry = {
      id: "shop",
      messaging: [
        {
          sender: { id: "peer" },
          recipient: { id: "shop" },
          timestamp: Date.now(),
          message: { mid: "ig-message", text: "IG incoming" },
        },
      ],
    };
    ig.receiveWebhook(entry);
    ig.receiveWebhook(entry);
    assert.equal(f.db.prepare("SELECT count(*) n FROM push_jobs").get()!.n, 2);
    await f.push.flush();
    assert.equal(f.db.prepare("SELECT count(*) n FROM push_jobs").get()!.n, 0);
  } finally {
    await tg.close();
    await ig.close();
    await f.close();
  }
});
