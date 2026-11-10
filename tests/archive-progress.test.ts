import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/app.js";
import { seed } from "../server/store.js";
import { archiveProgress } from "../server/archive-progress.js";
import { archiveTimeline, mergeArchiveJobs } from "../src/archive-job-state.js";
import type { ArchiveJob } from "../shared/archive.js";
import { uploadArchiveTelegram } from "../server/archive-telegram-upload.js";
async function fixture(
  run: (
    ctx: Awaited<ReturnType<typeof createApp>>,
    dir: string,
  ) => Promise<void>,
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jorik-progress-")),
    root = path.join(dir, "reviews");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "Book.mp4"), "original");
  const ctx = await createApp({
    dataDir: dir,
    mode: "demo",
    localAccess: true,
    worker: false,
    archive: {
      roots: [
        { path: root, source: "Storebooks", share: "/Review", videos: true },
      ],
    },
  });
  try {
    seed(ctx.store);
    await ctx.archive.rebuild();
    await run(ctx, dir);
  } finally {
    await ctx.app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
test("Video intent is idempotent under parallel submissions, persisted and never appears sent before provider acknowledgement", async () =>
  fixture(async ({ app, store, db, archive }, dir) => {
    const entry = archive.index.list()[0],
      c = store.conversations()[0],
      key = randomUUID();
    let publications: ArchiveJob[] = [];
    store.archiveJobChanged = (j) => publications.push(j);
    const payload = { id: entry.id, conversationId: c.id, idempotencyKey: key };
    const replies = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({ url: "/api/archive/send-video", method: "POST", payload }),
      ),
    );
    assert.ok(replies.every((r) => r.statusCode === 202));
    const job = replies[0].json();
    assert.ok(replies.every((r) => r.json().id === job.id));
    assert.equal(job.name, "Book.mp4");
    assert.equal(job.clientKey, key);
    assert.equal(job.conversationId, c.id);
    assert.equal(job.phase, "waiting");
    assert.equal(job.messageId, null);
    assert.equal(
      (db.prepare("SELECT count(*) n FROM archive_jobs").get() as any).n,
      1,
    );
    const prepared = path.join(dir, "archive-cache", "synthetic.chat.mp4");
    await fs.mkdir(path.dirname(prepared));
    await fs.writeFile(prepared, "0000ftypisom0000");
    archive.video.prepare = async () => ({
      file: prepared,
      size: 16,
      duration: 1,
      width: 320,
      height: 240,
    });
    await archive.tick();
    let current = (await app.inject("/api/archive/jobs/" + job.id)).json();
    assert.equal(current.state, "queued");
    assert.ok(current.messageId);
    assert.equal(current.phase, "queued");
    assert.equal((await app.inject("/api/archive/jobs")).json().length, 1);
    store.reportArchiveProgress(current.messageId, {
      phase: "uploading",
      percent: 40,
      bytesSent: 40,
      totalBytes: 100,
    });
    store.reportArchiveProgress(current.messageId, {
      phase: "confirming",
      percent: null,
    });
    current = (await app.inject("/api/archive/jobs/" + job.id)).json();
    assert.equal(current.phase, "confirming");
    assert.notEqual(current.state, "sent");
    assert.equal(current.percent, null);
    const reloaded = archiveProgress(store);
    assert.equal(reloaded.get(job.id).phase, "confirming");
    assert.equal(reloaded.list()[0].clientKey, key);
    await store.tick();
    current = (await app.inject("/api/archive/jobs/" + job.id)).json();
    assert.equal(current.state, "sent");
    assert.equal(current.phase, "complete");
    assert.equal(current.percent, 100);
    assert.equal(
      store.messages(c.id).filter((m) => m.id === current.messageId).length,
      1,
    );
    assert.ok(publications.some((j) => j.phase === "uploading"));
    assert.ok(publications.some((j) => j.state === "sent"));
  }));
