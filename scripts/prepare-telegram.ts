import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { parse } from "dotenv";
import { openDb } from "../server/db.js";
const envPath = path.resolve(".env");
if (!fs.existsSync(envPath)) throw new Error("Сначала заполните .env");
let text = fs.readFileSync(envPath, "utf8");
const env = parse(text);
if (
  !/^\d+$/.test(env.TELEGRAM_API_ID ?? "") ||
  !/^[a-f0-9]{32}$/i.test(env.TELEGRAM_API_HASH ?? "")
)
  throw new Error("Проверьте Telegram API ID и hash в .env");
function set(name: string, value: string) {
  const re = new RegExp("^" + name + "=.*$", "m");
  text = re.test(text)
    ? text.replace(re, name + "=" + value)
    : text + "\n" + name + "=" + value + "\n";
}
if (!env.INTEGRATION_ENCRYPTION_KEY)
  set("INTEGRATION_ENCRYPTION_KEY", randomBytes(32).toString("hex"));
else if (!/^[a-f0-9]{64}$/i.test(env.INTEGRATION_ENCRYPTION_KEY))
  throw new Error(
    "Ключ шифрования должен содержать 64 hex-символа. Существующий ключ не изменён.",
  );
const dir = path.resolve(env.DATA_DIR ?? "data"),
  real = openDb(dir, "real");
try {
  if (
    !real.prepare("SELECT 1 FROM owner").get() &&
    fs.existsSync(path.join(dir, "demo.sqlite"))
  ) {
    const demo = openDb(dir, "demo");
    try {
      const owner = demo
        .prepare("SELECT password_hash FROM owner WHERE id=1")
        .get() as { password_hash: string } | undefined;
      if (owner) {
        real.transaction(() => {
          real
            .prepare("INSERT INTO owner VALUES(1,?)")
            .run(owner.password_hash);
          for (const s of demo
            .prepare("SELECT * FROM sessions WHERE expires_at>?")
            .all(Date.now()) as { token_hash: string; expires_at: number }[])
            real
              .prepare(
                "INSERT INTO sessions(token_hash,expires_at) VALUES(?,?)",
              )
              .run(s.token_hash, s.expires_at);
        })();
        console.log(
          "Вход владельца сохранён. Демонстрационная переписка не переносилась.",
        );
      }
    } finally {
      demo.close();
    }
  }
} finally {
  real.close();
}
set("APP_MODE", "real");
fs.writeFileSync(envPath, text, { mode: 0o600 });
fs.chmodSync(envPath, 0o600);
console.log(
  "Реальный режим подготовлен. API hash и ключ шифрования не выводятся. Запустите приложение и войдите в Telegram 1 через раздел «Аккаунты».",
);
