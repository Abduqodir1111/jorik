import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/app.js";
import { hashPassword } from "../server/auth.js";
import { seed } from "../server/store.js";
test(
  "Instagram archive import returns 202 while Meta is still loading",
  { timeout: 5000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-archive-job-"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { app, db } = await createApp({
      dataDir: dir,
      mode: "real",
      worker: false,
      instagram2: {
        token: "test",
        receiveMode: "webhook",
        fetcher: (async (url: string) => {
          if (new URL(url).pathname.endsWith("/me"))
            return Response.json({
              id: "page",
              instagram_business_account: { id: "shop", username: "shop" },
            });
          await gate;
          return Response.json({ data: [] });
        }) as typeof fetch,
      },
    });
    try {
      db.prepare("INSERT INTO owner VALUES(1,?)").run(
        hashPassword("archive-job-test-password"),
      );
      const login = await app.inject({
        method: "POST",
        url: "/api/login",
        payload: { password: "archive-job-test-password" },
      });
      const cookie = String(login.headers["set-cookie"]).split(";")[0];
      const started = await app.inject({
        method: "POST",
        url: "/api/instagram/import-recent",
        headers: { cookie },
        payload: { accountId: "instagram-2" },
      });
      assert.equal(started.statusCode, 202);
      assert.equal(started.json().state, "running");
      const state = await app.inject({
        url: "/api/state",
        headers: { cookie },
      });
      assert.equal(
        state
          .json()
          .accounts.find((a: { id: string }) => a.id === "instagram-2")
          .recentImport.state,
        "running",
      );
    } finally {
      release();
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
test("Remembered login survives a day, renews on use, and logout revokes it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-remember-"));
  const { app, db } = await createApp({
    dataDir: dir,
    mode: "demo",
    worker: false,
    publicBaseUrl: "https://inbox.example.com",
  });
  try {
    db.prepare("INSERT INTO owner VALUES(1,?)").run(
      hashPassword("remember-test-password"),
    );
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: "remember-test-password", remember: true },
    });
    const header = String(login.headers["set-cookie"]);
    assert.match(header, /Max-Age=31536000/i);
    assert.match(header, /HttpOnly/);
    assert.match(header, /Secure/);
    const cookie = header.split(";")[0];
    // A remembered device with only ten days left must get a fresh year.
    db.prepare("UPDATE sessions SET expires_at=?").run(
      Date.now() + 10 * 86400000,
    );
    const renewed = await app.inject({
      url: "/api/state",
      headers: { cookie },
    });
    assert.equal(renewed.statusCode, 200);
    assert.match(String(renewed.headers["set-cookie"]), /Max-Age=31536000/i);
    assert.ok(
      (
        db.prepare("SELECT expires_at FROM sessions").get() as {
          expires_at: number;
        }
      ).expires_at >
        Date.now() + 350 * 86400000,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/logout",
          headers: { cookie },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ url: "/api/state", headers: { cookie } })).statusCode,
      401,
    );

    const short = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: "remember-test-password", remember: false },
    });
    assert.match(String(short.headers["set-cookie"]), /Max-Age=86400;/i);
    db.prepare("UPDATE sessions SET expires_at=?").run(Date.now() - 1);
    assert.equal(
      (
        await app.inject({
          url: "/api/state",
          headers: {
            cookie: String(short.headers["set-cookie"]).split(";")[0],
          },
        })
      ).statusCode,
      401,
    );
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("Авторизация, маршрутизация, дедупликация, outbox, сбои и сохранность", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-test-"));
  let ctx = await createApp({ dataDir: dir, mode: "demo", worker: false });
  try {
    assert.equal((await ctx.app.inject("/api/state")).statusCode, 401);
    ctx.db
      .prepare("INSERT INTO owner VALUES(1,?)")
      .run(hashPassword("test-password-123"));
    const login = await ctx.app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: "test-password-123" },
    });
    assert.equal(login.statusCode, 200);
    const cookie = login.headers["set-cookie"]!.toString().split(";")[0];
    assert.equal(
      (
        await ctx.app.inject({
          method: "PUT",
          url: "/api/settings",
          headers: { cookie, origin: "https://evil.example" },
          payload: { ownerName: "x" },
        })
      ).statusCode,
      403,
    );
    seed(ctx.store);
    assert.equal(ctx.store.accounts().length, 4);
    assert.equal(ctx.store.conversations().length, 8);
    const event = {
      externalConversationId: "same",
      externalMessageId: "9007199254740993999",
      name: "Один клиент",
      username: "same",
      text: "Тест",
    };
    const c1 = ctx.store.incoming("telegram-1", event),
      c2 = ctx.store.incoming("instagram-1", event);
    assert.notEqual(c1, c2);
    ctx.store.incoming("telegram-1", event);
    assert.equal(ctx.store.messages(c1).length, 1);
    const key = randomUUID();
    const headers = { cookie };
    const send = () =>
      ctx.app.inject({
        method: "POST",
        url: `/api/conversations/${c1}/messages`,
        headers,
        payload: { text: "Ответ", key },
      });
    const [one, two] = await Promise.all([send(), send()]);
    assert.equal(one.json().id, two.json().id);
    assert.equal(
      ctx.db.prepare("SELECT count(*) AS n FROM outbox").get()!.n,
      1,
    );
    await ctx.store.tick();
    let sent = ctx.store.messages(c1).find((m) => m.direction === "out")!;
    assert.equal(sent.status, "sent");
    assert.ok(sent.externalId!.startsWith("demo:telegram-1:"));
    assert.equal(
      (
        await ctx.app.inject({
          method: "POST",
          url: `/api/conversations/${c1}/messages`,
          headers,
          payload: {
            text: "wrong",
            key: randomUUID(),
            accountId: "instagram-1",
          },
        })
      ).statusCode,
      400,
    );
    ctx.store.enqueue(c1, "[ошибка]", randomUUID());
    await ctx.store.tick();
    assert.equal(ctx.store.messages(c1).at(-1)!.status, "error");
    ctx.store.enqueue(c1, "[неизвестно]", randomUUID());
    await ctx.store.tick();
    assert.equal(ctx.store.messages(c1).at(-1)!.status, "unknown");
    await ctx.app.inject({
      method: "POST",
      url: "/api/demo/accounts/telegram-1/toggle",
      headers,
      payload: {},
    });
    ctx.store.enqueue(c1, "Офлайн", randomUUID());
    await ctx.store.tick();
    assert.equal(ctx.store.messages(c1).at(-1)!.status, "error");
    await ctx.app.inject({
      method: "POST",
      url: "/api/demo/accounts/telegram-1/toggle",
      headers,
      payload: {},
    });
    assert.equal(ctx.store.account("telegram-1").state, "connected");
    await ctx.app.inject({
      method: "PUT",
      url: `/api/conversations/${c1}/draft`,
      headers,
      payload: { text: "Важный черновик" },
    });
    const interrupted = ctx.store.enqueue(c1, "Прервано", randomUUID());
    ctx.db
      .prepare("UPDATE outbox SET state='sending' WHERE message_id=?")
      .run(interrupted);
    ctx.db
      .prepare("UPDATE messages SET status='sending' WHERE id=?")
      .run(interrupted);
    await ctx.app.close();
    ctx = await createApp({ dataDir: dir, mode: "demo", worker: false });
    assert.equal(ctx.store.conversation(c1).draft, ""); // enqueue intentionally clears the old draft
    ctx.db
      .prepare("UPDATE conversations SET draft=? WHERE id=?")
      .run("Сохрани меня", c1);
    await ctx.app.close();
    ctx = await createApp({ dataDir: dir, mode: "demo", worker: false });
    assert.equal(ctx.store.conversation(c1).draft, "Сохрани меня");
    assert.equal(
      ctx.store.messages(c1).find((m) => m.id === interrupted)!.status,
      "unknown",
    );
    assert.equal(
      (await ctx.app.inject({ url: "/api/state", headers })).statusCode,
      200,
    );
  } finally {
    await ctx.app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("Реальный режим изолирован и не имитирует успех", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-real-"));
  const { app, store } = await createApp({
    dataDir: dir,
    mode: "real",
    worker: false,
  });
  try {
    assert.equal(store.accounts().length, 4);
    assert.ok(
      store
        .accounts()
        .every((a) => a.state === "unconfigured" && !a.capabilities.text),
    );
    assert.equal(store.conversations().length, 0);
    assert.throws(() => seed(store));
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Устаревшая версия не затирает черновик; поиск по кириллице", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-draft-"));
  const { app, store, db } = await createApp({
    dataDir: dir,
    mode: "demo",
    worker: false,
  });
  try {
    db.prepare("INSERT INTO owner VALUES(1,?)").run(hashPassword("password"));
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: "password" },
    });
    const headers = {
      cookie: login.headers["set-cookie"]!.toString().split(";")[0],
    };
    seed(store);
    const c = store.conversations()[0];
    for (const [revision, text] of [
      [200, "Последний черновик"],
      [100, "Устаревший черновик"],
    ] as const)
      assert.equal(
        (
          await app.inject({
            method: "PUT",
            url: `/api/conversations/${c.id}/draft`,
            headers,
            payload: { text, revision },
          })
        ).statusCode,
        200,
      );
    assert.equal(store.conversation(c.id).draft, "Последний черновик");
    const result = await app.inject({
      url: "/api/search?q=" + encodeURIComponent("ПОДСКАЖИТЕ"),
      headers,
    });
    assert.ok(result.json().ids.length > 0);
    const special = store.incoming("telegram-1", {
      externalConversationId: "search-literal",
      externalMessageId: "search-one",
      name: "Поиск",
      username: "search",
      text: "Скидка 50%_ТЕСТ",
    });
    store.incoming("telegram-1", {
      externalConversationId: "search-literal",
      externalMessageId: "search-two",
      name: "Поиск",
      username: "search",
      text: "50%_тест ещё раз",
    });
    const literal = await app.inject({
      url: "/api/search?q=" + encodeURIComponent("50%_тест"),
      headers,
    });
    assert.deepEqual(literal.json().ids, [special]);
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Deployment: only the explicitly configured public origin may write remotely", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-origin-"));
  const { app, db } = await createApp({
    dataDir: dir,
    mode: "demo",
    localAccess: true,
    worker: false,
    publicBaseUrl: "https://inbox.example.com",
  });
  try {
    db.prepare("INSERT INTO owner VALUES(1,?)").run(
      hashPassword("deployment-test-password"),
    );
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      headers: { origin: "https://inbox.example.com" },
      payload: { password: "deployment-test-password" },
    });
    assert.equal(login.statusCode, 200);
    assert.match(String(login.headers["set-cookie"]), /; Secure/);
    const request = (origin: string) =>
      app.inject({
        method: "POST",
        url: "/api/login",
        headers: { origin },
        payload: { password: "invalid" },
      });
    assert.equal((await request("https://inbox.example.com")).statusCode, 401);
    assert.equal(
      (await request("https://inbox.example.com.evil.test")).statusCode,
      403,
    );
    assert.equal((await request("http://inbox.example.com")).statusCode, 403);
    assert.equal((await request("https://evil.test")).statusCode, 403);
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTPS security headers also protect unauthorized responses without enforcing CSP", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-headers-"));
  const { app } = await createApp({ dataDir: dir, mode: "demo", worker: false, publicBaseUrl: "https://inbox.example.com" });
  try {
    for (const url of ["/privacy", "/api/state"]) {
      const result = await app.inject({ url });
      assert.equal(result.headers["strict-transport-security"], "max-age=31536000");
      assert.equal(result.headers["x-frame-options"], "DENY");
      assert.match(String(result.headers["permissions-policy"]), /camera=\(\)/);
      assert.match(String(result.headers["content-security-policy-report-only"]), /frame-ancestors 'none'/);
      assert.equal(result.headers["content-security-policy"], undefined);
    }
    assert.equal((await app.inject({ url: "/api/state" })).statusCode, 401);
  } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
