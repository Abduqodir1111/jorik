import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import bigInt from "big-integer";
import { Api } from "teleproto";
import { randomUUID } from "node:crypto";
import { openDb } from "../server/db.js";
import { SendFailure } from "../server/adapters.js";
import {
  cachedTelegramArchiveMedia,
  sendTelegramArchive,
} from "../server/telegram-archive-media.js";
import { createApp } from "../server/app.js";
import { seed } from "../server/store.js";
function document(ref = "fresh") {
  return new Api.Document({
    id: bigInt(123456),
    accessHash: bigInt(765432),
    fileReference: Buffer.from(ref),
    date: 1,
    mimeType: "video/mp4",
    size: bigInt(16),
    dcId: 2,
    attributes: [
      new Api.DocumentAttributeVideo({
        duration: 1,
        w: 320,
        h: 240,
        supportsStreaming: true,
      }),
    ],
  });
}
function media(doc = document()) {
  return new Api.MessageMediaDocument({ document: doc });
}
async function fixture(run: (f: any) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jorik-tg-reuse-"));
  const db = openDb(dir, "real");
  const file = path.join(dir, "video.mp4");
  await fs.writeFile(file, "0000ftypisom0000");
  db.prepare(
    "INSERT INTO telegram_sessions(account_id,ciphertext,user_id) VALUES(?,?,?)",
  ).run("telegram-1", "test-only", "100");
  db.prepare(
    "INSERT INTO telegram_sessions(account_id,ciphertext,user_id) VALUES(?,?,?)",
  ).run("telegram-2", "test-only", "200");
  const events: string[] = [],
    sends: Api.messages.SendMedia[] = [],
    phases: string[] = [];
  let next = 50;
  const client = {
    invoke: async (r: any) => {
      if (
        r instanceof Api.upload.SaveFilePart ||
        r instanceof Api.upload.SaveBigFilePart
      ) {
        events.push("upload");
        return true;
      }
      assert.ok(r instanceof Api.messages.SendMedia);
      sends.push(r);
      events.push(r.media instanceof Api.InputMediaDocument ? "reuse" : "new");
      return new Api.UpdateShortSentMessage({
        id: next++,
        pts: 1,
        ptsCount: 1,
        date: 1,
        out: true,
        media: media(),
      });
    },
    getMessages: async () => {
      events.push("refresh");
      return [{ media: media() }];
    },
  };
  const options = {
    db,
    client,
    account: "telegram-1",
    peerId: "800",
    peer: (id: string) =>
      new Api.InputPeerUser({ userId: bigInt(id), accessHash: bigInt(11) }),
    random: "999",
    messageId: "unused",
    archive: {
      file,
      size: 16,
      duration: 1,
      width: 320,
      height: 240,
      source_key: "a".repeat(64),
      entry_id: "book",
    },
    progress: (p: any) => phases.push(p.phase),
  };
  try {
    await run({ db, dir, file, options, events, sends, phases, client });
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
test("First video upload is cached; a different customer reuses it without bytes or local file, after DB reopen", async () =>
  fixture(async (f) => {
    assert.deepEqual(await sendTelegramArchive(f.options), {
      externalId: "50",
    });
    assert.deepEqual(f.events, ["upload", "new"]);
    assert.ok(
      cachedTelegramArchiveMedia(
        f.db,
        "telegram-1",
        f.options.archive.source_key,
      ),
    );
    await fs.unlink(f.file);
    f.events.length = 0;
    f.phases.length = 0;
    const db2 = openDb(f.dir, "real");
    try {
      await sendTelegramArchive({
        ...f.options,
        db: db2,
        peerId: "801",
        random: "1000",
      });
    } finally {
      db2.close();
    }
    assert.deepEqual(f.events, ["reuse"]);
    assert.deepEqual(f.phases, ["reusing"]);
    assert.equal(f.sends[1].peer.userId.toString(), "801");
    assert.equal(f.sends[1].randomId.toString(), "1000");
    assert.equal(f.sends[1].message, "");
    assert.ok(f.sends[1].media instanceof Api.InputMediaDocument);
    assert.equal(f.sends[1].media.id.id.toString(), "123456");
  }));
test("Telegram cache is separated by sending account, identity and source version", async () =>
  fixture(async (f) => {
    await sendTelegramArchive(f.options);
    assert.equal(
      cachedTelegramArchiveMedia(
        f.db,
        "telegram-2",
        f.options.archive.source_key,
      ),
      undefined,
    );
    assert.equal(
      cachedTelegramArchiveMedia(f.db, "telegram-1", "changed"),
      undefined,
    );
    f.db
      .prepare(
        "UPDATE telegram_sessions SET user_id='different' WHERE account_id='telegram-1'",
      )
      .run();
    assert.equal(
      cachedTelegramArchiveMedia(
        f.db,
        "telegram-1",
        f.options.archive.source_key,
      ),
      undefined,
    );
    f.events.length = 0;
    await sendTelegramArchive(f.options);
    assert.deepEqual(f.events, ["upload", "new"]);
  }));
test("Expired reference is refreshed once from its source and sent with the SAME random_id, without upload", async () =>
  fixture(async (f) => {
    await sendTelegramArchive(f.options);
    f.events.length = 0;
    const invoke = f.client.invoke;
    let attempts = 0;
    f.client.invoke = async (r: any) => {
      if (r instanceof Api.messages.SendMedia && ++attempts === 1) {
        assert.equal(r.randomId.toString(), "999");
        f.events.push("expired");
        throw { errorMessage: "FILE_REFERENCE_EXPIRED" };
      }
      assert.equal(r.media.id.fileReference.toString(), "renewed");
      return invoke(r);
    };
    f.client.getMessages = async (p: any, o: any) => {
      assert.equal(p.userId.toString(), "800");
      assert.deepEqual(o.ids, [50]);
      f.events.push("refresh");
      return [{ media: media(document("renewed")) }];
    };
    await sendTelegramArchive({ ...f.options, peerId: "802" });
    assert.deepEqual(f.events, ["expired", "refresh", "reuse"]);
    assert.equal(
      cachedTelegramArchiveMedia(
        f.db,
        "telegram-1",
        f.options.archive.source_key,
      ).file_reference.toString(),
      "fresh",
    );
  }));
test("Deleted source falls back to one lazy upload after explicit rejection; version key is checked", async () =>
  fixture(async (f) => {
    await sendTelegramArchive(f.options);
    f.events.length = 0;
    const invoke = f.client.invoke;
    f.client.invoke = async (r: any) => {
      if (
        r instanceof Api.messages.SendMedia &&
        r.media instanceof Api.InputMediaDocument
      ) {
        f.events.push("invalid");
        throw { errorMessage: "DOCUMENT_INVALID" };
      }
      return invoke(r);
    };
    f.client.getMessages = async () => {
      f.events.push("deleted");
      return [];
    };
    await sendTelegramArchive({
      ...f.options,
      prepare: async (id: string, key: string) => {
        assert.equal(id, "book");
        assert.equal(key, f.options.archive.source_key);
        f.events.push("prepare");
        return f.options.archive;
      },
    });
    assert.deepEqual(f.events, [
      "invalid",
      "deleted",
      "prepare",
      "upload",
      "new",
    ]);
  }));
test("Network timeout after reuse never refreshes, uploads or automatically resends", async () =>
  fixture(async (f) => {
    await sendTelegramArchive(f.options);
    f.events.length = 0;
    f.client.invoke = async () => {
      f.events.push("timeout");
      throw new Error("private network error");
    };
    await assert.rejects(
      sendTelegramArchive(f.options),
      (e: unknown) => e instanceof SendFailure && e.ambiguous,
    );
    assert.deepEqual(f.events, ["timeout"]);
    assert.ok(
      cachedTelegramArchiveMedia(
        f.db,
        "telegram-1",
        f.options.archive.source_key,
      ),
    );
  }));
test("Failed reference refresh followed by ambiguous resend cannot fall through to upload", async () =>
  fixture(async (f) => {
    await sendTelegramArchive(f.options);
    f.events.length = 0;
    let n = 0;
    f.client.invoke = async () => {
      f.events.push("send");
      if (++n === 1) throw { errorMessage: "FILE_REFERENCE_EXPIRED" };
      throw new Error("lost acknowledgement");
    };
    await assert.rejects(
      sendTelegramArchive(f.options),
      (e: unknown) => e instanceof SendFailure && e.ambiguous,
    );
    assert.deepEqual(f.events, ["send", "refresh", "send"]);
  }));
test("Short successful acknowledgement stays successful when cache read fails; missing acknowledgement never caches", async () =>
  fixture(async (f) => {
    f.client.invoke = async (r: any) =>
      r instanceof Api.messages.SendMedia
        ? new Api.UpdateShortSentMessage({
            id: 90,
            pts: 1,
            ptsCount: 1,
            date: 1,
            out: true,
          })
        : true;
    f.client.getMessages = async () => {
      throw Error("offline");
    };
    assert.deepEqual(await sendTelegramArchive(f.options), {
      externalId: "90",
    });
    assert.equal(
      cachedTelegramArchiveMedia(
        f.db,
        "telegram-1",
        f.options.archive.source_key,
      ),
      undefined,
    );
    f.client.invoke = async (r: any) =>
      r instanceof Api.messages.SendMedia
        ? new Api.Updates({
            updates: [],
            users: [],
            chats: [],
            date: 1,
            seq: 1,
          })
        : true;
    await assert.rejects(
      sendTelegramArchive(f.options),
      (e: unknown) => e instanceof SendFailure && e.ambiguous,
    );
    assert.equal(
      cachedTelegramArchiveMedia(
        f.db,
        "telegram-1",
        f.options.archive.source_key,
      ),
      undefined,
    );
  }));
test("Routes skip ffmpeg for a remotely cached video, redirect evicted playback and invalidate changed sources", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jorik-reuse-routes-"));
  const root = path.join(dir, "reviews");
  await fs.mkdir(root);
  const file = path.join(root, "Book.mp4");
  await fs.writeFile(file, "original");
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
    const c = ctx.store
      .conversations()
      .find((c) => c.accountId === "telegram-1")!;
    const entry = ctx.archive.index.list()[0],
      identity = await ctx.archive.video.identity(entry.id);
    ctx.db
      .prepare(
        "INSERT INTO telegram_sessions(account_id,ciphertext,user_id) VALUES('telegram-1','test','100')",
      )
      .run();
    ctx.db
      .prepare(
        "INSERT INTO telegram_archive_media VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "telegram-1",
        "100",
        identity.key,
        "1",
        "2",
        Buffer.from("ref"),
        "800",
        1,
        16,
        1,
        320,
        240,
        Date.now(),
      );
    ctx.archive.video.prepare = async () => {
      throw Error("ffmpeg must not run");
    };
    const response = await ctx.app.inject({
      url: "/api/archive/send-video",
      method: "POST",
      payload: {
        id: entry.id,
        conversationId: c.id,
        idempotencyKey: randomUUID(),
      },
    });
    await ctx.archive.tick();
    const job = (
      await ctx.app.inject("/api/archive/jobs/" + response.json().id)
    ).json();
    assert.equal(job.state, "queued");
    assert.ok(job.messageId);
    const before = await ctx.app.inject("/api/archive/video/" + job.id);
    assert.notEqual(
      before.statusCode,
      302,
      "Unconfirmed sends must not redirect to Telegram",
    );
    await ctx.store.tick();
    const playback = await ctx.app.inject("/api/archive/video/" + job.id);
    assert.equal(playback.statusCode, 302);
    assert.equal(
      playback.headers.location,
      "/api/telegram/videos/" + job.messageId,
    );
    await fs.writeFile(file, "replaced-content");
    assert.notEqual(
      (await ctx.archive.video.identity(entry.id)).key,
      identity.key,
    );
    await assert.rejects(
      ctx.store.prepareArchiveVideo!(entry.id, identity.key),
      /изменилось/,
    );
    const oldJobs = (
      ctx.db.prepare("SELECT count(*) n FROM archive_jobs").get() as any
    ).n;
    assert.equal(oldJobs, 1);
  } finally {
    await ctx.app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Previously sent archive videos are adopted on demand without uploading or background scanning", async () =>
  fixture(async (f) => {
    const cid = randomUUID(),
      mid = randomUUID();
    f.db
      .prepare(
        "INSERT INTO conversations(id,account_id,external_id,name,updated_at) VALUES(?,?,?,?,?)",
      )
      .run(cid, "telegram-1", "900", "Synthetic", new Date().toISOString());
    f.db
      .prepare(
        "INSERT INTO messages(id,conversation_id,external_id,direction,text,status,created_at) VALUES(?,?,?,'out','','sent',?)",
      )
      .run(mid, cid, "35", new Date().toISOString());
    f.db
      .prepare(
        "INSERT INTO archive_jobs(id,idempotency_key,conversation_id,entry_id,state,file,size,duration,width,height,message_id,created_at) VALUES(?,?,?,?,'queued',?,16,1,320,240,?,?)",
      )
      .run(
        randomUUID(),
        randomUUID(),
        cid,
        "old-entry",
        f.file,
        mid,
        Date.now(),
      );
    f.client.getMessages = async (p: any, o: any) => {
      assert.equal(p.userId.toString(), "900");
      assert.deepEqual(o.ids, [35]);
      f.events.push("adopt");
      return [{ media: media() }];
    };
    await sendTelegramArchive(f.options);
    assert.deepEqual(f.events, ["adopt", "reuse"]);
    assert.equal(
      cachedTelegramArchiveMedia(
        f.db,
        "telegram-1",
        f.options.archive.source_key,
      ).peer_id,
      "800",
    );
  }));

test("Store/adapter marks lost acknowledgement unknown and does not resend; the next customer's reuse remains separate", async () => {
  const { Store } = await import("../server/store.js");
  const { TelegramIntegration } = await import("../server/telegram.js");
  await fixture(async (f) => {
    await sendTelegramArchive(f.options);
    f.events.length = 0;
    const store = new Store(f.db),
      cid = randomUUID();
    f.db
      .prepare(
        "INSERT INTO conversations(id,account_id,external_id,name,updated_at) VALUES(?,?,?,?,?)",
      )
      .run(cid, "telegram-1", "800", "Synthetic", new Date().toISOString());
    f.db
      .prepare("INSERT INTO telegram_peers VALUES(?,?,?,?,?)")
      .run("telegram-1", "800", "11", "Synthetic", "");
    const integration = new TelegramIntegration(store, {
      apiId: 123,
      apiHash: "a".repeat(32),
      encryptionKey: "b".repeat(64),
    });
    Object.defineProperty(integration, "authenticated", {
      value: true,
      writable: true,
    });
    f.db
      .prepare("UPDATE accounts SET state='connected' WHERE id='telegram-1'")
      .run();
    f.client.connected = true;
    f.client.invoke = async (r: any) => {
      assert.ok(r instanceof Api.messages.SendMedia);
      assert.ok(r.media instanceof Api.InputMediaDocument);
      f.events.push("timeout");
      throw Error("lost acknowledgement");
    };
    integration.client = f.client;
    const job = randomUUID(),
      key = randomUUID();
    f.db
      .prepare(
        "INSERT INTO archive_jobs(id,idempotency_key,conversation_id,entry_id,file,size,duration,width,height,source_key,created_at) VALUES(?,?,?,?,?,16,1,320,240,?,?)",
      )
      .run(
        job,
        key,
        cid,
        "book",
        f.file,
        f.options.archive.source_key,
        Date.now(),
      );
    const mid = store.enqueue(cid, "", key, { archiveJobId: job });
    f.db
      .prepare("UPDATE archive_jobs SET state='queued',message_id=? WHERE id=?")
      .run(mid, job);
    await store.tick();
    await store.tick();
    assert.equal(store.message(cid, mid)?.status, "unknown");
    assert.equal(
      (
        f.db
          .prepare("SELECT state FROM outbox WHERE message_id=?")
          .get(mid) as any
      ).state,
      "unknown",
    );
    assert.deepEqual(f.events, ["timeout"]);
    assert.equal(
      (
        f.db
          .prepare("SELECT count(*) n FROM messages WHERE conversation_id=?")
          .get(cid) as any
      ).n,
      1,
    );
    integration.client = undefined;
  });
});

test("Legacy queued jobs keep their originally prepared video, without substituting a changed archive source", async () =>
  fixture(async (f) => {
    await sendTelegramArchive({
      ...f.options,
      archive: { ...f.options.archive, source_key: null },
      prepare: async () => {
        throw Error("Legacy job must never prepare a different source");
      },
    });
    assert.deepEqual(f.events, ["upload", "new"]);
    assert.equal(
      cachedTelegramArchiveMedia(
        f.db,
        "telegram-1",
        f.options.archive.source_key,
      ),
      undefined,
    );
  }));
