import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/app.js";

test("normal browsing exceeds the old limit while login remains protected", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-rate-limit-"));
  const { app, db } = await createApp({
    dataDir: dir,
    mode: "demo",
    worker: false,
  });
  try {
    for (let i = 0; i < 250; i++) {
      const response = await app.inject({ url: "/api/auth-status" });
      assert.equal(response.statusCode, 200);
    }
    for (let i = 0; i < 10; i++) {
      const response = await app.inject({
        method: "POST",
        url: "/api/login",
        payload: { password: "invalid" },
      });
      assert.equal(response.statusCode, 401);
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: "invalid" },
    });
    assert.equal(blocked.statusCode, 429);
    assert.equal(
      (await app.inject({ url: "/api/auth-status" })).statusCode,
      200,
    );
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
