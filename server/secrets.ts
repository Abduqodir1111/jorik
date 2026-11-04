import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
export function seal(value: string, key: string, context: string) {
  const bytes = Buffer.from(key, "hex");
  if (bytes.length !== 32)
    throw new Error("Не настроен ключ шифрования сессий");
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", bytes, iv);
  cipher.setAAD(Buffer.from(context));
  return JSON.stringify({
    iv: iv.toString("hex"),
    tag: (() => {
      const encrypted = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
      ]);
      return {
        data: encrypted.toString("base64"),
        auth: cipher.getAuthTag().toString("hex"),
      };
    })(),
  });
}
export function unseal(value: string, key: string, context: string) {
  try {
    const payload = JSON.parse(value),
      decipher = createDecipheriv(
        "aes-256-gcm",
        Buffer.from(key, "hex"),
        Buffer.from(payload.iv, "hex"),
      );
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(payload.tag.auth, "hex"));
    return Buffer.concat([
      decipher.update(Buffer.from(payload.tag.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error(
      "Не удалось расшифровать сессию Telegram. Проверьте исходный ключ шифрования.",
    );
  }
}
