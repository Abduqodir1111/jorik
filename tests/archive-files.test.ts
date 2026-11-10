import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createApp } from "../server/app.js";

async function fixture(localAccess = true) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jorik-browse-test-"));
  const root = path.join(dir, "books"),
    reviews = path.join(dir, "reviews");
  const folder = path.join(root, "Книга"),
    child = path.join(folder, "Том 1");
  await fs.mkdir(child, { recursive: true });
  await fs.mkdir(reviews);
  await fs.writeFile(path.join(child, "книга's.pdf"), "0123456789");
  await fs.writeFile(path.join(folder, "photo.jpg"), "original-photo");
  await fs.writeFile(
    path.join(folder, "unsafe.html"),
    "<script>alert(1)</script>",
  );
  await fs.writeFile(
    path.join(folder, "unsafe.svg"),
    "<svg onload='alert(1)'/>",
  );
  await fs.writeFile(path.join(folder, ".secret"), "hidden");
  await fs.writeFile(path.join(folder, "Thumbs.db"), "hidden");
  await fs.mkdir(path.join(folder, "@eaDir", "photo.jpg"), { recursive: true });
  await fs.writeFile(
    path.join(folder, "@eaDir", "photo.jpg", "SYNOPHOTO_THUMB_M.jpg"),
    "thumb-photo",
  );
  await fs.writeFile(path.join(reviews, "Обзор.MOV"), "original-video");
  await fs.symlink(dir, path.join(folder, "outside"));
  await fs.symlink(child, path.join(folder, "inside-link"));
  const instance = await createApp({
    mode: "demo",
    dataDir: dir,
    worker: false,
    localAccess,
    archive: {
      roots: [
        { path: root, share: "/Books", source: "Storebooks", videos: false },
        {
          path: reviews,
          share: "/Reviews",
          source: "Mangastore",
          videos: true,
        },
      ],
    },
  });
  await instance.archive.rebuild();
  const id = instance.archive.index.list().find((e) => e.name === "Книга")!.id;
  const videoId = instance.archive.index
    .list()
    .find((e) => e.type === "video")!.id;
  return {
    ...instance,
    dir,
    root,
    folder,
    child,
    id,
    videoId,
    async close() {
      await instance.app.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
const address = (
  route: string,
  id: string,
  file = "",
  extra: Record<string, string> = {},
) =>
  "/api/archive/" + route + "?" + new URLSearchParams({ id, file, ...extra });

test("Direct archive browse: auth, subfolders, bounded pages, hidden files and original Range downloads", async () => {
  const f = await fixture();
  try {
    let preparations = 0;
    f.archive.video.prepare = async () => {
      preparations++;
      throw Error("Must not encode during preview");
    };
    const listing = await f.app.inject(address("folder-contents", f.id));
    assert.equal(listing.statusCode, 200);
    assert.equal(listing.headers["cache-control"], "no-store");
    const items = listing.json().items;
    assert.ok(
      items.some((e: any) => e.name === "Том 1" && e.type === "folder"),
    );
    assert.ok(
      items.some((e: any) => e.name === "photo.jpg" && e.type === "image"),
    );
    assert.ok(
      !items.some((e: any) => /secret|Thumbs|eaDir|link|outside/.test(e.name)),
    );
    assert.ok(!listing.body.includes(f.dir));
    const sub = await f.app.inject(address("folder-contents", f.id, "Том 1"));
    assert.equal(sub.json().items[0].type, "book");
    const paged = await f.app.inject(
      address("folder-contents", f.id, "", { limit: "1" }),
    );
    assert.equal(paged.json().items.length, 1);
    assert.equal(paged.json().nextOffset, 1);
    const file = "Том 1/книга's.pdf";
    const partial = await f.app.inject({
      url: address("file", f.id, file, { download: "1" }),
      headers: { range: "bytes=2-5", "accept-encoding": "gzip" },
    });
    assert.equal(partial.statusCode, 206);
    assert.equal(partial.body, "2345");
    assert.equal(partial.headers["content-range"], "bytes 2-5/10");
    assert.equal(partial.headers["content-encoding"], undefined);
    assert.match(
      String(partial.headers["content-disposition"]),
      /^attachment; filename\*=UTF-8''/,
    );
    assert.ok(String(partial.headers["content-disposition"]).includes("%27"));
    assert.equal(partial.headers["cache-control"], "no-store");
    assert.equal(
      (
        await f.app.inject({
          url: address("file", f.id, file),
          headers: { range: "bytes=99-" },
        })
      ).statusCode,
      416,
    );
    const suffix = await f.app.inject({
      url: address("file", f.id, file),
      headers: { range: "bytes=-3" },
    });
    assert.equal(suffix.statusCode, 206);
    assert.equal(suffix.body, "789");
    const head = await f.app.inject({
      method: "HEAD",
      url: address("file", f.id, file),
    });
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, "");
    assert.equal(head.headers["content-length"], "10");
    for (const name of ["unsafe.html", "unsafe.svg"]) {
      const r = await f.app.inject(address("file", f.id, name));
      assert.match(String(r.headers["content-disposition"]), /^attachment/);
      assert.match(
        String(r.headers["content-type"]),
        /application\/octet-stream/,
      );
    }
    const thumb = await f.app.inject(address("thumb", f.id, "photo.jpg"));
    assert.equal(thumb.statusCode, 200);
    assert.equal(thumb.body, "thumb-photo");
    assert.equal(thumb.headers["cache-control"], "no-store");
    await fs.rm(path.join(f.folder, "@eaDir"), { recursive: true });
    assert.equal(
      (await f.app.inject(address("thumb", f.id, "photo.jpg"))).body,
      "original-photo",
    );
    const original = await f.app.inject(address("file", f.videoId));
    assert.equal(original.body, "original-video");
    assert.equal(preparations, 0);
  } finally {
    await f.close();
  }
  const secure = await fixture(false);
  try {
    for (const route of ["folder-contents", "thumb", "file"])
      assert.equal(
        (await secure.app.inject(address(route, secure.id, "photo.jpg")))
          .statusCode,
        401,
      );
  } finally {
    await secure.close();
  }
});

test("Direct archive rejects traversal, service files, links and sibling roots; thumbnail links cannot escape", async () => {
  const f = await fixture();
  try {
    for (const relative of [
      "../reviews/Обзор.MOV",
      "Том 1/../../outside",
      "/etc/passwd",
      ".secret",
      "@eaDir/photo.jpg/SYNOPHOTO_THUMB_M.jpg",
      "outside/books/Книга/photo.jpg",
      "inside-link/книга's.pdf",
      "Том 1\\книга's.pdf",
    ]) {
      for (const route of ["folder-contents", "thumb", "file"]) {
        const r = await f.app.inject(address(route, f.id, relative));
        assert.ok(r.statusCode >= 400, route + " " + relative);
        assert.ok(!r.body.includes(f.dir));
      }
    }
    const realThumb = path.join(f.folder, "@eaDir");
    await fs.rm(realThumb, { recursive: true });
    await fs.mkdir(path.join(f.dir, "external", "photo.jpg"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(f.dir, "external", "photo.jpg", "SYNOPHOTO_THUMB_M.jpg"),
      "outside-secret",
    );
    await fs.symlink(path.join(f.dir, "external"), realThumb);
    assert.equal(
      (await f.app.inject(address("thumb", f.id, "photo.jpg"))).body,
      "original-photo",
    );
    await fs.rename(f.child, f.child + "-moved");
    await fs.symlink(f.dir, f.child);
    assert.equal(
      (await f.app.inject(address("file", f.id, "Том 1/книга's.pdf")))
        .statusCode,
      404,
    );
    assert.equal(
      (await f.app.inject(address("file", f.videoId, "photo.jpg"))).statusCode,
      404,
    );
    assert.equal(
      (
        await f.app.inject(
          address("folder-contents", f.id, "", { limit: "101" }),
        )
      ).statusCode,
      400,
    );
  } finally {
    await f.close();
  }
});

test("Video preview reuses only the current finished cache; download always returns original without encoding", async () => {
  const f = await fixture();
  try {
    const e = await f.archive.index.get(f.videoId, "video");
    const hash = createHash("sha256")
      .update(`${e.path}:${e.stat.size}:${e.stat.mtimeMs}:h264-v2-sdr709-crf24`)
      .digest("hex");
    const cache = path.join(f.dir, "archive-cache");
    await fs.mkdir(cache);
    const cached = path.join(cache, hash + ".chat.mp4");
    await fs.writeFile(cached, "cached-video");
    f.archive.video.prepare = async () => {
      throw Error("Preview must not prepare");
    };
    const preview = await f.app.inject({
      url: address("file", f.videoId),
      headers: { range: "bytes=0-5" },
    });
    assert.equal(preview.statusCode, 206);
    assert.equal(preview.body, "cached");
    assert.match(String(preview.headers["content-type"]), /video\/mp4/);
    const download = await f.app.inject(
      address("file", f.videoId, "", { download: "1" }),
    );
    assert.equal(download.body, "original-video");
    await fs.writeFile(e.path, "changed-original-video");
    assert.equal(
      (await f.app.inject(address("file", f.videoId))).body,
      "changed-original-video",
    );
    await fs.writeFile(e.path, "original-video");
    await fs.utimes(e.path, e.stat.atime, e.stat.mtime);
    // A cache symlink is never served, even if it targets a regular file.
    await fs.rm(cached);
    await fs.symlink(e.path, cached);
    assert.equal(await f.archive.video.cachedFile(f.videoId), undefined);
  } finally {
    await f.close();
  }
});

test("PDF preview is authenticated, same-origin and streamed with Range while downloads stay attachments", async () => {
  const f = await fixture();
  const file = "Том 1/preview.pdf";
  const pdf = Buffer.from("%PDF-1.7\n" + "sample document\n".repeat(100));
  try {
    await fs.writeFile(path.join(f.child, "preview.pdf"), pdf);
    let pageReads = 0;
    f.archive.pdfMetadata.read = async () => {
      pageReads++;
      return 42;
    };
    for (let n = 0; n < 2; n++) {
      const metadata = await f.app.inject(address("pdf-info", f.id, file));
      assert.equal(metadata.statusCode, 200);
      assert.deepEqual(metadata.json(), { pages: 42 });
      assert.equal(metadata.headers["cache-control"], "no-store");
    }
    assert.equal(pageReads, 1);
    assert.equal(
      (await f.app.inject(address("pdf-info", f.id, "../outside.pdf")))
        .statusCode,
      404,
    );
    assert.equal(
      (await f.app.inject(address("pdf-info", f.id, "photo.jpg"))).statusCode,
      415,
    );

    const normal = await f.app.inject(address("file", f.id, file));
    assert.match(String(normal.headers["content-disposition"]), /^attachment/);
    assert.equal(normal.headers["x-frame-options"], "DENY");
    const view = await f.app.inject(
      address("file", f.id, file, { preview: "1" }),
    );
    assert.equal(view.statusCode, 200);
    assert.deepEqual(view.rawPayload, pdf);
    assert.match(String(view.headers["content-type"]), /^application\/pdf/);
    assert.match(String(view.headers["content-disposition"]), /^inline/);
    assert.equal(view.headers["x-frame-options"], "SAMEORIGIN");
    assert.equal(view.headers["x-content-type-options"], "nosniff");
    assert.equal(
      view.headers["content-security-policy"],
      "frame-ancestors 'self'",
    );
    assert.match(
      String(view.headers["content-security-policy-report-only"]),
      /frame-ancestors 'self'/,
    );
    assert.equal(view.headers["cache-control"], "no-store");
    const partial = await f.app.inject({
      url: address("file", f.id, file, { preview: "1" }),
      headers: { range: "bytes=0-7", "accept-encoding": "gzip" },
    });
    assert.equal(partial.statusCode, 206);
    assert.equal(partial.body, "%PDF-1.7");
    assert.equal(partial.headers["content-range"], "bytes 0-7/" + pdf.length);
    assert.equal(partial.headers["content-encoding"], undefined);
    assert.match(String(partial.headers["content-type"]), /^application\/pdf/);
    const head = await f.app.inject({
      method: "HEAD",
      url: address("file", f.id, file, { preview: "1" }),
    });
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, "");
    assert.equal(head.headers["content-length"], String(pdf.length));
    const download = await f.app.inject(
      address("file", f.id, file, { preview: "1", download: "1" }),
    );
    assert.match(
      String(download.headers["content-disposition"]),
      /^attachment/,
    );
    assert.equal(download.headers["x-frame-options"], "DENY");
    for (const name of ["Том 1/книга's.pdf", "unsafe.html", "photo.jpg"]) {
      const invalid = await f.app.inject(
        address("file", f.id, name, { preview: "1" }),
      );
      assert.equal(invalid.statusCode, 415);
      assert.equal(invalid.headers["x-frame-options"], "DENY");
    }
    assert.equal(
      (
        await f.app.inject(
          address("file", f.id, "../preview.pdf", { preview: "1" }),
        )
      ).statusCode,
      404,
    );
  } finally {
    await f.close();
  }
  const secure = await fixture(false);
  try {
    assert.equal(
      (
        await secure.app.inject(
          address("file", secure.id, file, { preview: "1" }),
        )
      ).statusCode,
      401,
    );
    assert.equal(
      (await secure.app.inject(address("pdf-info", secure.id, file)))
        .statusCode,
      401,
    );
  } finally {
    await secure.close();
  }
});
