// Synthetic scratch DB only. Run: npx tsx scripts/benchmark-inbox.ts
import { openDb } from "../server/db.js";
import { Store } from "../server/store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-inbox-benchmark-"));
const db = openDb(dir, "demo"),
  store = new Store(db);
try {
  const conversation = db.prepare(
    "INSERT INTO conversations(id,account_id,external_id,name,username,updated_at) VALUES(?,?,?,?,?,?)",
  );
  const message = db.prepare(
    "INSERT INTO messages(id,conversation_id,external_id,direction,text,status,created_at,deleted_at) VALUES(?,?,?,?,?,?,?,?)",
  );
  db.transaction(() => {
    for (let i = 0; i < 520; i++) {
      const id = randomUUID();
      conversation.run(
        id,
        "telegram-1",
        String(i),
        "Synthetic client",
        "synthetic",
        new Date(1795000000000 + i).toISOString(),
      );
      for (let n = 0; n < 120; n++)
        message.run(
          randomUUID(),
          id,
          String(n),
          n < 30 ? "in" : "out",
          "Synthetic message",
          "sent",
          new Date(1795000000000 + n * 1000).toISOString(),
          n > 100 ? "2026-11-20T00:00:00.000Z" : null,
        );
    }
  })();
  // Removing candidate indexes is safe here: this freshly created directory is
  // never a supplied user/production path and is discarded in finally.
  db.exec(
    "DROP INDEX messages_incoming_latest; DROP INDEX messages_visible_latest;",
  );
  let sql = "";
  const prepare = db.prepare.bind(db);
  db.prepare = ((query: string) => {
    if (query.startsWith("SELECT c.id,c.account_id")) sql = query;
    return prepare(query);
  }) as typeof db.prepare;
  const measure = () => {
    const times: number[] = [];
    for (let i = 0; i < 15; i++) {
      const start = performance.now();
      store.conversations();
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    return {
      p50Ms: +times[7].toFixed(2),
      p95Ms: +times[14].toFixed(2),
      plan: prepare("EXPLAIN QUERY PLAN " + sql).all(),
    };
  };
  const expected = store.conversations(),
    before = measure();
  db.exec(fs.readFileSync("migrations/024_inbox_lookup_indexes.sql", "utf8"));
  const after = measure();
  assert.deepEqual(store.conversations(), expected);
  console.log(
    JSON.stringify(
      {
        syntheticOnly: true,
        conversations: 520,
        messages: 62400,
        before,
        after,
        identicalResults: true,
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
