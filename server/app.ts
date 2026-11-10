import compress from "@fastify/compress";
import { registerArchive, type ArchiveOptions } from "./archive-routes.js";
import { MAX_QUICK_REPLIES } from "../shared/quick-replies.js";
import { registerProfilePhotos } from "./profile-photos.js";
import { PushService, loadVapid, type PushOptions } from "./push.js";
import { registerOrders } from "./orders.js";
import { imageMime } from "./telegram-photos.js";
import { registerMetaWebhook } from "./meta-webhook.js";
import { metaWebhookInbox } from "./meta-webhook-inbox.js";
import { InstagramIntegration, type InstagramOptions } from "./instagram.js";
import { TelegramIntegration, type TelegramOptions } from "./telegram.js";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ServerResponse } from "node:http";
import { sendEvent } from "./event-stream.js";
import { openDb } from "./db.js";
import { Store } from "./store.js";
import { checkPassword, hashToken } from "./auth.js";
import type { Mode } from "../shared/types.js";
export async function createApp(opts: {
  dataDir: string;
  mode: Mode;
  worker?: boolean;
  localAccess?: boolean;
  publicBaseUrl?: string;
  disableRateLimit?: boolean;
  archive?: ArchiveOptions;
  push?: PushOptions;
  telegram?: TelegramOptions;
  instagram?: InstagramOptions;
  instagram2?: InstagramOptions;
  instagram3?: InstagramOptions;
  metaWebhook?: { verifyToken: string; appSecret: string };
}) {
  const app = Fastify({ logger: false, bodyLimit: 65536 });
  app.get("/sw.js", async (_req, reply) =>
    reply
      .header("Cache-Control", "no-store")
      .header("Service-Worker-Allowed", "/")
      .type("application/javascript")
      .send(readFileSync(path.resolve("public/sw.js"), "utf8")),
  );
  app.get("/privacy", async (_request, reply) =>
    reply
      .type("text/html; charset=utf-8")
      .send(readFileSync(path.resolve("public/privacy.html"), "utf8")),
  );
  app.get("/data-deletion", async (_request, reply) =>
    reply
      .type("text/html; charset=utf-8")
      .send(readFileSync(path.resolve("public/data-deletion.html"), "utf8")),
  );
  await app.register(compress, {
    encodings: ["gzip"],
    threshold: 1024,
    globalCompression: true,
    globalDecompression: false,
  });
  await app.register(cookie);
  const rememberedSessionSeconds = 365 * 86400;
  const sessionCookie = {
    httpOnly: true,
    sameSite: "strict" as const,
    path: "/",
    secure:
      !!opts.publicBaseUrl && new URL(opts.publicBaseUrl).protocol === "https:",
  };
  if (!opts.disableRateLimit)
    await app.register(rateLimit, { max: 2400, timeWindow: "1 minute" });
  const db = openDb(opts.dataDir, opts.mode),
    clients = new Set<ServerResponse>();
  const push = new PushService(
    db,
    loadVapid(opts.dataDir, opts.push),
    opts.push?.subject ||
      (opts.publicBaseUrl?.startsWith("https:")
        ? opts.publicBaseUrl
        : "https://inbox.storebooks.uz"),
  );
  // A process crash after provider submission is ambiguous: never blindly resend.
  db.transaction(() => {
    db.prepare(
      "UPDATE messages SET status='unknown',error='Сервер перезапустился во время отправки. Проверьте результат у провайдера.' WHERE id IN (SELECT message_id FROM outbox WHERE state='sending')",
    ).run();
    db.prepare("UPDATE outbox SET state='unknown' WHERE state='sending'").run();
  })();

  let publishTimer: ReturnType<typeof setTimeout> | undefined;
  const publish = () => {
    if (publishTimer || !clients.size) return;
    publishTimer = setTimeout(() => {
      publishTimer = undefined;
      for (const c of clients) sendEvent(clients, c, "data: changed\n\n");
    }, 40);
  };
  const store = new Store(db, publish, (event) => {
    for (const c of clients)
      sendEvent(clients, c, "event: incoming\ndata: new\n\n");
    if (event) {
      try {
        push.enqueue(event);
      } catch {
        console.warn("Web Push enqueue failed");
      }
    }
  });
  store.ordersChanged = () => {
    for (const client of clients)
      sendEvent(clients, client, "event: orders-changed\ndata: changed\n\n");
  };
  store.messageDeleted = (id, conversationId) => {
    for (const client of clients)
      sendEvent(
        clients,
        client,
        `event: message-deleted\ndata: ${JSON.stringify({ id, conversationId, preview: store.conversation(conversationId).preview })}\n\n`,
      );
  };
  store.messageUpdated = (message) => {
    const payload = `event: message-update\ndata: ${JSON.stringify(message)}\n\n`;
    for (const client of clients) sendEvent(clients, client, payload);
  };
  const telegrams = new Map<string, TelegramIntegration>();
  if (opts.mode === "real" && opts.telegram) {
    for (const accountId of ["telegram-1", "telegram-2"] as const) {
      const integration = new TelegramIntegration(store, {
        ...opts.telegram,
        accountId,
        attachmentDir: path.join(opts.dataDir, "attachments"),
      });
      telegrams.set(accountId, integration);
      integration.restore();
    }
  }
  const instagrams = new Map<string, InstagramIntegration>();
  const instagramOptions = new Map<string, InstagramOptions | undefined>([
    ["instagram-1", opts.instagram],
    ["instagram-2", opts.instagram2],
    ["instagram-3", opts.instagram3],
  ]);
  if (opts.mode === "real") {
    for (const [accountId, options] of [
      ["instagram-1", opts.instagram],
      ["instagram-2", opts.instagram2],
      ["instagram-3", opts.instagram3],
    ] as const) {
      if (!options?.token) {
        db.prepare(
          "UPDATE accounts SET state='unconfigured',error=NULL WHERE id=?",
        ).run(accountId);
        continue;
      }
      const integration = new InstagramIntegration(store, {
        ...options,
        accountId,
      });
      instagrams.set(accountId, integration);
      integration.start();
    }
  }
  const instagramFor = (accountId: string) => {
    const integration = instagrams.get(accountId);
    if (!integration) throw new Error("Instagram этого аккаунта не настроен.");
    return integration;
  };
  const receiveMeta = (entry: any) => {
    let total = 0;
    for (const [accountId, integration] of instagrams) {
      const handled = integration.receiveWebhook(entry);
      if (handled)
        console.info("Meta webhook account", accountId, "handled", handled);
      total += handled;
    }
    return total;
  };
  const inbox = metaWebhookInbox(db, receiveMeta, () =>
    [...instagrams.keys()]
      .filter((id) => instagramOptions.get(id)?.receiveMode === "webhook")
      .every(
        (id) =>
          !!db
            .prepare("SELECT 1 FROM instagram_identity WHERE account_id=?")
            .get(id),
      ),
  );
  await registerMetaWebhook(app, {
    verifyToken: opts.metaWebhook?.verifyToken ?? "",
    appSecret: opts.metaWebhook?.appSecret ?? "",
    receive: receiveMeta,
    enqueue: inbox.enqueue,
  });
  app.setErrorHandler((err, _req, reply) => {
    const e = err as Error & { statusCode?: number };
    reply.code(e instanceof z.ZodError ? 400 : (e.statusCode ?? 400)).send({
      error: e instanceof z.ZodError ? "Проверьте введённые данные" : e.message,
    });
  });
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "same-origin")
      .header("X-Frame-Options", "DENY")
      .header(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      )
      .header(
        "Content-Security-Policy-Report-Only",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; font-src 'self' data:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
      );
    if (sessionCookie.secure)
      reply.header("Strict-Transport-Security", "max-age=31536000");
    if (!req.url.startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");
    const origin = req.headers.origin;
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && origin) {
      const u = new URL(origin);
      const localOrigin =
        ["127.0.0.1", "localhost"].includes(u.hostname) &&
        ["5173", String(process.env.PORT ?? 3001)].includes(u.port);
      const publicOrigin = opts.publicBaseUrl
        ? new URL(opts.publicBaseUrl).origin
        : null;
      if (!localOrigin && u.origin !== publicOrigin)
        return reply.code(403).send({ error: "Недопустимый источник запроса" });
    }
    if (opts.localAccess) {
      if (
        !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip) ||
        !["127.0.0.1", "localhost", "[::1]"].includes(req.hostname)
      )
        return reply
          .code(403)
          .send({ error: "Тестовый доступ разрешён только локально." });
      // Keep a browser-specific identity for the multi-step Telegram login.
      if (!req.cookies.session) {
        const token = randomBytes(32).toString("hex");
        req.cookies.session = token;
        reply.setCookie("session", token, {
          httpOnly: true,
          sameSite: "strict",
          path: "/",
        });
      }
      return;
    }
    if (req.url === "/api/login" || req.url === "/api/auth-status") return;
    const session = db
      .prepare(
        "SELECT expires_at,EXISTS(SELECT 1 FROM remembered_sessions r WHERE r.token_hash=sessions.token_hash) AS remembered FROM sessions WHERE token_hash=? AND expires_at>?",
      )
      .get(hashToken(req.cookies.session ?? ""), Date.now()) as
      { expires_at: number; remembered: number } | undefined;
    if (!session)
      return reply.code(401).send({ error: "Войдите в приложение" });
    // Renew remembered devices during use; browsers still control cookie retention.
    if (
      session.remembered &&
      session.expires_at <
        Date.now() + (rememberedSessionSeconds - 86400) * 1000
    ) {
      db.prepare("UPDATE sessions SET expires_at=? WHERE token_hash=?").run(
        Date.now() + rememberedSessionSeconds * 1000,
        hashToken(req.cookies.session ?? ""),
      );
      reply.setCookie("session", req.cookies.session!, {
        ...sessionCookie,
        maxAge: rememberedSessionSeconds,
      });
    }
  });
  app.get("/api/auth-status", async () => ({
    configured: !!db.prepare("SELECT 1 FROM owner").get(),
    mode: opts.mode,
    localAccess: !!opts.localAccess,
  }));
  app.post(
    "/api/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { password, remember } = z
        .object({
          password: z.string().max(256),
          remember: z.boolean().default(false),
        })
        .parse(req.body);
      const owner = db
        .prepare("SELECT password_hash FROM owner WHERE id=1")
        .get() as { password_hash: string } | undefined;
      if (!owner || !checkPassword(password, owner.password_hash))
        return reply.code(401).send({ error: "Неверный пароль" });
      const token = randomBytes(32).toString("hex");
      db.prepare("DELETE FROM sessions WHERE expires_at<?").run(Date.now());
      const duration = remember ? rememberedSessionSeconds : 86400;
      db.transaction(() => {
        db.prepare(
          "INSERT INTO sessions(token_hash,expires_at) VALUES(?,?)",
        ).run(hashToken(token), Date.now() + duration * 1000);
        if (remember)
          db.prepare(
            "INSERT INTO remembered_sessions(token_hash) VALUES(?)",
          ).run(hashToken(token));
      })();
      reply.setCookie("session", token, {
        ...sessionCookie,
        maxAge: duration,
      });
      return { ok: true };
    },
  );
  app.post("/api/logout", async (req, reply) => {
    db.prepare("DELETE FROM push_subscriptions WHERE session_hash=?").run(
      hashToken(req.cookies.session ?? ""),
    );
    db.prepare("DELETE FROM sessions WHERE token_hash=?").run(
      hashToken(req.cookies.session ?? ""),
    );
    reply.clearCookie("session", { path: "/" });
    return { ok: true };
  });
  push.register(app);
  const accountQuery = (query: unknown) =>
    z
      .object({
        account: z.enum(["telegram-1", "telegram-2"]).default("telegram-1"),
      })
      .parse(query).account;
  const tg = (accountId: string) => {
    const integration = telegrams.get(accountId);
    if (!integration)
      throw new Error("Вход в Telegram доступен только в реальном режиме.");
    return integration;
  };
  app.get(
    "/api/telegram/status",
    async (req) =>
      telegrams.get(accountQuery(req.query))?.status() ?? {
        ready: false,
        stage: "phone",
        disabled: true,
      },
  );
  app.post(
    "/api/telegram/start",
    { config: { rateLimit: { max: 3, timeWindow: "5 minutes" } } },
    async (req) => {
      const { phone } = z
        .object({ phone: z.string().regex(/^\+[1-9]\d{6,14}$/) })
        .strict()
        .parse(req.body);
      return tg(accountQuery(req.query)).start(
        phone,
        hashToken(req.cookies.session ?? ""),
      );
    },
  );
  app.post(
    "/api/telegram/code",
    { config: { rateLimit: { max: 10, timeWindow: "5 minutes" } } },
    async (req) => {
      const { code } = z
        .object({ code: z.string().regex(/^\d{4,8}$/) })
        .strict()
        .parse(req.body);
      return tg(accountQuery(req.query)).verify(
        code,
        hashToken(req.cookies.session ?? ""),
      );
    },
  );
  app.post(
    "/api/telegram/password",
    { config: { rateLimit: { max: 5, timeWindow: "5 minutes" } } },
    async (req) => {
      const { password } = z
        .object({ password: z.string().min(1).max(256) })
        .strict()
        .parse(req.body);
      return tg(accountQuery(req.query)).verify(
        password,
        hashToken(req.cookies.session ?? ""),
        true,
      );
    },
  );
  app.post(
    "/api/telegram/sync",
    { config: { rateLimit: { max: 4, timeWindow: "1 minute" } } },
    async (req) => {
      try {
        await tg(accountQuery(req.query)).sync();
        return { ok: true };
      } catch {
        throw new Error(
          "Синхронизация не выполнена. Причина указана в карточке аккаунта.",
        );
      }
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/telegram/history/:id",
    async (req) =>
      tg(store.conversation(req.params.id).accountId).history(req.params.id),
  );
  app.patch<{ Params: { id: string } }>(
    "/api/messages/:id/text",
    async (req) => {
      const body = z
        .object({
          text: z.string().trim().min(1).max(4096),
          expectedText: z.string().max(16384),
        })
        .strict()
        .parse(req.body);
      const row = db
        .prepare(
          "SELECT c.account_id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=?",
        )
        .get(req.params.id) as { account_id: string } | undefined;
      if (!row || !row.account_id.startsWith("telegram-"))
        throw new Error("Редактирование доступно только в Telegram.");
      return tg(row.account_id).edit(
        req.params.id,
        body.text,
        body.expectedText,
      );
    },
  );
  app.delete<{ Params: { id: string } }>("/api/messages/:id", async (req) => {
    const row = db
      .prepare(
        "SELECT c.account_id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=? AND m.deleted_at IS NULL",
      )
      .get(req.params.id) as { account_id: string } | undefined;
    if (!row || !row.account_id.startsWith("telegram-"))
      throw new Error(
        "Удаление доступно только для отправленных сообщений Telegram.",
      );
    return tg(row.account_id).deleteMessage(req.params.id);
  });
  app.put<{ Params: { id: string } }>(
    "/api/messages/:id/reaction",
    async (req) => {
      const body = z
        .object({ emoji: z.enum(["👍", "❤️", "🔥", "😂", "👏"]).nullable() })
        .strict()
        .parse(req.body);
      const row = db
        .prepare(
          "SELECT c.account_id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=?",
        )
        .get(req.params.id) as { account_id: string } | undefined;
      if (!row || !row.account_id.startsWith("telegram-"))
        throw new Error("Отправка реакций здесь доступна только в Telegram.");
      return tg(row.account_id).react(req.params.id, body.emoji);
    },
  );
  app.get<{ Params: { id: string }; Querystring: { compatible?: string } }>(
    "/api/telegram/media/:id",
    async (req, reply) => {
      const row = db
        .prepare(
          "SELECT c.account_id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=?",
        )
        .get(req.params.id) as { account_id: string } | undefined;
      if (!row) return reply.code(404).send({ error: "Вложение не найдено" });
      const { bytes, mime } = await tg(row.account_id).specialMedia(
        req.params.id,
        req.query.compatible === "1",
      );
      return reply
        .type(mime)
        .header("Cache-Control", "private, max-age=3600")
        .header("X-Content-Type-Options", "nosniff")
        .send(bytes);
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/telegram/photos/:id",
    async (req, reply) => {
      const row = db
        .prepare(
          "SELECT c.account_id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=?",
        )
        .get(req.params.id) as { account_id: string } | undefined;
      if (!row) return reply.code(404).send({ error: "Фотография не найдена" });
      const { bytes, mime } = await tg(row.account_id).photo(req.params.id);
      return reply
        .type(mime)
        .header("Content-Disposition", "inline")
        .send(bytes);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { download?: string } }>(
    "/api/telegram/documents/:id",
    { compress: false },
    async (req, reply) => {
      const row = db
        .prepare(
          "SELECT c.account_id,m.attachments FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=?",
        )
        .get(req.params.id) as
        { account_id: string; attachments: string } | undefined;
      const attachment =
        row &&
        JSON.parse(row.attachments).find(
          (a: { kind: string }) => a.kind === "file",
        );
      if (!row || !attachment)
        return reply.code(404).send({ error: "Документ не найден" });
      const { file, mime } = await tg(row.account_id).mediaFile(
        req.params.id,
        "document",
      );
      const filename = encodeURIComponent(attachment.name).replace(
        /['()*]/g,
        (c) => "%" + c.charCodeAt(0).toString(16),
      );
      return reply
        .type(mime)
        .header("X-Content-Type-Options", "nosniff")
        .header(
          "Content-Disposition",
          `${mime === "application/pdf" && req.query.download !== "1" ? "inline" : "attachment"}; filename*=UTF-8''${filename}`,
        )
        .header("Cache-Control", "private, max-age=3600")
        .sendFile(path.basename(file), path.dirname(file), {
          cacheControl: false,
          acceptRanges: true,
          contentType: false,
        });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/telegram/videos/:id",
    { compress: false },
    async (req, reply) => {
      const row = db
        .prepare(
          "SELECT c.account_id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=?",
        )
        .get(req.params.id) as { account_id: string } | undefined;
      if (!row) return reply.code(404).send({ error: "Видео не найдено" });
      const { file, mime } = await tg(row.account_id).mediaFile(
        req.params.id,
        true,
      );
      return reply
        .type(mime)
        .header("Content-Disposition", "inline")
        .sendFile(path.basename(file), path.dirname(file), {
          cacheControl: false,
          acceptRanges: true,
          contentType: false,
        });
    },
  );
  app.get<{ Params: { id: string; index: string } }>(
    "/api/instagram/media/:id/:index",
    async (req, reply) => {
      const row = db
        .prepare(
          "SELECT c.account_id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=?",
        )
        .get(req.params.id) as { account_id: string } | undefined;
      if (!row) throw new Error("Вложение не найдено.");
      const media = await instagramFor(row.account_id).media(
        req.params.id,
        Number(req.params.index),
        req.headers.range,
      );
      reply
        .code(media.status)
        .type(media.mime)
        .header("Accept-Ranges", "bytes")
        .header("Content-Disposition", "inline");
      if (media.range) reply.header("Content-Range", media.range);
      if (media.length) reply.header("Content-Length", media.length);
      return reply.send(media.stream);
    },
  );
  app.post("/api/instagram/import-recent", async (req, reply) => {
    const { accountId } = z
      .object({
        accountId: z.enum(["instagram-1", "instagram-2", "instagram-3"]),
      })
      .strict()
      .parse(req.body);
    const integration = instagramFor(accountId);
    void integration.importRecent().catch(() => {});
    return reply.code(202).send(integration.recentImportStatus());
  });
  app.post("/api/instagram/sync", async (req) => {
    const { accountId } = z
      .object({
        accountId: z
          .enum(["instagram-1", "instagram-2", "instagram-3"])
          .optional(),
      })
      .strict()
      .parse(req.body ?? {});
    if (accountId) {
      await instagramFor(accountId).sync();
      return { ok: true };
    }
    if (!instagrams.size)
      throw new Error("Добавьте токен Instagram на сервере.");
    await Promise.all([...instagrams.values()].map((i) => i.sync()));
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>(
    "/api/instagram/history/:id",
    async (req) => {
      return instagramFor(store.conversation(req.params.id).accountId).history(
        req.params.id,
      );
    },
  );
  app.get("/api/state", async () => ({
    quickRepliesVersion: hashToken(
      (
        db
          .prepare("SELECT value FROM settings WHERE key='quickReplies'")
          .get() as { value: string } | undefined
      )?.value ?? "[]",
    ),
    mode: opts.mode,
    localAccess: !!opts.localAccess,
    accounts: store.accounts().map((a) =>
      a.platform === "instagram"
        ? {
            ...a,
            recentImport: instagrams.get(a.id)?.recentImportStatus(),
            recovery: instagrams.get(a.id)?.recoveryStatus(),
            receiveMode: instagramOptions.get(a.id)?.receiveMode ?? "polling",
            webhookConfigured:
              !!opts.metaWebhook?.appSecret && !!opts.metaWebhook?.verifyToken,
          }
        : a,
    ),
    conversations: store.conversations(),
    settings: Object.fromEntries(
      (
        db.prepare("SELECT * FROM settings").all() as {
          key: string;
          value: string;
        }[]
      ).map((s) => [s.key, s.value]),
    ),
  }));
  app.get("/api/search", async (req) => {
    const { q } = z.object({ q: z.string().max(200) }).parse(req.query);
    const rows = db
      .prepare(
        "SELECT DISTINCT conversation_id AS id FROM messages WHERE deleted_at IS NULL AND instr(search_fold(text), ?) > 0",
      )
      .all(q.toLocaleLowerCase("ru")) as { id: string }[];
    return { ids: rows.map((row) => row.id) };
  });
  app.get<{ Params: { id: string } }>(
    "/api/conversations/:id/messages",
    async (req) => {
      store.conversation(req.params.id);
      const query = z
        .object({
          limit: z.coerce.number().int().min(1).max(100).optional(),
          before: z.string().uuid().optional(),
        })
        .parse(req.query);
      return store.messages(
        req.params.id,
        query.limit ? { limit: query.limit, before: query.before } : undefined,
      );
    },
  );
  app.put<{ Params: { id: string } }>(
    "/api/conversations/:id/draft",
    async (req) => {
      store.conversation(req.params.id);
      const { text, revision } = z
        .object({
          text: z.string().max(10000),
          revision: z
            .number()
            .int()
            .nonnegative()
            .max(Number.MAX_SAFE_INTEGER)
            .default(Date.now() * 1000),
        })
        .parse(req.body);
      db.prepare(
        "UPDATE conversations SET draft=?,draft_revision=? WHERE id=? AND draft_revision<=?",
      ).run(text, revision, req.params.id, revision);
      return { ok: true };
    },
  );
  const archive = registerArchive(app, store, opts.dataDir, opts.archive);
  registerOrders(app, store);
  registerProfilePhotos(app, store, async (id) => {
    const c = store.conversation(id),
      a = store.account(c.accountId);
    if (a.mode !== "real") return null;
    return a.platform === "instagram"
      ? instagramFor(a.id).profilePhoto(id)
      : (telegrams.get(a.id)?.profilePhoto(id) ?? null);
  });
  app.post<{ Params: { id: string } }>(
    "/api/conversations/:id/read",
    async (req) => {
      const conv = store.conversation(req.params.id);
      const { unread, throughId } = z
        .object({
          unread: z.boolean(),
          throughId: z.string().uuid().optional(),
        })
        .parse(req.body);
      let remaining = 0;
      if (!unread && throughId) {
        const boundary = db
          .prepare(
            "SELECT created_at,rowid FROM messages WHERE id=? AND conversation_id=? AND direction='in' AND deleted_at IS NULL",
          )
          .get(throughId, conv.id) as
          { created_at: string; rowid: number } | undefined;
        if (!boundary) throw new Error("Сообщение для прочтения не найдено");
        const after = db
          .prepare(
            "SELECT count(*) AS count FROM messages WHERE conversation_id=? AND direction='in' AND deleted_at IS NULL AND (created_at>? OR (created_at=? AND rowid>?))",
          )
          .get(
            conv.id,
            boundary.created_at,
            boundary.created_at,
            boundary.rowid,
          ) as { count: number };
        remaining = Math.min(conv.unread, after.count);
      }
      db.prepare("UPDATE conversations SET unread=? WHERE id=?").run(
        unread ? Math.max(1, conv.unread) : remaining,
        req.params.id,
      );
      publish();
      const account = store.account(conv.accountId);
      if (
        !unread &&
        remaining === 0 &&
        account.mode === "real" &&
        account.adapter === "instagram-graph"
      ) {
        await instagramFor(account.id).markSeen(conv.id);
      }
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/conversations/:id/messages",
    async (req) => {
      const b = z
        .object({
          text: z.string().trim().max(10000),
          replyToId: z.string().uuid().optional(),
          preserveDraft: z.boolean().optional(),
          uploadId: z.string().uuid().optional(),
          key: z.string().uuid(),
        })
        .strict()
        .parse(req.body);
      if (!b.text && !b.uploadId)
        throw new Error("Добавьте текст или изображение.");
      const id = store.enqueue(req.params.id, b.text, b.key, b);
      publish();
      return { id };
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/conversations/:id/stage",
    async (req) => {
      store.conversation(req.params.id);
      const { stage } = z
        .object({ stage: z.enum(["", "new", "paid", "waiting"]) })
        .parse(req.body);
      db.prepare("UPDATE conversations SET stage=? WHERE id=?").run(
        stage,
        req.params.id,
      );
      publish();
      return { ok: true };
    },
  );
  app.put("/api/quick-replies", { bodyLimit: 3 * 1024 * 1024 }, async (req) => {
    const current =
      (
        db
          .prepare("SELECT value FROM settings WHERE key='quickReplies'")
          .get() as { value: string } | undefined
      )?.value ?? "[]";
    if (
      req.headers["if-match"] !== undefined &&
      req.headers["if-match"] !== JSON.stringify(hashToken(current))
    )
      throw Object.assign(
        new Error(
          "Шаблоны изменены другим продавцом. Скопируйте свои правки и обновите страницу.",
        ),
        { statusCode: 409 },
      );
    const slots = z
      .array(
        z
          .object({
            id: z.string().min(1).max(80).optional(),
            title: z.string().max(40),
            text: z.string().max(4000),
          })
          .strict(),
      )
      .max(MAX_QUICK_REPLIES)
      .refine((slots) => {
        const ids = slots.flatMap((s) => (s.id ? [s.id] : []));
        return new Set(ids).size === ids.length;
      }, "Повторяющиеся идентификаторы шаблонов")
      .parse(req.body);
    db.prepare(
      "INSERT INTO settings VALUES('quickReplies',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(JSON.stringify(slots));
    publish();
    return { ok: true, version: hashToken(JSON.stringify(slots)) };
  });
  app.post<{ Params: { id: string } }>(
    "/api/conversations/:id/uploads",
    { bodyLimit: 12 * 1024 * 1024 },
    async (req) => {
      store.conversation(req.params.id);
      const body = z
        .object({
          name: z.string().min(1).max(200),
          data: z
            .string()
            .regex(/^[A-Za-z0-9+/]*={0,2}$/)
            .max(12 * 1024 * 1024),
        })
        .parse(req.body);
      const bytes = Buffer.from(body.data, "base64");
      if (!bytes.length || bytes.length > 8 * 1024 * 1024)
        throw new Error("Максимальный размер изображения — 8 МБ.");
      const mime = imageMime(bytes),
        id = randomUUID();
      if (!["image/jpeg", "image/png"].includes(mime))
        throw new Error("Выберите JPG или PNG.");
      db.prepare("INSERT INTO uploads VALUES(?,?,?,?,?,?)").run(
        id,
        req.params.id,
        body.name,
        mime,
        bytes,
        new Date().toISOString(),
      );
      // Remove abandoned drafts after a day; attachments in the outbox/history are retained.
      db.prepare(
        "DELETE FROM uploads WHERE created_at < ? AND NOT EXISTS(SELECT 1 FROM messages WHERE attachments LIKE '%' || uploads.id || '%')",
      ).run(new Date(Date.now() - 86400000).toISOString());
      return { id, name: body.name };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/uploads/:id",
    async (req, reply) => {
      const row = db
        .prepare("SELECT mime,bytes FROM uploads WHERE id=?")
        .get(req.params.id) as { mime: string; bytes: Buffer } | undefined;
      if (!row)
        return reply.code(404).send({ error: "Изображение не найдено" });
      return reply
        .type(row.mime)
        .header("Cache-Control", "private, max-age=86400")
        .header("X-Content-Type-Options", "nosniff")
        .send(row.bytes);
    },
  );
  app.put("/api/settings", async (req) => {
    const { ownerName } = z
      .object({ ownerName: z.string().trim().min(1).max(80) })
      .parse(req.body);
    db.prepare(
      "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run("ownerName", ownerName);
    publish();
    return { ok: true };
  });
  app.patch<{ Params: { id: string } }>("/api/accounts/:id", async (req) => {
    store.account(req.params.id);
    const { name, color } = z
      .object({
        name: z.string().trim().min(1).max(80),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional(),
      })
      .parse(req.body);
    db.prepare(
      "UPDATE accounts SET name=?,color=COALESCE(?,color) WHERE id=?",
    ).run(name, color?.toLowerCase() ?? null, req.params.id);
    publish();
    return { ok: true };
  });
  app.post("/api/demo/incoming", async (req, reply) => {
    if (opts.mode !== "demo")
      return reply.code(403).send({ error: "Демонстрация отключена" });
    const { conversationId } = z
      .object({ conversationId: z.string() })
      .parse(req.body);
    const c = store.conversation(conversationId);
    if (store.account(c.accountId).state !== "connected")
      return reply
        .code(409)
        .send({ error: "Сначала восстановите подключение" });
    store.incoming(c.accountId, {
      externalConversationId: c.externalId,
      externalMessageId: randomUUID(),
      name: c.name,
      username: c.username,
      text: "Спасибо за ответ! Подскажите, как оформить доставку?",
    });
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>(
    "/api/demo/accounts/:id/toggle",
    async (req, reply) => {
      if (opts.mode !== "demo")
        return reply.code(403).send({ error: "Демонстрация отключена" });
      const a = store.account(req.params.id),
        connected = a.state !== "connected";
      db.prepare(
        "UPDATE accounts SET state=?,error=?,last_sync=CASE WHEN ? THEN ? ELSE last_sync END WHERE id=?",
      ).run(
        connected ? "connected" : "offline",
        connected ? null : "Демо: соединение потеряно",
        connected ? 1 : 0,
        new Date().toISOString(),
        a.id,
      );
      publish();
      return { ok: true };
    },
  );
  app.get("/api/events", { compress: false }, async (req, reply) => {
    reply.hijack();
    for (const [name, value] of Object.entries(reply.getHeaders()))
      if (value !== undefined) reply.raw.setHeader(name, value);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write("data: connected\n\n");
    clients.add(reply.raw);
    const timer = setInterval(() => {
      const valid = db
        .prepare("SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?")
        .get(hashToken(req.cookies.session ?? ""), Date.now());
      if (!opts.localAccess && !valid) reply.raw.end();
      else sendEvent(clients, reply.raw, ": heartbeat\n\n");
    }, 15000);
    req.raw.on("close", () => {
      clearInterval(timer);
      clients.delete(reply.raw);
    });
  });
  await app.register(staticFiles, {
    root: path.join(opts.dataDir, "attachments"),
    prefix: "/api/files/",
    decorateReply: false,
    index: false,
  });
  if (existsSync(path.resolve("dist"))) {
    await app.register(staticFiles, {
      root: path.resolve("dist"),
      setHeaders(res, file) {
        if (res.request.url.startsWith("/api/")) {
          res.header("Cache-Control", "no-store");
          return;
        }
        res.header(
          "Cache-Control",
          /[/\\]assets[/\\].+-[a-zA-Z0-9_-]+\.(js|css)$/.test(file)
            ? "public, max-age=604800, immutable"
            : "no-cache",
        );
      },
    });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply.code(404).send({ error: "Маршрут не найден" })
        : reply.sendFile("index.html"),
    );
  }
  const timer =
    opts.worker === false
      ? undefined
      : setInterval(() => {
          void store
            .tick()
            .catch(() => console.warn("Message queue tick failed"));
        }, 500);
  const pushTimer =
    opts.worker === false
      ? undefined
      : setInterval(() => {
          void push
            .flush()
            .catch(() => console.warn("Web Push queue unavailable"));
        }, 5000);
  app.addHook("preClose", async () => {
    clearInterval(pushTimer);
    await push.close();
    clearTimeout(publishTimer);
    inbox.close();
    clearInterval(timer);
    for (const c of clients) c.end();
    await Promise.all([...telegrams.values()].map((t) => t.close()));
    await Promise.all([...instagrams.values()].map((i) => i.close()));
  });
  app.addHook("onClose", async () => {
    clearInterval(timer);
    for (const c of clients) c.end();
    while (store.busy) await new Promise((r) => setTimeout(r, 10));
    db.close();
  });
  return { app, store, db, archive };
}
