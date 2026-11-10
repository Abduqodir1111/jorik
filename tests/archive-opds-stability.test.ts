import test from "node:test";
import assert from "node:assert/strict";
import { ArchiveOPDS } from "../server/archive-opds.js";
import { archiveContainsTitle } from "../shared/archive-query.js";
import type { ArchiveEntry } from "../shared/archive.js";
const entry =
  '<entry><id>123</id><title type="text">1984</title><author><name>Оруэлл</name></author><link rel="http://opds-spec.org/acquisition/open-access" href="/b/123/epub/opds"/></entry>';
const feed = "<feed>" + entry + "</feed>";
test("Fuzzy archive suggestions do not suppress full-title catalog search", () => {
  const entries = ["Ведьмин камень", "Ведьмины байки"].map(
    (name) => ({ name, type: "folder" }) as ArchiveEntry,
  );
  assert.equal(archiveContainsTitle(entries, "Ведьмин час"), false);
  assert.equal(
    archiveContainsTitle(
      [
        ...entries,
        { name: "Энн Райс — Ведьмин час", type: "folder" } as ArchiveEntry,
      ],
      "  Ведьмин   час ",
    ),
    true,
  );
});
test("OPDS numeric titles survive attributes and downloadable books after navigation entries remain visible", async () => {
  const service = new ArchiveOPDS(
    "https://example.com",
    (async () =>
      new Response(
        "<feed>" +
          "<entry><title>Navigation</title></entry>".repeat(12) +
          entry +
          "</feed>",
      )) as typeof fetch,
  );
  const books = await service.search("1984");
  assert.equal(books.length, 1);
  assert.equal(books[0].title, "1984");
});
test("OPDS retries transient failures, deduplicates normalized queries and expires cache", async () => {
  let calls = 0,
    now = 0;
  const service = new ArchiveOPDS(
    "https://example.com",
    (async () => {
      calls++;
      if (calls === 1) throw Error("network");
      return new Response(feed);
    }) as typeof fetch,
    { retryDelayMs: 1, cacheTtlMs: 20, now: () => now },
  );
  const [a, b] = await Promise.all([
    service.search(" Ведьмин   час "),
    service.search("ведьмин час"),
  ]);
  assert.deepEqual(a, b);
  assert.equal(calls, 2);
  await service.search("Ведьмин час");
  assert.equal(calls, 2);
  now = 21;
  await service.search("Ведьмин час");
  assert.equal(calls, 3);
});
test("OPDS rate limits and invalid HTML are errors, never cached empty results", async () => {
  let calls = 0;
  const service = new ArchiveOPDS("https://example.com", (async () => {
    calls++;
    return calls === 1
      ? new Response("busy", { status: 429 })
      : new Response("<html><body>Unavailable</body></html>");
  }) as typeof fetch);
  await assert.rejects(service.search("book"), /ограничила/);
  assert.equal(calls, 1);
  await assert.rejects(service.search("book"), /OPDS/);
  assert.equal(calls, 2);
});
test("OPDS download body is not cut off by the header deadline", async () => {
  const service = new ArchiveOPDS(
    "https://example.com",
    (async (_url, opts) =>
      new Response(
        new ReadableStream({
          start(c) {
            const timer = setTimeout(() => {
              c.enqueue(new TextEncoder().encode("slow book"));
              c.close();
            }, 60);
            opts?.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              c.error(Error("aborted"));
            });
          },
        }),
      )) as typeof fetch,
    { headerTimeoutMs: 40, idleTimeoutMs: 500 },
  );
  const { stream } = await service.download("/b/123/epub");
  let text = "";
  for await (const chunk of stream) text += chunk;
  assert.equal(text, "slow book");
});
test("OPDS bounds parallel upstream searches and releases slots after timeouts", async () => {
  let calls = 0,
    active = 0,
    max = 0;
  const service = new ArchiveOPDS(
    "https://example.com",
    (async (_url, opts) => {
      calls++;
      active++;
      max = Math.max(max, active);
      return new Promise<Response>((_resolve, reject) => {
        opts?.signal?.addEventListener(
          "abort",
          () => {
            active--;
            reject(opts.signal?.reason);
          },
          { once: true },
        );
      });
    }) as typeof fetch,
    { attemptTimeoutMs: 80, searchTimeoutMs: 1000, retryDelayMs: 1 },
  );
  const a = service.search("first"),
    b = service.search("second");
  await assert.rejects(service.search("third"), /занят/);
  await Promise.all([
    assert.rejects(a, /вовремя/),
    assert.rejects(b, /вовремя/),
  ]);
  assert.equal(max, 2);
  assert.equal(active, 0);
  assert.equal(calls, 4);
  await assert.rejects(service.search("third"), /вовремя/);
  assert.equal(active, 0);
});
