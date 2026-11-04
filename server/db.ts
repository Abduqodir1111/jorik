import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { Mode } from "../shared/types.js";
export function openDb(dataDir: string, mode: Mode) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(dataDir, "attachments"), {
    recursive: true,
    mode: 0o700,
  });
  const file = path.join(dataDir, `${mode}.sqlite`);
  const db = new Database(file);
  fs.chmodSync(file, 0o600);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  // SQLite's built-in lower() only handles ASCII. Keep substring search
  // case-insensitive for Cyrillic without loading message history into JS.
  db.function("search_fold", { deterministic: true }, (value: unknown) =>
    String(value ?? "").toLocaleLowerCase("ru"),
  );
  db.exec("CREATE TABLE IF NOT EXISTS migrations(name TEXT PRIMARY KEY)");
  for (const name of fs
    .readdirSync(path.resolve("migrations"))
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    if (!db.prepare("SELECT 1 FROM migrations WHERE name=?").get(name))
      db.transaction(() => {
        db.exec(fs.readFileSync(path.join("migrations", name), "utf8"));
        db.prepare("INSERT INTO migrations VALUES(?)").run(name);
      })();
  }
  for (const platform of ["telegram", "instagram"])
    for (let i = 1; i <= 2; i++)
      db.prepare(
        "INSERT OR IGNORE INTO accounts(id,name,platform,adapter,mode,state,last_sync,error,color) VALUES(?,?,?,?,?,?,NULL,?,?)",
      ).run(
        `${platform}-${i}`,
        `${platform === "telegram" ? "Telegram" : "Instagram"} ${i}`,
        platform,
        mode === "demo" ? "demo" : "not-selected",
        mode,
        mode === "demo" ? "connected" : "unconfigured",
        mode === "real" ? "Провайдер API ещё не выбран" : null,
        platform === "telegram" ? "#286a90" : "#934866",
      );
  return db;
}
export type DB = ReturnType<typeof openDb>;
