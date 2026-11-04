import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Api, TelegramClient } from "teleproto";
import { openDb } from "../server/db.js";
import { Store } from "../server/store.js";
import {
  TelegramIntegration,
  telegramRandomId,
  safeTelegramError,
} from "../server/telegram.js";
import { seal, unseal } from "../server/secrets.js";
import { createApp } from "../server/app.js";
test("Сессия Telegram зашифрована и привязана к аккаунту", () => {
  const key = randomBytes(32).toString("hex"),
    secret = "session-secret-example";
  const payload = seal(secret, key, "telegram-1");
  assert.ok(!payload.includes(secret));
  assert.equal(unseal(payload, key, "telegram-1"), secret);
  assert.throws(() => unseal(payload, key, "telegram-2"));
  assert.throws(() =>
    unseal(payload, randomBytes(32).toString("hex"), "telegram-1"),
  );
});
test("Telegram random_id стабилен; ошибки не раскрывают секретные данные", () => {
  const key = randomUUID();
  assert.equal(telegramRandomId(key), telegramRandomId(key));
  assert.notEqual(telegramRandomId(key), telegramRandomId(randomUUID()));
  assert.ok(BigInt(telegramRandomId(key)) < 2n ** 63n);
  assert.ok(
    !safeTelegramError(new Error("private session contents")).includes(
      "private",
    ),
  );
  assert.match(
    safeTelegramError({ errorMessage: "PHONE_CODE_INVALID" }),
    /Неверный код/,
  );
});
test("Реальный адаптер: правильный peer, echo без дубля, FLOOD_WAIT и неизвестный результат", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-tg-"));
  const db = openDb(dir, "real"),
    store = new Store(db);
  const integration = new TelegramIntegration(store, {
    apiId: 123,
    apiHash: "a".repeat(32),
    encryptionKey: "b".repeat(64),
  });
  try {
    db.prepare(
      "UPDATE accounts SET state='connected' WHERE id='telegram-1'",
    ).run();
    db.prepare("INSERT INTO telegram_peers VALUES(?,?,?,?,?)").run(
      "telegram-1",
      "9007199254740993",
      "1234",
      "Клиент",
      "client",
    );
    const id = randomUUID();
    db.prepare(
      "INSERT INTO conversations(id,account_id,external_id,name,username,updated_at) VALUES(?,?,?,?,?,?)",
    ).run(
      id,
      "telegram-1",
      "9007199254740993",
      "Клиент",
      "client",
      new Date().toISOString(),
    );
    Object.defineProperty(integration, "authenticated", {
      value: true,
      writable: true,
    });
    let mode = "success",
      called = 0;
    integration.client = {
      connected: true,
      invoke: async (request: Api.messages.SendMessage) => {
        called++;
        assert.equal(
          (request.peer as Api.InputPeerUser).userId.toString(),
          "9007199254740993",
        );
        assert.equal(request.message, "Ручной ответ");
        assert.ok(request.randomId);
        assert.equal(request.allowPaidStars, undefined);
        if (mode === "ambiguous") throw new Error("private network detail");
        if (mode === "flood")
          throw { code: 420, errorMessage: "FLOOD_WAIT_15", seconds: 15 };
        // Telegram echo arrives before the send RPC completes.
        db.prepare(
          "INSERT INTO messages(id,conversation_id,external_id,direction,text,status,created_at) VALUES(?,?,?,'out',?,'sent',?)",
        ).run(
          randomUUID(),
          id,
          "991",
          request.message,
          new Date().toISOString(),
        );
        return new Api.UpdateShortSentMessage({
          id: 991,
          pts: 1,
          ptsCount: 1,
          date: Math.floor(Date.now() / 1000),
          out: true,
        });
      },
      destroy: async () => {},
    } as unknown as TelegramClient;
    const key = randomUUID();
    store.enqueue(id, "Ручной ответ", key);
    store.enqueue(id, "Ручной ответ", key);
    await store.tick();
    assert.equal(called, 1);
    assert.equal(store.messages(id).length, 1);
    assert.equal(store.messages(id)[0].status, "sent");
    assert.equal(store.messages(id)[0].externalId, "991");
    mode = "ambiguous";
    store.enqueue(id, "Ручной ответ", randomUUID());
    await store.tick();
    assert.equal(store.messages(id).at(-1)!.status, "unknown");
    await store.tick();
    assert.equal(called, 2);
    mode = "flood";
    store.enqueue(id, "Ручной ответ", randomUUID());
    await store.tick();
    assert.equal(store.messages(id).at(-1)!.status, "queued");
    const before = called;
    await store.tick();
    assert.equal(called, before);
  } finally {
    await integration.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("Вход Telegram защищён сессией владельца и недоступен в демо", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-tg-api-"));
  const { app } = await createApp({
    dataDir: dir,
    mode: "demo",
    worker: false,
  });
  try {
    for (const url of [
      "/api/telegram/status",
      "/api/telegram/start",
      "/api/telegram/code",
      "/api/telegram/password",
    ])
      assert.equal(
        (
          await app.inject({
            method: url.endsWith("status") ? "GET" : "POST",
            url,
            payload: url.endsWith("status") ? undefined : {},
          })
        ).statusCode,
        401,
      );
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Вход: код, 2FA, шифрованная сессия и привязка к владельцу", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-tg-auth-")),
    db = openDb(dir, "real"),
    store = new Store(db),
    key = "c".repeat(64);
  const integration = new TelegramIntegration(store, {
    apiId: 123,
    apiHash: "a".repeat(32),
    encryptionKey: key,
  });
  try {
    const { default: bigInt } = await import("big-integer");
    const me = new Api.User({
      id: bigInt("123456789"),
      accessHash: bigInt("987654321"),
      firstName: "Test",
      self: true,
    });
    const fake = {
      connected: true,
      connect: async () => {},
      destroy: async () => {},
      sendCode: async () => ({ phoneCodeHash: "hash", isCodeViaApp: true }),
      invoke: async () => {
        throw { errorMessage: "SESSION_PASSWORD_NEEDED" };
      },
      signInWithPassword: async (
        _c: unknown,
        p: { password: () => Promise<string> },
      ) => {
        assert.equal(await p.password(), "not-saved");
        return me;
      },
      getMe: async () => me,
      session: { save: () => "secret-session-example" },
    } as unknown as TelegramClient;
    Object.defineProperty(integration, "newClient", {
      value: () => {
        integration.client = fake;
        return fake;
      },
    });
    Object.defineProperty(integration, "sync", { value: async () => {} });
    assert.equal(
      (await integration.start("+998901234567", "owner-session")).stage,
      "code",
    );
    await assert.rejects(
      integration.verify("12345", "other-session"),
      /Начните вход/,
    );
    assert.equal(
      (await integration.verify("12345", "owner-session")).stage,
      "password",
    );
    assert.equal(
      (await integration.verify("not-saved", "owner-session", true)).stage,
      "connected",
    );
    const row = db
      .prepare("SELECT ciphertext,user_id FROM telegram_sessions")
      .get() as { ciphertext: string; user_id: string };
    assert.equal(row.user_id, "123456789");
    assert.equal(
      unseal(row.ciphertext, key, "telegram-1"),
      "secret-session-example",
    );
    assert.ok(!row.ciphertext.includes("not-saved"));
    assert.equal(store.account("telegram-1").state, "connected");
    assert.equal(store.account("telegram-2").state, "unconfigured");
  } finally {
    await integration.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Два Telegram: одинаковый клиент изолирован, ответы идут через свою сессию", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-two-tg-"));
  const db = openDb(dir, "real"),
    store = new Store(db);
  const integrations: TelegramIntegration[] = [];
  const calls: string[] = [];
  try {
    for (const accountId of ["telegram-1", "telegram-2"] as const) {
      const integration = new TelegramIntegration(store, {
        accountId,
        apiId: 123,
        apiHash: "a".repeat(32),
        encryptionKey: "b".repeat(64),
      });
      integrations.push(integration);
      Object.defineProperty(integration, "authenticated", { value: true });
      db.prepare("UPDATE accounts SET state='connected' WHERE id=?").run(
        accountId,
      );
      db.prepare("INSERT INTO telegram_peers VALUES(?,?,?,?,?)").run(
        accountId,
        "12345",
        accountId === "telegram-1" ? "111" : "222",
        "Клиент",
        "client",
      );
      db.prepare(
        "INSERT INTO conversations(id,account_id,external_id,name,username,updated_at) VALUES(?,?,?,?,?,?)",
      ).run(
        accountId + "-chat",
        accountId,
        "12345",
        "Клиент",
        "client",
        new Date().toISOString(),
      );
      integration.client = {
        connected: true,
        invoke: async (request: Api.messages.SendMessage) => {
          assert.equal(
            (request.peer as Api.InputPeerUser).accessHash.toString(),
            accountId === "telegram-1" ? "111" : "222",
          );
          assert.equal(request.message, accountId);
          calls.push(accountId);
          return new Api.UpdateShortSentMessage({
            id: 42,
            pts: 1,
            ptsCount: 1,
            date: 1,
            out: true,
          });
        },
        destroy: async () => {},
      } as unknown as TelegramClient;
    }
    for (const id of ["telegram-1", "telegram-2"]) {
      store.enqueue(id + "-chat", id, randomUUID());
      await store.tick();
    }
    assert.deepEqual(calls, ["telegram-1", "telegram-2"]);
    for (const id of ["telegram-1", "telegram-2"]) {
      assert.equal(store.messages(id + "-chat")[0].status, "sent");
      assert.equal(store.messages(id + "-chat")[0].text, id);
    }
    await assert.rejects(integrations[0].history("telegram-2-chat"));
  } finally {
    await Promise.all(integrations.map((t) => t.close()));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Telegram sync fills 50 personal chats after skipping groups and bots', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jorik-tg-personal-'));
  const db = openDb(dir, 'real'), store = new Store(db);
  const integration = new TelegramIntegration(store, {apiId:123,apiHash:'a'.repeat(32),encryptionKey:'b'.repeat(64)});
  const {default:bigInt} = await import('big-integer');
  let visited = 0;
  Object.defineProperty(integration, 'authenticated', {value:true});
  Object.defineProperty(integration, 'difference', {value:async()=>{}});
  integration.client = {
    connected:true,session:{save:()=>''},destroy:async()=>{},
    iterDialogs:async function* () {
      for(let i=0;i<5;i++){visited++;yield {entity:{}};}
      visited++;yield {entity:new Api.User({id:bigInt(9999),accessHash:bigInt(1),bot:true,firstName:'Bot'})};
      for(let i=1;i<=105;i++){
        visited++;yield {entity:new Api.User({id:bigInt(i),accessHash:bigInt(1),firstName:`Client ${i}`})};
      }
    },
  } as unknown as TelegramClient;
  try {
    await integration.sync();
    assert.equal(store.conversations().length,50);
    assert.equal(visited,56);
    assert.equal(store.account('telegram-1').state,'connected');
    assert.ok(store.account('telegram-1').lastSync);
  } finally {await integration.close();db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
