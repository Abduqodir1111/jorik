import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { openDb } from "../server/db.js";
import { Store } from "../server/store.js";
import { registerProfilePhotos } from "../server/profile-photos.js";
test("Profile photos: coalesced download, bounded cache, missing-photo fallback and MIME validation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-avatar-")),
    db = openDb(dir, "demo"),
    store = new Store(db),
    app = Fastify();
  const ids = Array.from({ length: 3 }, (_, i) =>
    store.incoming("telegram-1", {
      externalConversationId: String(i),
      externalMessageId: String(i),
      name: "Тест",
      username: "test",
      text: "Hi",
    }),
  );
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  registerProfilePhotos(app, store, async (id) => {
    calls++;
    if (id === ids[0]) {
      await gate;
      return Buffer.from([255, 216, 255, 0]);
    }
    return id === ids[1] ? null : Buffer.from('<svg onload="bad">');
  });
  try {
    await app.ready();
    const a = app.inject("/api/conversations/" + ids[0] + "/avatar"),
      b = app.inject("/api/conversations/" + ids[0] + "/avatar");
    await new Promise((r) => setImmediate(r));
    release();
    const results = await Promise.all([a, b]);
    assert.ok(results.every((r) => r.statusCode === 200));
    assert.equal(calls, 1);
    assert.equal(results[0].headers["content-type"], "image/jpeg");
    await app.inject("/api/conversations/" + ids[0] + "/avatar");
    assert.equal(calls, 1);
    for (const id of ids.slice(1)) {
      const response = await app.inject("/api/conversations/" + id + "/avatar");
      assert.equal(response.statusCode, 404, response.body);
      await app.inject("/api/conversations/" + id + "/avatar");
    }
    assert.equal(calls, 3);
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
