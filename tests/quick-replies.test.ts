import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/app.js";
import {
  normalizeQuickReplies,
  quickReplyHotkey,
  nextTemplateIndex,
  MAX_QUICK_REPLIES,
} from "../shared/quick-replies.js";
test("legacy templates retain content and stable IDs; shortcuts stop at nine; arrows wrap any length", () => {
  const old = Array.from({ length: 4 }, (_, i) => ({
    title: `Old ${i}`,
    text: `Text ${i}`,
  }));
  const converted = normalizeQuickReplies(old)!;
  assert.equal(converted.length, 4);
  assert.deepEqual(converted, normalizeQuickReplies(old));
  assert.equal(converted[2].text, "Text 2");
  assert.deepEqual(normalizeQuickReplies(converted), converted);
  assert.deepEqual(normalizeQuickReplies([]), []);
  assert.equal(quickReplyHotkey(8), "Ctrl + 9");
  assert.equal(quickReplyHotkey(9), undefined);
  assert.equal(nextTemplateIndex(11, 1, 12), 0);
  assert.equal(nextTemplateIndex(0, -1, 12), 11);
  assert.equal(nextTemplateIndex(0, 1, 0), 0);
  assert.equal(
    normalizeQuickReplies([
      { id: "same", title: "", text: "" },
      { id: "same", title: "", text: "" },
    ]),
    undefined,
  );
});
test("dynamic template array persists in full across add/edit/delete/empty/restart; rejects duplicate IDs and overflow", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-templates-"));
  let ctx = await createApp({
    dataDir: dir,
    mode: "demo",
    localAccess: true,
    worker: false,
  });
  const headers = { host: "127.0.0.1" };
  const put = (payload: unknown) =>
    ctx.app.inject({
      method: "PUT",
      url: "/api/quick-replies",
      headers,
      payload,
    });
  try {
    let templates = Array.from({ length: 12 }, (_, i) => ({
      id: `template-${i}`,
      title: `Title ${i}`,
      text: "Текст ".repeat(600),
    }));
    assert.equal((await put(templates)).statusCode, 200); // Entire array exceeds the old global 64 KiB body limit.
    templates[10].text = "Edited";
    templates = templates.filter((t) => t.id !== "template-3");
    assert.equal((await put(templates)).statusCode, 200);
    await ctx.app.close();
    ctx = await createApp({
      dataDir: dir,
      mode: "demo",
      localAccess: true,
      worker: false,
    });
    const saved = JSON.parse(
      (await ctx.app.inject({ url: "/api/state", headers })).json().settings
        .quickReplies,
    );
    assert.deepEqual(saved, templates);
    assert.equal((await put([templates[0], templates[0]])).statusCode, 400);
    assert.equal(
      (
        await put(
          Array.from({ length: MAX_QUICK_REPLIES + 1 }, (_, i) => ({
            id: `t-${i}`,
            title: "",
            text: "",
          })),
        )
      ).statusCode,
      400,
    );
    assert.equal((await put([])).statusCode, 200);
    assert.deepEqual(
      JSON.parse(
        (await ctx.app.inject({ url: "/api/state", headers })).json().settings
          .quickReplies,
      ),
      [],
    );
  } finally {
    await ctx.app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
