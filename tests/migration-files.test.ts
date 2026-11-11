import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/db.js";

test("Only numbered SQL migrations execute; AppleDouble and stray SQL files are ignored", () => {
  const original = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-migrations-"));
  let db: ReturnType<typeof openDb> | undefined;
  try {
    fs.cpSync(path.join(original, "migrations"), path.join(dir, "migrations"), {
      recursive: true,
    });
    for (const name of ["._001_initial.sql", "notes.sql", "022_test.sql.bak"]) {
      fs.writeFileSync(
        path.join(dir, "migrations", name),
        "CREATE TABLE must_not_execute(id INTEGER);",
      );
    }
    process.chdir(dir);
    db = openDb(path.join(dir, "data"), "demo");
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE name='must_not_execute'",
        )
        .get()?.n,
      0,
    );
    const names = db.prepare("SELECT name FROM migrations").all() as {
      name: string;
    }[];
    assert.ok(names.length > 0);
    assert.ok(names.every(({ name }) => /^\d{3}_[a-z0-9_]+\.sql$/i.test(name)));
    assert.equal(db.prepare("PRAGMA integrity_check").pluck().get(), "ok");
  } finally {
    db?.close();
    process.chdir(original);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
