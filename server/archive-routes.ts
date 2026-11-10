import { cachedTelegramArchiveMedia } from "./telegram-archive-media.js";
import { archiveProgress } from "./archive-progress.js";
import { ArchivePdfMetadata } from "./archive-pdf.js";
import os from "node:os";
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { mediaGate } from "./media-gate.js";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ArchiveIndex, type ArchiveRoot } from "./archive-index.js";
import { ArchiveVideo } from "./archive-video.js";
import { registerArchiveFiles } from "./archive-files.js";
import { ArchiveOPDS } from "./archive-opds.js";
import { SynologySharing, type SynologyOptions } from "./archive-synology.js";
import type { Store } from "./store.js";
import path from "node:path";
export interface ArchiveOptions {
  roots: ArchiveRoot[];
  synology?: SynologyOptions;
  opdsBase?: string;
}
export function registerArchive(
  app: FastifyInstance,
  store: Store,
  dataDir: string,
  opts?: ArchiveOptions,
) {
  const index = new ArchiveIndex(opts?.roots || []);
  const progress = archiveProgress(store);
  let progressJob: string | undefined, progressEntry: string | undefined;
  const video = new ArchiveVideo(
    index,
    path.join(dataDir, "archive-cache"),
    undefined,
    undefined,
    {
      onProgress: (percent, entryId) => {
        if (progressJob && entryId === progressEntry && !stopped)
          progress.update(progressJob, { phase: "preparing", percent });
      },
    },
  );
  store.prepareArchiveVideo = async (id, expectedKey) => {
    if (expectedKey && (await video.identity(id)).key !== expectedKey)
      throw new Error("Видео в архиве изменилось. Повторите отправку.");
    const v = await video.prepare(id, true);
    if (expectedKey && (await video.identity(id)).key !== expectedKey)
      throw new Error("Видео в архиве изменилось. Повторите отправку.");
    return v;
  };
  const pdfMetadata = new ArchivePdfMetadata(
    path.join(dataDir, "archive-pdf-metadata.json"),
  );
  registerArchiveFiles(app, index, video, pdfMetadata);
  const sharing = new SynologySharing(
    store.db,
    opts?.synology || { url: "", username: "", password: "" },
  );
  const opds = new ArchiveOPDS(opts?.opdsBase || "https://flibusta.is");
  const shutdown = new AbortController();
  const respectLoad = store.accounts().some((a) => a.mode === "real");
  let stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    scan: Promise<unknown> | undefined,
    activeJob: Promise<void> | undefined;
  const query = z.object({ q: z.string().trim().min(2).max(200) });
  const getJob = progress.get;
  const tick = async () => {
    if (stopped || activeJob || !index.updatedAt) return;
    activeJob = (async () => {
      const row = store.db
        .prepare(
          "SELECT id,entry_id,conversation_id,idempotency_key FROM archive_jobs WHERE state='preparing' ORDER BY created_at LIMIT 1",
        )
        .get() as any;
      if (!row) return;
      try {
        progressJob = row.id;
        progressEntry = row.entry_id;
        progress.update(row.id, { phase: "preparing", percent: null }, true);
        const identity = await video.identity(row.entry_id);
        const account = store.conversation(row.conversation_id).accountId;
        const reused = cachedTelegramArchiveMedia(
          store.db,
          account,
          identity.key,
        );
        // Metadata lookup only: no ffprobe/ffmpeg when Telegram already has it.
        const v = reused
          ? {
              file: identity.file,
              size: reused.size,
              duration: reused.duration,
              width: reused.width,
              height: reused.height,
            }
          : await video.prepare(row.entry_id, true);
        if ((await video.identity(row.entry_id)).key !== identity.key)
          throw new Error("Видео в архиве изменилось. Повторите отправку.");
        if (stopped) return;
        store.db.transaction(() => {
          store.db
            .prepare(
              "UPDATE archive_jobs SET file=?,size=?,duration=?,width=?,height=?,source_key=? WHERE id=?",
            )
            .run(
              v.file,
              v.size,
              v.duration,
              v.width,
              v.height,
              identity.key,
              row.id,
            );
          const messageId = store.enqueue(
            row.conversation_id,
            "",
            row.idempotency_key,
            { archiveJobId: row.id, preserveDraft: true },
          );
          store.db
            .prepare(
              "UPDATE archive_jobs SET state='queued',message_id=? WHERE id=?",
            )
            .run(messageId, row.id);
        })();
        progress.update(
          row.id,
          { phase: "queued", percent: null, totalBytes: v.size },
          true,
        );
        store.changed();
      } catch (e) {
        if (!stopped)
          store.db
            .prepare("UPDATE archive_jobs SET state='error',error=? WHERE id=?")
            .run(
              e instanceof Error ? e.message : "Не удалось подготовить видео",
              row.id,
            );
        if (!stopped)
          progress.update(row.id, { phase: "error", percent: null }, true);
      } finally {
        progressJob = undefined;
        progressEntry = undefined;
      }
    })().finally(() => {
      activeJob = undefined;
    });
    await activeJob;
  };
  const rebuild = () => {
    if (scan) return scan;
    scan = (async () => {
      while (
        !stopped &&
        respectLoad &&
        process.platform === "linux" &&
        os.loadavg()[0] > 4
      ) {
        try {
          await delay(30000, undefined, {
            signal: shutdown.signal,
            ref: false,
          });
        } catch {
          return;
        }
      }
      if (stopped) return;
      await mediaGate(async () => {
        if (stopped) return;
        const ok = await index.build();
        if (ok && !stopped)
          await index
            .save(path.join(dataDir, "archive-index.json"))
            .catch(() => {});
      });
    })().finally(() => {
      scan = undefined;
    });
    return scan;
  };
  const nextScan = () => {
    const next = new Date();
    next.setHours(3, 0, 0, 0);
    if (+next <= Date.now()) next.setDate(next.getDate() + 1);
    timer = setTimeout(() => {
      void rebuild().finally(nextScan);
    }, +next - Date.now());
    timer.unref();
  };
  app.get("/api/archive/status", async () => ({
    enabled: !!opts?.roots.length,
    indexing: index.indexing || !!scan,
    updatedAt: index.updatedAt,
    error: index.error,
    count: index.count,
    sharingConfigured: !!opts?.synology?.password,
  }));
  app.get("/api/archive/search", async (req) =>
    index.search(query.parse(req.query).q),
  );
  app.post("/api/archive/reindex", async (_req, reply) => {
    if (!opts?.roots.length) throw new Error("Папки архива не настроены");
    void rebuild();
    return reply.code(202).send({ indexing: true });
  });
  type LinkTask = {
    id: string;
    entryId: string;
    state: "pending" | "ready" | "error";
    url?: string;
    error?: string;
    expires: number;
    work?: Promise<void>;
  };
  const linkTasks = new Map<string, LinkTask>();
  app.post("/api/archive/link", async (req, reply) => {
    const { id } = z
      .object({ id: z.string().regex(/^[a-f0-9]{24}$/) })
      .parse(req.body);
    const e = await index.get(id);
    for (const [key, t] of linkTasks)
      if (t.expires < Date.now() && t.state !== "pending")
        linkTasks.delete(key);
    let task = [...linkTasks.values()].find(
      (t) => t.entryId === id && t.state !== "error",
    );
    if (!task) {
      if (linkTasks.size >= 40)
        throw new Error("Слишком много запросов ссылок. Повторите позже.");
      task = {
        id: randomUUID(),
        entryId: id,
        state: "pending",
        expires: Date.now() + 600000,
      };
      linkTasks.set(task.id, task);
      const current = task;
      current.work = sharing
        .get(e.sharePath)
        .then((url) => {
          current.url = url;
          current.state = "ready";
        })
        .catch((error) => {
          current.error =
            error instanceof Error
              ? error.message
              : "Не удалось создать ссылку";
          current.state = "error";
        });
    }
    await Promise.race([task.work, delay(200)]);
    if (task.state === "ready") return { url: task.url };
    if (task.state === "error") throw new Error(task.error);
    return reply.code(202).send({ taskId: task.id, state: "pending" });
  });
  app.get<{ Params: { id: string } }>("/api/archive/links/:id", async (req) => {
    const task = linkTasks.get(req.params.id);
    if (!task)
      throw Object.assign(
        new Error("Запрос ссылки не найден. Повторите открытие."),
        { statusCode: 404 },
      );
    return { state: task.state, url: task.url, error: task.error };
  });
  app.get("/api/archive/flibusta/search", async (req) =>
    opds.search(query.parse(req.query).q),
  );
  app.get(
    "/api/archive/flibusta/download",
    { compress: false },
    async (req, reply) => {
      const q = z
        .object({
          path: z.string().max(100),
          title: z.string().max(400).default("Книга"),
        })
        .parse(req.query);
      const { stream, extension } = await opds.download(q.path);
      const title =
        q.title
          .replace(/[\x00-\x1f\x7f/\\"<>:|?*]/g, " ")
          .trim()
          .slice(0, 160) || "Книга";
      return reply
        .type("application/octet-stream")
        .header(
          "Content-Disposition",
          `attachment; filename="book.${extension}"; filename*=UTF-8''${encodeURIComponent(title + "." + extension).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16))}`,
        )
        .send(stream);
    },
  );
  app.post("/api/archive/send-video", async (req, reply) => {
    const b = z
      .object({
        id: z.string().regex(/^[a-f0-9]{24}$/),
        conversationId: z.string().uuid(),
        idempotencyKey: z.string().uuid(),
      })
      .strict()
      .parse(req.body);
    const existing = store.db
      .prepare(
        "SELECT id,conversation_id,entry_id FROM archive_jobs WHERE idempotency_key=?",
      )
      .get(b.idempotencyKey) as any;
    if (existing) {
      if (
        existing.conversation_id !== b.conversationId ||
        existing.entry_id !== b.id
      )
        throw new Error("Ключ отправки уже используется");
      return reply.code(202).send(getJob(existing.id));
    }
    const c = store.conversation(b.conversationId),
      a = store.account(c.accountId);
    const preview = {
      id: "",
      conversationId: c.id,
      externalId: null,
      direction: "out" as const,
      text: "",
      status: "queued" as const,
      createdAt: new Date().toISOString(),
      error: null,
      attachments: [],
    };
    store.resolveAdapter(a).validateReply(a, preview);
    const entry = await index.get(b.id, "video");
    // index.get touches disk: another request may have inserted the same intent
    // during that await. Recheck before the synchronous insert.
    const raced = store.db
      .prepare(
        "SELECT id,conversation_id,entry_id FROM archive_jobs WHERE idempotency_key=?",
      )
      .get(b.idempotencyKey) as any;
    if (raced) {
      if (raced.conversation_id !== b.conversationId || raced.entry_id !== b.id)
        throw new Error("Ключ отправки уже используется");
      return reply.code(202).send(getJob(raced.id));
    }

    if (
      (
        store.db
          .prepare(
            "SELECT count(*) n FROM archive_jobs WHERE state='preparing'",
          )
          .get() as any
      ).n >= 20
    )
      throw new Error("Очередь подготовки заполнена. Дождитесь завершения.");
    const id = randomUUID();
    store.db
      .prepare(
        "INSERT INTO archive_jobs(id,idempotency_key,conversation_id,entry_id,created_at,name,updated_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        b.idempotencyKey,
        b.conversationId,
        b.id,
        Date.now(),
        entry.name,
        Date.now(),
      );
    store.archiveJobChanged(getJob(id));
    return reply.code(202).send(getJob(id));
  });
  app.get("/api/archive/jobs", async () => progress.list());
  app.get<{ Params: { id: string } }>("/api/archive/jobs/:id", async (req) =>
    getJob(req.params.id),
  );
  app.get<{ Params: { id: string } }>(
    "/api/archive/video/:id",
    { compress: false },
    async (req, reply) => {
      const row = store.db
        .prepare(
          "SELECT j.file,j.size,j.message_id,m.status,c.account_id FROM archive_jobs j LEFT JOIN messages m ON m.id=j.message_id JOIN conversations c ON c.id=j.conversation_id WHERE j.id=? AND j.file IS NOT NULL",
        )
        .get(req.params.id) as any;
      if (
        !row ||
        !path
          .resolve(row.file)
          .startsWith(path.resolve(dataDir, "archive-cache") + path.sep)
      )
        return reply.code(404).send({ error: "Видео не найдено" });
      try {
        await fs.stat(row.file);
      } catch (e) {
        if (
          (e as NodeJS.ErrnoException).code === "ENOENT" &&
          row.status === "sent" &&
          row.account_id.startsWith("telegram-") &&
          row.message_id
        )
          return reply.redirect(
            "/api/telegram/videos/" + encodeURIComponent(row.message_id),
          );
        throw e;
      }
      // Fastify static's file sender supports Range without reading the whole video into RAM.
      return reply.sendFile(
        path.basename(row.file),
        path.resolve(dataDir, "archive-cache"),
      );
    },
  );
  let worker: ReturnType<typeof setInterval> | undefined;
  app.addHook("onListen", async () => {
    if (opts?.roots.length) {
      timer = setTimeout(() => {
        void (async () => {
          const loaded = await index.load(
            path.join(dataDir, "archive-index.json"),
          );
          if (
            !loaded ||
            !index.updatedAt ||
            Date.now() - Date.parse(index.updatedAt) > 86400000
          )
            await rebuild();
          if (!stopped) nextScan();
        })();
      }, 1500);
      timer.unref();
      worker = setInterval(() => void tick(), 1000);
      worker.unref();
    }
  });
  app.addHook("preClose", async () => {
    stopped = true;
    shutdown.abort();
    index.close();
    clearTimeout(timer);
    clearInterval(worker);
    await video.close();
    await activeJob;
    await scan;
  });
  return { index, video, pdfMetadata, tick, rebuild };
}
