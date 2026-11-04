import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/db.js";
import { Store } from "../server/store.js";
import { InstagramIntegration } from "../server/instagram.js";
import {
  instagramGraphMessageId,
  instagramMessageKey,
} from "../server/instagram-message-key.js";
import {
  instagramAttachments,
  trustedInstagramMediaUrl,
} from "../server/instagram-media.js";
test("Instagram media: trusted CDN, photo/video types and local URLs", () => {
  for (const url of [
    "http://lookaside.fbsbx.com/x",
    "https://fbcdn.net.evil.test/x",
    "https://127.0.0.1/x",
    "file:///tmp/x",
  ])
    assert.equal(trustedInstagramMediaUrl(url), null);
  const media = instagramAttachments(
    [
      { image_data: { url: "https://lookaside.fbsbx.com/photo" } },
      { video_data: { url: "https://video.cdninstagram.com/video" } },
    ],
    "local-message",
  );
  assert.deepEqual(
    media.map((m) => m.kind),
    ["image", "video"],
  );
  assert.equal(media[1].url, "/api/instagram/media/local-message/1");
});
test("Instagram webhook photo uses the Graph envelope, including already saved webhook IDs", async () => {
  const encode = (prefix: string) =>
    Buffer.from(`${prefix}:1:IGMessageID:123:456:789`)
      .toString("base64")
      .replace(
        /[Z+/=]/g,
        (c) => ({ Z: "ZA", "+": "ZB", "/": "ZC", "=": "ZD" })[c]!,
      );
  const webhookId = encode("new_ig_dm_item"),
    graphId = encode("ig_dm_item");
  assert.equal(instagramGraphMessageId(webhookId), graphId);
  assert.equal(instagramMessageKey(webhookId), instagramMessageKey(graphId));
  assert.equal(instagramGraphMessageId(graphId), graphId);
  assert.equal(
    instagramGraphMessageId("opaque-message-id"),
    "opaque-message-id",
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-ig-webhook-photo-"));
  const db = openDb(dir, "real"),
    store = new Store(db);
  let graphReads = 0;
  const integration = new InstagramIntegration(store, {
    token: "private-token",
    receiveMode: "webhook",
    fetcher: (async (url: string, options: RequestInit) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/me"))
        return Response.json({
          id: "page",
          instagram_business_account: { id: "shop", username: "shop" },
        });
      if (u.hostname === "lookaside.fbsbx.com") {
        assert.equal(new Headers(options.headers).has("authorization"), false);
        return new Response(new Uint8Array([255, 216, 255, 217]), {
          headers: { "Content-Type": "image/jpeg", "Content-Length": "4" },
        });
      }
      if (u.pathname.endsWith("/" + webhookId))
        return Response.json(
          {
            error: {
              code: 100,
              message: "Unsupported request - method type: get",
            },
          },
          { status: 400 },
        );
      assert.ok(u.pathname.endsWith("/" + graphId));
      graphReads++;
      return Response.json({
        id: graphId,
        attachments: {
          data: [
            { image_data: { url: "https://lookaside.fbsbx.com/fresh-photo" } },
          ],
        },
      });
    }) as typeof fetch,
  });
  try {
    await integration.sync();
    integration.receiveWebhook({
      id: "shop",
      messaging: [
        {
          sender: { id: "customer" },
          recipient: { id: "shop" },
          timestamp: Date.now(),
          message: {
            mid: webhookId,
            attachments: [
              {
                type: "image",
                payload: { url: "https://lookaside.fbsbx.com/expired-photo" },
              },
            ],
          },
        },
      ],
    });
    const c = store.conversations()[0],
      m = store.messages(c.id)[0];
    assert.equal(m.externalId, webhookId); // Same shape as the legacy production row.
    const media = await integration.media(m.id, 0);
    const chunks = [];
    for await (const chunk of media.stream) chunks.push(chunk);
    assert.equal(media.mime, "image/jpeg");
    assert.equal(Buffer.concat(chunks).length, 4);
    assert.equal(graphReads, 1);
    assert.equal(store.conversation(c.id).unread, 1);
    assert.equal(store.messages(c.id).length, 1);
  } finally {
    await integration.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("Instagram media: refresh metadata, preserve unread, range proxy and account isolation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-ig-media-"));
  const db = openDb(dir, "real"),
    store = new Store(db);
  let receivedRange = "",
    mediaCalls = 0;
  const attachments = {
    data: [{ video_data: { url: "https://lookaside.fbsbx.com/video" } }],
  };
  const thread = () => ({
    id: "thread",
    updated_time: new Date().toISOString(),
    participants: { data: [{ id: "ig" }, { id: "person" }] },
    messages: {
      data: [
        {
          id: "msg",
          created_time: new Date().toISOString(),
          from: { id: "person" },
        },
      ],
    },
  });
  const fetcher = (async (url: string, opts: RequestInit) => {
    const u = new URL(url);
    if (u.hostname === "lookaside.fbsbx.com") {
      mediaCalls++;
      assert.equal(new Headers(opts.headers).has("authorization"), false);
      receivedRange = new Headers(opts.headers).get("range") ?? "";
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": "4",
          "Content-Range": "bytes 0-3/100",
        },
      });
    }
    if (u.pathname.endsWith("/me"))
      return Response.json({
        id: "page",
        instagram_business_account: { id: "ig", username: "test" },
      });
    if (u.pathname.endsWith("/msg"))
      return Response.json({ id: "msg", attachments });
    if (u.pathname.endsWith("/thread")) return Response.json(thread());
    return Response.json({ data: [thread()] });
  }) as typeof fetch;
  const ig = new InstagramIntegration(store, { token: "secret", fetcher });
  try {
    await ig.sync();
    const c = store.conversations()[0],
      id = store.messages(c.id)[0].id;
    await ig.history(c.id);
    assert.equal(store.messages(c.id).length, 1);
    assert.equal(store.conversation(c.id).unread, 0);
    assert.equal(store.messages(c.id)[0].attachments[0].kind, "video");
    const media = await ig.media(id, 0, "bytes=0-3");
    const chunks = [];
    for await (const chunk of media.stream) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).length, 4);
    assert.equal(media.status, 206);
    assert.equal(receivedRange, "bytes=0-3");
    await assert.rejects(ig.media(id, 1));
    db.prepare(
      "UPDATE conversations SET account_id='telegram-1' WHERE id=?",
    ).run(c.id);
    await assert.rejects(ig.media(id, 0));
    assert.equal(mediaCalls, 1);
  } finally {
    await ig.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
