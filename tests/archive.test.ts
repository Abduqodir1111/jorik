import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ArchiveIndex } from "../server/archive-index.js";
import { ArchiveVideo } from "../server/archive-video.js";
import { SynologySharing } from "../server/archive-synology.js";
import { ArchiveOPDS } from "../server/archive-opds.js";
import { createApp } from "../server/app.js";
import { seed } from "../server/store.js";
const temp = () => fs.mkdtemp(path.join(os.tmpdir(), "jorik-archive-test-"));
test("Archive index: two levels, case-insensitive videos, filtered service files, stale scan retention and symlink containment", async () => {
  const dir = await temp();
  const books = path.join(dir, "books"),
    videos = path.join(dir, "videos");
  await fs.mkdir(path.join(books, "Берсерк", "Том 12", "Hidden deep"), {
    recursive: true,
  });
  await fs.mkdir(path.join(books, "Однотомник"), { recursive: true });
  for (const name of [".private", "@eaDir", "#recycle"])
    await fs.mkdir(path.join(books, name));
  await fs.writeFile(path.join(books, "ignored.pdf"), "x");
  await fs.mkdir(path.join(videos, "one"), { recursive: true });
  for (const n of [
    "ОБЗОР.MOV",
    "ready.Mp4",
    "skip.chat.mp4",
    "skip.tmp.mp4",
    ".hidden.MOV",
  ])
    await fs.writeFile(path.join(videos, "one", n), "video");
  await fs.symlink(os.tmpdir(), path.join(books, "outside"));
  const index = new ArchiveIndex([
    { path: books, share: "/Books", source: "Storebooks", videos: false },
    { path: videos, share: "/Обзоры", source: "Mangastore", videos: true },
  ]);
  try {
    assert.equal(await index.build(), true);
    assert.equal(index.list().length, 5);
    assert.equal(index.search("Том 12")[0].name, "Берсерк / Том 12");
    assert.equal(index.search("Однотомник").length, 1);
    assert.equal(index.search("бЕРсерк").length, 2);
    assert.equal(index.list().filter((e) => e.type === "video").length, 2);
    assert.equal("path" in index.search("Том 12")[0], false);
    const e = index.list().find((e) => e.name === "Однотомник")!;
    await fs.rmdir(e.path);
    await fs.symlink(os.tmpdir(), e.path);
    await assert.rejects(index.get(e.id));
    await fs.rename(videos, videos + "-missing");
    assert.equal(await index.build(), false);
    assert.equal(index.list().length, 5);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("Archive API auth, persistent idempotency, deferred preparation, preserved drafts and one existing outbox send", async () => {
  const dir = await temp(),
    root = path.join(dir, "reviews");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "test.mp4"), "original");
  const { app, archive, store, db } = await createApp({
    mode: "demo",
    dataDir: dir,
    worker: false,
    localAccess: true,
    archive: {
      roots: [
        { path: root, share: "/Reviews", source: "Storebooks", videos: true },
      ],
    },
  });
  try {
    seed(store);
    await archive.rebuild();
    const e = archive.index.list()[0],
      c = store.conversations()[0];
    const cache = path.join(dir, "archive-cache");
    await fs.mkdir(cache);
    const file = path.join(cache, "prepared.chat.mp4");
    await fs.writeFile(file, "prepared");
    let preparations = 0;
    archive.video.prepare = async () => {
      preparations++;
      return { file, size: 8, duration: 1, width: 320, height: 240 };
    };
    await archive.rebuild();
    await app.inject("/api/archive/search?q=test");
    await archive.tick();
    assert.equal(
      preparations,
      0,
      "Indexing, search and idle worker must not prepare videos",
    );
    const before = (db.prepare("SELECT count(*) n FROM messages").get() as any)
      .n;
    db.prepare("UPDATE conversations SET draft='не потерять' WHERE id=?").run(
      c.id,
    );
    const payload = {
      id: e.id,
      conversationId: c.id,
      idempotencyKey: randomUUID(),
    };
    const post = () =>
      app.inject({ method: "POST", url: "/api/archive/send-video", payload });
    const first = await post();
    assert.equal(first.statusCode, 202);
    const job = first.json();
    assert.equal(job.state, "preparing");
    assert.equal(preparations, 0);
    assert.equal((await post()).json().id, job.id);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/archive/send-video",
          payload: { ...payload, path: "/etc/passwd" },
        })
      ).statusCode,
      400,
    );
    await archive.tick();
    await archive.tick();
    assert.equal(preparations, 1);
    const jobs = await app.inject("/api/archive/jobs/" + job.id);
    assert.equal(jobs.json().state, "queued");
    assert.equal(store.conversation(c.id).draft, "не потерять");
    assert.equal(
      (db.prepare("SELECT count(*) n FROM messages").get() as any).n,
      before + 1,
    );
    const m = store.messages(c.id).at(-1)!;
    assert.equal(m.attachments[0].kind, "video");
    await store.tick();
    assert.equal(
      (await app.inject("/api/archive/jobs/" + job.id)).json().state,
      "sent",
    );
    assert.equal((await post()).json().id, job.id);
    const range = await app.inject({
      url: "/api/archive/video/" + job.id,
      headers: { range: "bytes=0-3" },
    });
    assert.equal(range.statusCode, 206);
    assert.equal(range.headers["cache-control"], "no-store");
    assert.equal(range.body, "prep");
    assert.equal(
      (await app.inject("/api/archive/search?q=te")).json()[0].id,
      e.id,
    );
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
  const secure = await createApp({ mode: "demo", dataDir: dir, worker: false });
  try {
    for (const url of [
      "/api/archive/status",
      "/api/archive/search?q=test",
      "/api/archive/flibusta/search?q=test",
    ])
      assert.equal((await secure.app.inject(url)).statusCode, 401);
    assert.equal(
      (
        await secure.app.inject({
          url: "/api/archive/reindex",
          method: "POST",
          payload: {},
        })
      ).statusCode,
      401,
    );
  } finally {
    await secure.app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("Synology scoped links: login renewal, deduplication, persistent cache and expiry", async () => {
  const dir = await temp(),
    { app, db } = await createApp({
      mode: "demo",
      dataDir: dir,
      worker: false,
    });
  let logins = 0,
    creates = 0;
  const service = new SynologySharing(db, {
    url: "http://127.0.0.1:5000",
    username: "service",
    password: "test-only",
    fetcher: (async (_url, opts) => {
      const p = opts?.body as URLSearchParams;
      if (p.get("api") === "SYNO.API.Auth") {
        logins++;
        return Response.json({
          success: true,
          data: { sid: "session" + logins },
        });
      }
      creates++;
      assert.equal(p.get("path"), '"/Storebooks/Books/Chosen"');
      assert.match(p.get("date_expired") || "", /^"\d{4}-\d\d-\d\d"$/);
      return creates === 1
        ? Response.json({ success: false, error: { code: 119 } })
        : Response.json({
            success: true,
            data: { links: [{ url: "https://gofile.me/selected" }] },
          });
    }) as typeof fetch,
  });
  try {
    assert.deepEqual(
      await Promise.all([
        service.get("/Storebooks/Books/Chosen"),
        service.get("/Storebooks/Books/Chosen"),
      ]),
      ["https://gofile.me/selected", "https://gofile.me/selected"],
    );
    assert.equal(logins, 2);
    assert.equal(creates, 2);
    assert.equal(
      await service.get("/Storebooks/Books/Chosen"),
      "https://gofile.me/selected",
    );
    assert.equal(creates, 2);
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("OPDS rejects external acquisition paths/entities/redirects and streams book downloads", async () => {
  const xml =
    '<feed><entry><id>1</id><title>Книга</title><author><name>Автор</name></author><link rel="http://opds-spec.org/acquisition/open-access" href="/b/123/epub"/><link rel="http://opds-spec.org/acquisition/open-access" href="https://evil.example/b/1/epub"/></entry></feed>';
  const service = new ArchiveOPDS("https://example.com", (async (url, opts) => {
    assert.equal(opts?.redirect, "manual");
    return new URL(String(url)).pathname.startsWith("/opds")
      ? new Response(xml)
      : new Response("book-data", {
          headers: { "Content-Type": "application/epub+zip" },
        });
  }) as typeof fetch);
  const list = await service.search("книга");
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].formats, [
    { ext: "epub", downloadPath: "/b/123/epub" },
  ]);
  await assert.rejects(service.download("//evil.example"));
  await assert.rejects(service.download("/b/1/epub?next=evil"));
  const { stream } = await service.download("/b/123/epub");
  let text = "";
  for await (const part of stream) text += part.toString();
  assert.equal(text, "book-data");
  const invalid = new ArchiveOPDS(
    "https://example.com",
    (async () => new Response("<!DOCTYPE foo><feed/>")) as typeof fetch,
  );
  await assert.rejects(invalid.search("xx"));
});
test(
  "Archive video uses a separate cache, bounded conversion, deduplication and preserves original",
  { timeout: 30000 },
  async () => {
    const dir = await temp(),
      root = path.join(dir, "reviews");
    await fs.mkdir(root);
    const file = path.join(root, "clip.MOV");
    await promisify(execFile)("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=160x240:d=1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      file,
    ]);
    const index = new ArchiveIndex([
      { path: root, share: "/Reviews", source: "Storebooks", videos: true },
    ]);
    await index.build();
    const video = new ArchiveVideo(index, path.join(dir, "cache"));
    try {
      const before = await fs.stat(file);
      const id = index.list()[0].id;
      const one = video.prepare(id),
        two = video.prepare(id, true);
      assert.equal(one, two);
      const result = await one;
      assert.ok(result.size < 18 * 1024 * 1024);
      assert.ok(result.file.startsWith(path.join(dir, "cache")));
      assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
      const cachedStat = await fs.stat(result.file);
      assert.equal((await video.prepare(id)).file, result.file);
      await video.close();
      // A new instance must use the persisted file without invoking an encoder.
      const restarted = new ArchiveVideo(
        index,
        path.join(dir, "cache"),
        "/encoder-must-not-run",
      );
      try {
        assert.equal((await restarted.prepare(id)).file, result.file);
        assert.equal((await fs.stat(result.file)).mtimeMs, cachedStat.mtimeMs);
      } finally {
        await restarted.close();
      }
      assert.equal((await fs.readdir(root)).length, 1);
    } finally {
      await video.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);
test("Lazy history pages preserve ordering, off-page replies and all older messages", async () => {
  const dir = await temp(),
    { app, store, db } = await createApp({
      mode: "demo",
      dataDir: dir,
      worker: false,
      localAccess: true,
    });
  try {
    seed(store);
    const c = store.conversations()[0];
    db.prepare("DELETE FROM outbox WHERE conversation_id=?").run(c.id);
    db.prepare("DELETE FROM messages WHERE conversation_id=?").run(c.id);
    const ids: string[] = [];
    for (let i = 0; i < 85; i++) {
      const id = randomUUID();
      ids.push(id);
      db.prepare(
        "INSERT INTO messages(id,conversation_id,external_id,direction,text,status,created_at) VALUES(?,?,?,'in',?,'sent',?)",
      ).run(
        id,
        c.id,
        String(i),
        "page " + i,
        new Date(1700000000000 + i * 1000).toISOString(),
      );
    }
    db.prepare("UPDATE messages SET reply_to_id=? WHERE id=?").run(
      ids[0],
      ids[84],
    );
    const all = store.messages(c.id);
    let cursor = "",
      fetched: any[] = [];
    do {
      const r = await app.inject(
        `/api/conversations/${c.id}/messages?limit=40${cursor ? "&before=" + cursor : ""}`,
      );
      assert.equal(r.statusCode, 200);
      const batch = r.json();
      if (!cursor) assert.equal(batch.at(-1).reply_to.text, "page 0");
      fetched = [...batch, ...fetched];
      cursor = batch.length === 40 ? batch[0].id : "";
    } while (cursor);
    assert.deepEqual(
      fetched.map((m) => m.id),
      all.map((m) => m.id),
    );
    assert.equal(new Set(fetched.map((m) => m.id)).size, 85);
    assert.equal(
      (await app.inject(`/api/conversations/${c.id}/messages?limit=100000`))
        .statusCode,
      400,
    );
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("Telegram archive upload streams 512KB parts and incremental MD5 without whole-file buffers", async () => {
  const { uploadArchiveTelegram } =
    await import("../server/archive-telegram-upload.js");
  const { Api } = await import("teleproto");
  const { createHash } = await import("node:crypto");
  const dir = await temp(),
    file = path.join(dir, "file.mp4"),
    bytes = Buffer.alloc(1024 * 1024 + 123, 65);
  await fs.writeFile(file, bytes);
  const calls: any[] = [];
  try {
    const uploaded = await uploadArchiveTelegram(
      {
        invoke: async (req: any) => {
          calls.push(req);
          return true;
        },
      } as any,
      file,
      bytes.length,
    );
    assert.equal(calls.length, 3);
    assert.ok(
      calls.every(
        (r) =>
          r.bytes.length <= 512 * 1024 && r instanceof Api.upload.SaveFilePart,
      ),
    );
    assert.equal(
      (uploaded as any).md5Checksum,
      createHash("md5").update(bytes).digest("hex"),
    );
    assert.equal((uploaded as any).parts, 3);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("Instagram archive video streams multipart once and submits native video attachment once", async () => {
  const { openDb } = await import("../server/db.js"),
    { Store } = await import("../server/store.js"),
    { InstagramIntegration } = await import("../server/instagram.js");
  const dir = await temp(),
    db = openDb(dir, "real"),
    store = new Store(db);
  const reports: any[] = [];
  store.reportArchiveProgress = (id, p) => reports.push({ id, ...p });
  let uploads = 0,
    sends = 0,
    fail = false;
  const integration = new InstagramIntegration(store, {
    token: "private-test",
    fetcher: (async (url: string, options: RequestInit) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/message_attachments")) {
        uploads++;
        assert.equal(options.redirect, "error");
        assert.equal(
          (options.headers as any).Authorization,
          "Bearer private-test",
        );
        let bytes = 0;
        let start = "";
        for await (const chunk of options.body as any) {
          bytes += Buffer.byteLength(chunk);
          if (!start) start = String(chunk);
        }
        assert.match(start, /"type":"video"/);
        assert.equal(bytes, Number((options.headers as any)["Content-Length"]));
        return Response.json({ attachment_id: "uploaded-video" });
      }
      if (options.method === "POST") {
        sends++;
        assert.equal(reports.at(-1)?.phase, "confirming");
        assert.deepEqual(JSON.parse(String(options.body)).message, {
          attachment: {
            type: "video",
            payload: { attachment_id: "uploaded-video" },
          },
        });
        if (fail) throw new Error("connection lost");
        return Response.json({ message_id: "video-" + sends });
      }
      if (u.pathname.endsWith("/me"))
        return Response.json({
          id: "page",
          instagram_business_account: { id: "business", username: "shop" },
        });
      return Response.json({
        data: [
          {
            id: "thread",
            updated_time: new Date().toISOString(),
            participants: {
              data: [
                { id: "business" },
                { id: "customer", username: "client" },
              ],
            },
            messages: {
              data: [
                {
                  id: "in-1",
                  created_time: new Date().toISOString(),
                  from: { id: "customer" },
                  message: "question",
                },
              ],
            },
          },
        ],
      });
    }) as typeof fetch,
  });
  try {
    await integration.sync();
    const c = store.conversations()[0],
      file = path.join(dir, "file.mp4");
    await fs.writeFile(file, "streaming-video");
    const add = () => {
      const id = randomUUID(),
        key = randomUUID();
      db.prepare(
        "INSERT INTO archive_jobs(id,idempotency_key,conversation_id,entry_id,file,size,duration,width,height,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).run(id, key, c.id, "entry", file, 15, 1, 160, 240, Date.now());
      const mid = store.enqueue(c.id, "", key, { archiveJobId: id });
      db.prepare(
        "UPDATE archive_jobs SET message_id=?,state='queued' WHERE id=?",
      ).run(mid, id);
      return mid;
    };
    const first = add();
    await store.tick();
    assert.ok(
      reports.some(
        (p) =>
          p.id === first &&
          p.phase === "uploading" &&
          p.bytesSent === 15 &&
          p.totalBytes === 15 &&
          p.percent === 100,
      ),
    );
    assert.equal(reports.at(-1)?.phase, "complete");
    assert.equal(
      store.messages(c.id).find((m) => m.id === first)?.status,
      "sent",
    );
    assert.equal(sends, 1);
    assert.equal(uploads, 1);
    fail = true;
    const second = add();
    await store.tick();
    assert.equal(
      store.messages(c.id).find((m) => m.id === second)?.status,
      "unknown",
    );
    await store.tick();
    assert.equal(sends, 2, "uncertain delivery must never auto-repeat");
    assert.equal(uploads, 2);
  } finally {
    await integration.close();
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("Index snapshot survives restart and rejects changed root mappings", async () => {
  const dir = await temp(),
    root = path.join(dir, "books");
  await fs.mkdir(path.join(root, "Book"), { recursive: true });
  try {
    const roots = [
        {
          path: root,
          share: "/Books",
          source: "Storebooks" as const,
          videos: false,
        },
      ],
      index = new ArchiveIndex(roots);
    assert.equal(await index.build(), true);
    const snapshot = path.join(dir, "index.json");
    await index.save(snapshot);
    const restored = new ArchiveIndex(roots);
    assert.equal(await restored.load(snapshot), true);
    assert.deepEqual(restored.search("Book"), index.search("Book"));
    const changed = new ArchiveIndex([{ ...roots[0], share: "/Other" }]);
    assert.equal(await changed.load(snapshot), false);
    assert.equal(changed.count, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("Gzip leaves SSE unbuffered and static cache policy preserves authenticated files and SW", async () => {
  const { gunzipSync } = await import("node:zlib");
  const dir = await temp(),
    { app, store } = await createApp({
      mode: "demo",
      dataDir: dir,
      worker: false,
      localAccess: true,
    });
  try {
    seed(store);
    const state = await app.inject({
      url: "/api/state",
      headers: { "accept-encoding": "gzip" },
    });
    assert.equal(state.headers["content-encoding"], "gzip");
    assert.equal(state.headers["cache-control"], "no-store");
    assert.equal(
      JSON.parse(gunzipSync(state.rawPayload).toString()).accounts.length,
      4,
    );
    assert.equal(
      (await app.inject("/sw.js")).headers["cache-control"],
      "no-store",
    );
    assert.equal((await app.inject("/")).headers["cache-control"], "no-cache");
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address() as { port: number };
    const r = await fetch(`http://127.0.0.1:${addr.port}/api/events`, {
      headers: { "accept-encoding": "gzip" },
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-encoding"), null);
    const reader = r.body!.getReader();
    assert.match(
      new TextDecoder().decode((await reader.read()).value),
      /connected/,
    );
    await reader.cancel();
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test(
  "DSM cold login exceeding ten seconds succeeds and uses the current entry endpoint",
  { timeout: 16000 },
  async () => {
    const dir = await temp(),
      { app, db } = await createApp({
        mode: "demo",
        dataDir: dir,
        worker: false,
      });
    const sharing = new SynologySharing(db, {
      url: "https://example.com:5001",
      username: "service",
      password: "test-only",
      fetcher: (async (url, opts) => {
        assert.equal(new URL(String(url)).pathname, "/webapi/entry.cgi");
        const p = opts?.body as URLSearchParams;
        if (p.get("api") === "SYNO.API.Auth") {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 11000);
            opts?.signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(opts.signal?.reason);
              },
              { once: true },
            );
          });
          return Response.json({
            success: true,
            data: { sid: "test-session" },
          });
        }
        return Response.json({
          success: true,
          data: { links: [{ url: "https://gofile.me/test-only" }] },
        });
      }) as typeof fetch,
    });
    try {
      assert.equal(
        await sharing.get("/Storebooks/Books/Example"),
        "https://gofile.me/test-only",
      );
    } finally {
      await app.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);
test("OPDS supports the provider fixed /opds download suffix, same-origin absolute links and zipped FB2", async () => {
  const xml =
    '<feed><entry><id>one</id><title>Public domain</title><author><name>Author</name></author><link rel="http://opds-spec.org/acquisition/open-access" href="/b/123/fb2/opds"/><link rel="http://opds-spec.org/acquisition/open-access" href="https://example.com/b/123/epub/opds"/><link rel="http://opds-spec.org/acquisition/open-access" href="https://evil.example/b/123/mobi/opds"/></entry></feed>';
  const service = new ArchiveOPDS("https://example.com", (async (url) =>
    new URL(String(url)).pathname.startsWith("/opds/")
      ? new Response(xml)
      : new Response("zip-data", {
          headers: { "Content-Type": "application/zip" },
        })) as typeof fetch);
  const books = await service.search("title");
  assert.deepEqual(books[0].formats, [
    { ext: "fb2", downloadPath: "/b/123/fb2/opds" },
    { ext: "epub", downloadPath: "/b/123/epub/opds" },
  ]);
  const { stream, extension } = await service.download("/b/123/fb2/opds");
  assert.equal(extension, "fb2.zip");
  let text = "";
  for await (const chunk of stream) text += chunk.toString();
  assert.equal(text, "zip-data");
  await assert.rejects(service.download("/b/123/fb2/opds/../../secret"));
  const html = new ArchiveOPDS(
    "https://example.com",
    (async () =>
      new Response("<html><body>Unavailable</body></html>")) as typeof fetch,
  );
  await assert.rejects(html.search("title"), /OPDS/);
});
test("Telegram native archive video accepts short confirmation and early echo, never retries ambiguous send", async () => {
  const { Api } = await import("teleproto"),
    { openDb } = await import("../server/db.js"),
    { Store } = await import("../server/store.js"),
    { TelegramIntegration } = await import("../server/telegram.js");
  const dir = await temp(),
    db = openDb(dir, "real"),
    store = new Store(db),
    integration = new TelegramIntegration(store, {
      apiId: 123,
      apiHash: "a".repeat(32),
      encryptionKey: "b".repeat(64),
    });
  try {
    db.prepare(
      "UPDATE accounts SET state='connected' WHERE id='telegram-1'",
    ).run();
    db.prepare("INSERT INTO telegram_peers VALUES(?,?,?,?,?)").run(
      "telegram-1",
      "12345",
      "67890",
      "Test",
      "test",
    );
    const cid = randomUUID();
    db.prepare(
      "INSERT INTO conversations(id,account_id,external_id,name,username,updated_at) VALUES(?,?,?,?,?,?)",
    ).run(cid, "telegram-1", "12345", "Test", "test", new Date().toISOString());
    Object.defineProperty(integration, "authenticated", {
      value: true,
      writable: true,
    });
    let kind = "short",
      sends = 0,
      current = "";
    integration.client = {
      connected: true,
      destroy: async () => {},
      invoke: async (request: any) => {
        if (request instanceof Api.upload.SaveFilePart) {
          assert.ok(request.bytes.length <= 512 * 1024);
          return true;
        }
        assert.ok(request instanceof Api.messages.SendMedia);
        sends++;
        assert.equal((request.peer as any).userId.toString(), "12345");
        assert.equal(request.media.mimeType, "video/mp4");
        assert.equal(
          request.media.attributes.find(
            (a: any) => a instanceof Api.DocumentAttributeVideo,
          ).supportsStreaming,
          true,
        );
        if (kind === "ambiguous") throw new Error("lost response");
        if (kind === "echo") {
          db.prepare("UPDATE messages SET external_id='992' WHERE id=?").run(
            current,
          );
          return new Api.Updates({
            updates: [],
            users: [],
            chats: [],
            date: Math.floor(Date.now() / 1000),
            seq: 1,
          });
        }
        return new Api.UpdateShortSentMessage({
          id: 991,
          pts: 1,
          ptsCount: 1,
          date: Math.floor(Date.now() / 1000),
          out: true,
        });
      },
    } as any;
    const file = path.join(dir, "sample.mp4");
    await fs.writeFile(file, "video-bytes");
    const add = () => {
      const id = randomUUID(),
        key = randomUUID();
      db.prepare(
        "INSERT INTO archive_jobs(id,idempotency_key,conversation_id,entry_id,file,size,duration,width,height,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).run(id, key, cid, "entry", file, 11, 1, 160, 240, Date.now());
      current = store.enqueue(cid, "", key, { archiveJobId: id });
      db.prepare(
        "UPDATE archive_jobs SET message_id=?,state='queued' WHERE id=?",
      ).run(current, id);
      return current;
    };
    const first = add();
    await store.tick();
    assert.equal(
      store.messages(cid).find((m) => m.id === first)?.status,
      "sent",
    );
    assert.equal(
      store.messages(cid).find((m) => m.id === first)?.externalId,
      "991",
    );
    kind = "echo";
    const second = add();
    await store.tick();
    assert.equal(
      store.messages(cid).find((m) => m.id === second)?.status,
      "sent",
    );
    assert.equal(
      store.messages(cid).find((m) => m.id === second)?.externalId,
      "992",
    );
    kind = "ambiguous";
    const third = add();
    await store.tick();
    assert.equal(
      store.messages(cid).find((m) => m.id === third)?.status,
      "unknown",
    );
    await store.tick();
    assert.equal(sends, 3);
  } finally {
    await integration.close();
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("Recent history pagination retains the authoritative last incoming timestamp for Instagram reply windows", async () => {
  const dir = await temp(),
    { app, store, db } = await createApp({
      dataDir: dir,
      mode: "demo",
      worker: false,
      localAccess: true,
    });
  try {
    seed(store);
    const c = store.conversations().find((c) => c.accountId === "instagram-1")!;
    db.prepare("DELETE FROM outbox WHERE conversation_id=?").run(c.id);
    db.prepare("DELETE FROM messages WHERE conversation_id=?").run(c.id);
    const incoming = new Date(Date.now() - 60000).toISOString();
    db.prepare(
      "INSERT INTO messages(id,conversation_id,direction,text,status,created_at) VALUES(?,?,'in','question','sent',?)",
    ).run(randomUUID(), c.id, incoming);
    for (let i = 0; i < 50; i++)
      db.prepare(
        "INSERT INTO messages(id,conversation_id,direction,text,status,created_at) VALUES(?,?,'out','answer','sent',?)",
      ).run(
        randomUUID(),
        c.id,
        new Date(Date.now() - 50000 + i * 500).toISOString(),
      );
    const recent = (
      await app.inject("/api/conversations/" + c.id + "/messages?limit=40")
    ).json();
    assert.equal(recent.length, 40);
    assert.ok(recent.every((m: any) => m.direction === "out"));
    const state = (await app.inject("/api/state")).json();
    assert.equal(
      state.conversations.find((x: any) => x.id === c.id).lastIncomingAt,
      incoming,
    );
    assert.equal(store.conversation(c.id).lastIncomingAt, incoming);
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("Slow File Station link creation returns 202, deduplicates clicks and can be polled without holding HTTP open", async () => {
  const dir = await temp(),
    root = path.join(dir, "books");
  await fs.mkdir(path.join(root, "Example"), { recursive: true });
  let release!: () => void,
    logins = 0,
    creates = 0;
  const gate = new Promise<void>((r) => (release = r));
  const { app, archive } = await createApp({
    mode: "demo",
    dataDir: dir,
    worker: false,
    localAccess: true,
    archive: {
      roots: [
        { path: root, share: "/Books", source: "Storebooks", videos: false },
      ],
      synology: {
        url: "https://example.com",
        username: "service",
        password: "test-only",
        fetcher: (async (_url, opts) => {
          const p = opts?.body as URLSearchParams;
          if (p.get("api") === "SYNO.API.Auth") {
            logins++;
            await gate;
            return Response.json({
              success: true,
              data: { sid: "test-session" },
            });
          }
          creates++;
          return Response.json({
            success: true,
            data: { links: [{ url: "https://gofile.me/test-only" }] },
          });
        }) as typeof fetch,
      },
    },
  });
  try {
    await archive.rebuild();
    const id = archive.index.list()[0].id;
    const post = () =>
      app.inject({ method: "POST", url: "/api/archive/link", payload: { id } });
    const first = await post();
    assert.equal(first.statusCode, 202);
    const task = first.json().taskId;
    assert.equal((await post()).json().taskId, task);
    assert.equal(
      (await app.inject("/api/archive/links/" + task)).json().state,
      "pending",
    );
    release();
    await new Promise((r) => setImmediate(r));
    const ready = (await app.inject("/api/archive/links/" + task)).json();
    assert.equal(ready.state, "ready");
    assert.equal(ready.url, "https://gofile.me/test-only");
    assert.equal((await post()).json().url, ready.url);
    assert.equal(logins, 1);
    assert.equal(creates, 1);
  } finally {
    release();
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("OPDS refuses off-host and insecure download redirects before requesting them", async () => {
  for (const location of [
    "https://evil.example/file",
    "http://example.com/file",
    "https://127.0.0.1/file",
  ]) {
    let requests = 0;
    const service = new ArchiveOPDS("https://example.com", (async () => {
      requests++;
      return new Response(null, { status: 302, headers: { location } });
    }) as typeof fetch);
    await assert.rejects(
      service.download("/b/123/fb2/opds"),
      /перенаправление/,
    );
    assert.equal(requests, 1);
  }
  let requests = 0;
  const service = new ArchiveOPDS("https://example.com", (async () => {
    requests++;
    return requests === 1
      ? new Response(null, {
          status: 302,
          headers: { location: "/files/book.zip" },
        })
      : new Response("book", {
          headers: { "Content-Type": "application/zip" },
        });
  }) as typeof fetch);
  const { stream, extension } = await service.download("/b/123/fb2/opds");
  let data = "";
  for await (const part of stream) data += part.toString();
  assert.equal(data, "book");
  assert.equal(extension, "fb2.zip");
  assert.equal(requests, 2);
});
