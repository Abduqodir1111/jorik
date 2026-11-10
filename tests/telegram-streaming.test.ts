import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createApp } from "../server/app.js";
test("Five simultaneous video ranges stream cached files without full-file reads or Telegram RPC", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-http-stream-"));
  const { app, db } = await createApp({
    dataDir: dir,
    mode: "real",
    localAccess: true,
    worker: false,
    telegram: { apiId: 123, apiHash: "test", encryptionKey: "b".repeat(64) },
  });
  const original = fsp.readFile;
  try {
    const cid = randomUUID(),
      mid = randomUUID();
    db.prepare(
      "INSERT INTO conversations(id,account_id,external_id,name,updated_at) VALUES(?,?,?,?,?)",
    ).run(cid, "telegram-1", "123", "Synthetic", new Date().toISOString());
    db.prepare(
      "INSERT INTO messages(id,conversation_id,external_id,direction,text,status,created_at,attachments) VALUES(?,?,?,'in','','sent',?,?)",
    ).run(
      mid,
      cid,
      "70",
      new Date().toISOString(),
      JSON.stringify([{ kind: "video" }]),
    );
    const file = path.join(
      dir,
      "attachments",
      "telegram-" +
        createHash("sha256")
          .update("telegram-1:" + mid)
          .digest("hex") +
        ".mp4",
    );
    fs.writeFileSync(file, "0000ftypisom0000", { mode: 0o600 });
    fs.truncateSync(file, 150 * 1024 * 1024);
    fsp.readFile = (async (...args: Parameters<typeof fsp.readFile>) => {
      assert.notEqual(
        String(args[0]),
        file,
        "Video must not be read into RAM in full",
      );
      return original(...args);
    }) as typeof fsp.readFile;
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({
          url: "/api/telegram/videos/" + mid,
          headers: { range: "bytes=0-1023", "accept-encoding": "gzip" },
        }),
      ),
    );
    for (const r of responses) {
      assert.equal(r.statusCode, 206);
      assert.equal(r.rawPayload.length, 1024);
      assert.equal(r.headers["content-range"], "bytes 0-1023/157286400");
      assert.equal(r.headers["content-encoding"], undefined);
      assert.match(String(r.headers["content-type"]), /video\/mp4/);
    }
    const invalid = await app.inject({
      url: "/api/telegram/videos/" + mid,
      headers: { range: "bytes=999999999-" },
    });
    assert.equal(invalid.statusCode, 416);
  } finally {
    fsp.readFile = original;
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
