import fs from "node:fs";
import path from "node:path";
import type { Store } from "./store.js";
export function seedDemoFiles(store: Store, dataDir: string) {
  if (store.accounts().some((a) => a.mode !== "demo"))
    throw new Error("Демо-файлы запрещены в реальном режиме");
  const dir = path.join(dataDir, "attachments");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="280" viewBox="0 0 400 280"><rect width="400" height="280" fill="#ece8df"/><ellipse cx="200" cy="239" rx="95" ry="12" fill="#d6d0c3"/><path d="M130 108h140l17 122H113z" fill="#b8a48a"/><path d="M160 120V81a40 40 0 0 1 80 0v39" fill="none" stroke="#806b51" stroke-width="10"/><path d="M136 126h128" stroke="#d2c2aa" stroke-width="3"/><text x="200" y="185" text-anchor="middle" fill="#74624e" font-family="sans-serif" font-size="13">DEMO COLLECTION</text></svg>';
  fs.writeFileSync(path.join(dir, "demo-bag.svg"), svg, { mode: 0o600 });
  const txt =
    "Демонстрационный файл\nЗаказ: бежевая сумка\nЭто пример вложения, не реальный заказ.";
  fs.writeFileSync(path.join(dir, "demo-order.txt"), txt, { mode: 0o600 });
  const rate = 8000,
    seconds = 1,
    wav = Buffer.alloc(44 + rate * seconds * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 0; i < rate; i++)
    wav.writeInt16LE(
      Math.round(Math.sin((i / rate) * Math.PI * 880) * 1500),
      44 + i * 2,
    );
  fs.writeFileSync(path.join(dir, "demo-voice.wav"), wav, { mode: 0o600 });
  const c = store.conversations().find((c) => c.accountId === "instagram-1")!;
  store.incoming(c.accountId, {
    externalConversationId: c.externalId,
    externalMessageId: "demo-attachments-v1",
    name: c.name,
    username: c.username,
    text: "Примеры вложений: изображение, файл и звуковой сигнал (демо).",
  });
  store.db
    .prepare(
      "UPDATE messages SET attachments=? WHERE conversation_id=? AND external_id=?",
    )
    .run(
      JSON.stringify([
        {
          kind: "image",
          url: "/api/files/demo-bag.svg",
          name: "Бежевая сумка",
          mime: "image/svg+xml",
          size: Buffer.byteLength(svg),
        },
        {
          kind: "file",
          url: "/api/files/demo-order.txt",
          name: "Пример заказа.txt",
          mime: "text/plain",
          size: Buffer.byteLength(txt),
        },
        {
          kind: "voice",
          url: "/api/files/demo-voice.wav",
          name: "Демонстрационный сигнал",
          mime: "audio/wav",
          size: wav.length,
        },
      ]),
      c.id,
      "demo-attachments-v1",
    );
}
