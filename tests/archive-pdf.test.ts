import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ArchivePdfMetadata } from "../server/archive-pdf.js";
import { pdfPagesLabel } from "../src/useArchivePdfPages.js";
test("PDF page metadata is serialized, deduplicated, persisted privately and keyed by file revision", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jorik-pdf-count-")),
    file = path.join(dir, "metadata.json");
  let calls = 0,
    release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const service = new ArchivePdfMetadata(file, async () => {
    calls++;
    await gate;
    return 248;
  });
  try {
    const a = service.get("/validated/book.pdf", "a".repeat(64));
    const same = service.get("/validated/book.pdf", "a".repeat(64));
    await assert.rejects(
      service.get("/validated/other.pdf", "b".repeat(64)),
      /занят/,
    );
    release();
    assert.deepEqual(await Promise.all([a, same]), [248, 248]);
    assert.equal(calls, 1);
    assert.equal(await service.get("/validated/book.pdf", "a".repeat(64)), 248);
    assert.equal(calls, 1);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    const reloaded = new ArchivePdfMetadata(file, async () => {
      throw Error("Must use persistent cache");
    });
    assert.equal(
      await reloaded.get("/validated/book.pdf", "a".repeat(64)),
      248,
    );
    await service.get("/validated/book.pdf", "c".repeat(64));
    assert.equal(calls, 2);
    assert.equal(pdfPagesLabel(1), "1 страница");
    assert.equal(pdfPagesLabel(22), "22 страницы");
    assert.equal(pdfPagesLabel(111), "111 страниц");
  } finally {
    release();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