test("Unknown provider result remains unknown after reload; preparation failures remain visible without an outbox send", async () =>
  fixture(async ({ app, archive, store, db }) => {
    const c = store.conversations()[0],
      entry = archive.index.list()[0];
    const job = (
      await app.inject({
        url: "/api/archive/send-video",
        method: "POST",
        payload: {
          id: entry.id,
          conversationId: c.id,
          idempotencyKey: randomUUID(),
        },
      })
    ).json();
    archive.video.prepare = async () => {
      throw Error("Synthetic memory shortage");
    };
    await archive.tick();
    const failed = (await app.inject("/api/archive/jobs/" + job.id)).json();
    assert.equal(failed.state, "error");
    assert.equal(failed.messageId, null);
    assert.match(failed.error, /memory/);
    assert.equal(
      (db.prepare("SELECT count(*) n FROM outbox").get() as any).n,
      0,
    );
    assert.equal((await app.inject("/api/archive/jobs")).json()[0].id, job.id);
    const mid = store.enqueue(c.id, "[неизвестно]", randomUUID());
    db.prepare(
      "UPDATE archive_jobs SET message_id=?,state='queued' WHERE id=?",
    ).run(mid, job.id);
    await store.tick();
    const unknown = archiveProgress(store).get(job.id);
    assert.equal(unknown.state, "unknown");
    assert.equal(unknown.phase, "unknown");
    assert.notEqual(unknown.percent, 100);
    await store.tick();
    assert.equal(
      (db.prepare("SELECT count(*) n FROM outbox").get() as any).n,
      1,
    );
  }));
test("Progress is throttled and does not invoke the full inbox refresh for every chunk", async () =>
  fixture(async ({ store, app, archive }) => {
    const job = (
      await app.inject({
        url: "/api/archive/send-video",
        method: "POST",
        payload: {
          id: archive.index.list()[0].id,
          conversationId: store.conversations()[0].id,
          idempotencyKey: randomUUID(),
        },
      })
    ).json();
    const tracker = archiveProgress(store);
    let targeted = 0,
      full = 0;
    store.archiveJobChanged = () => targeted++;
    store.changed = () => full++;
    for (let i = 0; i < 1000; i++)
      tracker.update(job.id, {
        phase: "uploading",
        percent: i / 10,
        bytesSent: i,
        totalBytes: 1000,
      });
    assert.ok(targeted <= 2);
    assert.equal(full, 0);
    tracker.update(job.id, { phase: "confirming", percent: null }, true);
    assert.equal(tracker.get(job.id).phase, "confirming");
  }));
