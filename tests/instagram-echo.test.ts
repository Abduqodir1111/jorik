import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/db.js";
import { Store } from "../server/store.js";
import { InstagramIntegration } from "../server/instagram.js";
const envelope = (prefix: string) =>
  Buffer.from(`${prefix}ig_dm_item:1:IGMessageID:123:456:789`)
    .toString("base64")
    .replace(
      /[Z+/=]/g,
      (c) => ({ Z: "ZA", "+": "ZB", "/": "ZC", "=": "ZD" })[c]!,
    );
for (const early of [true, false])
  test(`Instagram echo ${early ? "before" : "after"} send confirmation remains one message and one provider POST`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-echo-"));
    const db = openDb(dir, "real");
    const s = new Store(db);
    let posts = 0;
    let ig: InstagramIntegration;
    const echo = () =>
      ig.receiveWebhook({
        id: "shop",
        messaging: [
          {
            sender: { id: "shop" },
            recipient: { id: "customer" },
            timestamp: Date.now(),
            message: { mid: envelope("new_"), text: "Reply", is_echo: true },
          },
        ],
      });
    const options = {
      token: "test",
      receiveMode: "webhook" as const,
      fetcher: (async (_u: string, init: RequestInit) => {
        if (init.method === "POST") {
          posts++;
          if (early) echo();
          return Response.json({ message_id: envelope("") });
        }
        return Response.json({
          id: "page",
          instagram_business_account: { id: "shop", username: "shop" },
        });
      }) as typeof fetch,
    };
    ig = new InstagramIntegration(s, options);
    try {
      await ig.sync();
      ig.receiveWebhook({
        id: "shop",
        messaging: [
          {
            sender: { id: "customer" },
            recipient: { id: "shop" },
            timestamp: Date.now() - 1000,
            message: { mid: "question", text: "Question" },
          },
        ],
      });
      const c = s.conversations()[0];
      const id = s.enqueue(c.id, "Reply", "same-request");
      s.enqueue(c.id, "Reply", "same-request");
      await Promise.all([s.tick(), s.tick()]);
      if (!early) echo();
      echo();
      assert.equal(posts, 1);
      assert.equal(
        s.messages(c.id).filter((m) => m.direction === "out").length,
        1,
      );
      assert.equal(s.messages(c.id).find((m) => m.id === id)?.status, "sent");
      assert.equal(db.prepare("SELECT count(*) n FROM outbox").get()!.n, 1);
      // Reproduce an existing deployment's duplicate, then verify startup repair.
      db.prepare("UPDATE messages SET instagram_key=NULL WHERE id=?").run(id);
      echo();
      assert.equal(
        s.messages(c.id).filter((m) => m.direction === "out").length,
        2,
      );
      const duplicate = s
        .messages(c.id)
        .find((m) => m.direction === "out" && m.id !== id)!;
      db.prepare(
        "UPDATE messages SET reply_to_id=? WHERE external_id='question'",
      ).run(duplicate.id);
      await ig.close();
      ig = new InstagramIntegration(s, options);
      assert.equal(
        s.messages(c.id).filter((m) => m.direction === "out").length,
        1,
      );
      assert.equal(
        db
          .prepare(
            "SELECT reply_to_id FROM messages WHERE external_id='question'",
          )
          .get()!.reply_to_id,
        id,
      );
      assert.equal(
        db.prepare("SELECT message_id FROM outbox").get()!.message_id,
        id,
      );
    } finally {
      await ig.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
