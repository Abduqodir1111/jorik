import { randomBytes } from "node:crypto";
import { config } from "../server/config.js";
import { openDb } from "../server/db.js";
import { hashPassword } from "../server/auth.js";
const db = openDb(config.dataDir, config.mode);
if (
  db.prepare("SELECT 1 FROM owner").get() &&
  !process.argv.includes("--reset")
) {
  console.log(
    "Владелец уже создан. Для смены пароля: npm run owner -- --reset",
  );
} else {
  const password = randomBytes(15).toString("base64url");
  db.transaction(() => {
    db.prepare(
      "INSERT INTO owner VALUES(1,?) ON CONFLICT(id) DO UPDATE SET password_hash=excluded.password_hash",
    ).run(hashPassword(password));
    db.prepare("DELETE FROM sessions").run();
  })();
  console.log(
    `Пароль владельца (${config.mode}): ${password}\nСохраните его в менеджере паролей. Он не будет показан повторно.`,
  );
}
db.close();
