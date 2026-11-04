// Isolated UI acceptance environment: never connects to Telegram or Meta.
// Run: PORT=5312 npx tsx scripts/operator-preview.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/app.js";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-operator-preview-"));
const ctx = await createApp({
  dataDir: dir,
  mode: "demo",
  localAccess: true,
  disableRateLimit: true,
});
const slots = [
  { title: "👋 Приветствие", text: "Здравствуйте! Какую книгу вы ищете?" },
  { title: "🚚 Доставка", text: "Уточните, пожалуйста, город доставки." },
  { title: "📚 Наличие", text: "Сейчас проверю наличие книги." },
  { title: "✅ Спасибо", text: "Спасибо за обращение!" },
];
ctx.db
  .prepare("INSERT INTO settings VALUES('quickReplies',?)")
  .run(JSON.stringify(slots));
for (const [i, name] of [
  "Анна · тест",
  "Дмитрий · тест",
  "Мария · тест",
].entries()) {
  const cid = ctx.store.incoming(i === 1 ? "instagram-1" : "telegram-1", {
    externalConversationId: String(i + 1),
    externalMessageId: "in" + i,
    name,
    username: "demo" + i,
    text:
      i === 1
        ? "[Вложение Instagram — откройте в Instagram]"
        : "Здравствуйте! Есть ли книга в твёрдом переплёте?",
  });
  ctx.db
    .prepare("UPDATE conversations SET stage=? WHERE id=?")
    .run(["new", "waiting", "paid"][i], cid);
  if (i !== 1)
    ctx.store.enqueue(
      cid,
      "Здравствуйте! Да, есть. Могу помочь с заказом.",
      randomUUID(),
    );
}
const port = Number(process.env.PORT ?? 3002);
await ctx.app.listen({ host: "127.0.0.1", port });
console.log(`Isolated demo: http://127.0.0.1:${port}`);
async function close() {
  await ctx.app.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit();
}
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