test("Timeline reconciles local intent, server job and message without duplicates or cross-chat cards", () => {
  const c = randomUUID(),
    key = randomUUID();
  const local: ArchiveJob = {
    id: key,
    clientKey: key,
    conversationId: c,
    createdAt: 1,
    updatedAt: 999999,
    local: true,
    name: "Book",
    state: "preparing",
    phase: "waiting",
    error: null,
    messageId: null,
  };
  const accepted: ArchiveJob = {
    ...local,
    id: randomUUID(),
    local: false,
    updatedAt: 10,
  };
  let jobs = mergeArchiveJobs([local], [accepted]);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, accepted.id);
  jobs = mergeArchiveJobs(jobs, [
    { ...local, state: "error", updatedAt: 9999999 },
  ]);
  assert.equal(jobs[0].local, false);
  assert.equal(archiveTimeline([], jobs, "other").length, 0);
  assert.equal(archiveTimeline([], jobs, c).length, 1);
  const withMessage = {
    ...accepted,
    messageId: randomUUID(),
    state: "sending" as const,
    phase: "uploading" as const,
    updatedAt: 20,
  };
  jobs = mergeArchiveJobs(jobs, [withMessage]);
  jobs = mergeArchiveJobs(jobs, [accepted]);
  assert.equal(jobs[0].updatedAt, 20);
  const optimistic = archiveTimeline([], jobs, c);
  assert.equal(optimistic.length, 1);
  assert.equal(
    archiveTimeline(
      optimistic.map((m) => ({ ...m, archiveJob: undefined })),
      jobs,
      c,
    ).length,
    1,
  );
});
test("Telegram progress counts only acknowledged file parts", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jorik-part-progress-")),
    file = path.join(dir, "clip.mp4");
  await fs.writeFile(file, Buffer.alloc(1024 * 1024 + 1));
  let ack = 0;
  const updates: number[] = [];
  try {
    await uploadArchiveTelegram(
      {
        invoke: async () => {
          ack++;
          return true;
        },
      } as any,
      file,
      1024 * 1024 + 1,
      (bytes, total) => {
        assert.equal(ack, updates.length + 1);
        assert.ok(bytes <= total);
        updates.push(bytes);
      },
    );
    assert.deepEqual(updates, [512 * 1024, 1024 * 1024, 1024 * 1024 + 1]);
    ack = 0;
    updates.length = 0;
    await assert.rejects(
      uploadArchiveTelegram(
        {
          invoke: async () => {
            ack++;
            return ack === 1;
          },
        } as any,
        file,
        1024 * 1024 + 1,
        (bytes) => updates.push(bytes),
      ),
      /не подтвердил/,
    );
    assert.deepEqual(updates, [512 * 1024]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Archive progress reaches another browser through its own SSE event without an incoming notification", async () =>
  fixture(async ({ app, archive, store }) => {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(address + "/api/events", {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    let text = "";
    try {
      text += new TextDecoder().decode((await reader.read()).value);
      const job = (
        await app.inject({
          url: "/api/archive/send-video",
          method: "POST",
          payload: {
            id: archive.index.list()[0].id,
            conversationId: store.conversations()[0].id,
            idempotencyKey: randomUUID(),
          },
        })
      ).json();
      while (!text.includes("event: archive-job"))
        text += new TextDecoder().decode((await reader.read()).value);
      assert.ok(text.includes(job.id));
      assert.ok(text.includes(job.conversationId));
      assert.ok(!text.includes("event: incoming"));
    } finally {
      clearTimeout(timeout);
      await reader.cancel();
      controller.abort();
    }
  }));

test("An unacknowledged video intent survives reload and storage failures; confirmation permits a distinct later send", async () => {
  const { videoIntent, confirmVideoIntent } =
    await import("../src/video-intents.js");
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => map.set(k, v),
  } as unknown as Storage;
  const c = randomUUID(),
    entry = "a".repeat(24),
    first = videoIntent(entry, c, storage);
  assert.equal(videoIntent(entry, c, storage).key, first.key);
  assert.equal(
    videoIntent(entry, randomUUID(), storage).key === first.key,
    false,
  );
  const data = JSON.parse([...map.values()][0]);
  assert.ok(data.some((i: any) => i.key === first.key));
  confirmVideoIntent(first.key, storage);
  assert.notEqual(videoIntent(entry, c, storage).key, first.key);
  const blocked = {
    getItem() {
      throw Error("blocked");
    },
    setItem() {
      throw Error("blocked");
    },
  } as unknown as Storage;
  const other = randomUUID(),
    pending = videoIntent(entry, other, blocked);
  assert.equal(videoIntent(entry, other, blocked).key, pending.key);
  confirmVideoIntent(pending.key, blocked);
  assert.notEqual(videoIntent(entry, other, blocked).key, pending.key);
});

test("Provider-confirmed messages replace stale progress, while actual failures do not look like active uploads", () => {
  const c = randomUUID(),
    mid = randomUUID();
  const job: ArchiveJob = {
    id: randomUUID(),
    messageId: mid,
    conversationId: c,
    state: "sending",
    phase: "uploading",
    percent: 40,
    error: null,
    createdAt: 1,
  };
  const pending = archiveTimeline([], [job], c)[0];
  const sent = archiveTimeline(
    [{ ...pending, status: "sent", archiveJob: undefined }],
    [job],
    c,
  )[0];
  assert.equal(sent.archiveJob?.state, "sent");
  assert.equal(sent.archiveJob?.percent, 100);
  const failed = archiveTimeline(
    [
      {
        ...pending,
        status: "unknown",
        error: "No provider confirmation",
        archiveJob: undefined,
      },
    ],
    [job],
    c,
  )[0];
  assert.equal(failed.archiveJob?.state, "unknown");
  assert.equal(failed.archiveJob?.percent, null);
});
