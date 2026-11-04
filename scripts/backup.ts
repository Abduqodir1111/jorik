import { config } from "../server/config.js";
import { openDb } from "../server/db.js";
import fs from "node:fs";
import path from "node:path";
const dir = path.resolve(
  "backups",
  new Date().toISOString().replaceAll(":", "-"),
);
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const db = openDb(config.dataDir, config.mode);
await db.backup(path.join(dir, `${config.mode}.sqlite`));
db.close();
fs.cpSync(
  path.join(config.dataDir, "attachments"),
  path.join(dir, "attachments"),
  { recursive: true },
);
console.log(`Резервная копия: ${dir}`);
