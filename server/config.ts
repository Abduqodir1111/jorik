import "dotenv/config";
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.instagram", quiet: true });
loadEnv({ path: ".env.instagram.mangastore", quiet: true });
loadEnv({ path: ".env.instagram.seller", quiet: true });
import path from "node:path";
import type { Mode } from "../shared/types.js";
const mode = process.env.APP_MODE ?? "demo";
if (mode !== "demo" && mode !== "real")
  throw new Error("APP_MODE must be demo or real");
export const config = {
  mode: mode as Mode,
  localAccess: process.env.LOCAL_TEST_NO_PASSWORD === "true",
  disableRateLimit: process.env.LOCAL_TEST_NO_RATE_LIMIT === "true",
  push: {
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
    subject: process.env.VAPID_SUBJECT,
  },
  telegram: {
    apiId: Number(process.env.TELEGRAM_API_ID ?? 0),
    apiHash: process.env.TELEGRAM_API_HASH ?? "",
    encryptionKey: process.env.INTEGRATION_ENCRYPTION_KEY ?? "",
  },
  instagram: {
    token: process.env.INSTAGRAM_ACCESS_TOKEN ?? "",
    receiveMode: "webhook" as const,
  },
  instagram2: {
    token: process.env.INSTAGRAM_MANGASTORE_ACCESS_TOKEN ?? "",
    receiveMode: "webhook" as const,
  },
  metaWebhook: {
    verifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN ?? "",
    appSecret: process.env.META_SELLER_APP_SECRET ?? "",
  },
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3001),
  dataDir: path.resolve(process.env.DATA_DIR ?? "data"),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "",
  oauthCallbackUrl: process.env.OAUTH_CALLBACK_URL ?? "",
};
