import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ArchiveVideo, parseVideoMetadata } from "../server/archive-video.js";
import { ArchiveIndex } from "../server/archive-index.js";
const metadata = {
  streams: [
    {
      codec_type: "video",
      codec_name: "h264",
      width: 720,
      height: 1280,
      pix_fmt: "yuv420p",
      color_range: "tv",
      color_space: "bt709",
      color_transfer: "bt709",
      color_primaries: "bt709",
      sample_aspect_ratio: "1:1",
    },
  ],
  format: { duration: "12.733333" },
};
test("Video metadata rejects empty/truncated/malformed JSON without exposing parser errors; keeps NAS limits", () => {
  for (const output of [
    "",
    "{",
    "null",
    '{"streams":{}}',
    '{"streams":[],"format":null}',
  ])
    assert.throws(
      () => parseVideoMetadata(output),
      /Не удалось прочитать сведения/,
    );
  assert.equal(
    parseVideoMetadata(JSON.stringify(metadata)).duration,
    12.733333,
  );
  assert.equal(
    parseVideoMetadata(
      JSON.stringify({ ...metadata, streams: [...metadata.streams, null] }),
    ).audio,
    undefined,
  );
  assert.throws(
    () =>
      parseVideoMetadata(
        JSON.stringify({ ...metadata, format: { duration: "181" } }),
      ),
    /до 3 минут/,
  );
  assert.throws(
    () =>
      parseVideoMetadata(
        JSON.stringify({
          ...metadata,
          streams: [{ ...metadata.streams[0], width: 3840, height: 2160 }],
        }),
      ),
    /4K/,
  );
});
async function fixture(code: (counter: string) => string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jorik-probe-"));
  const file = path.join(dir, "Nana.MOV"),
    counter = path.join(dir, "calls"),
    probe = path.join(dir, "ffprobe");
  await fs.writeFile(file, "synthetic");
  await fs.writeFile(
    probe,
    `#!${process.execPath}\nconst fs=require('node:fs');const counter=${JSON.stringify(counter)};let n=Number(fs.existsSync(counter)?fs.readFileSync(counter,'utf8'):0)+1;fs.writeFileSync(counter,String(n));${code(counter)}\n`,
    { mode: 0o700 },
  );
  const video = new ArchiveVideo(
    new ArchiveIndex([]),
    path.join(dir, "cache"),
    "/encoder-must-not-run",
    probe,
  );
  const run = (file: string) =>
    (video as unknown as { probe(file: string): Promise<unknown> }).probe(file);
  return { dir, file, counter, video, run };
}
test("One safe probe retry recovers empty output, successful metadata is cached by revision", async () => {
  const f = await fixture(
    () =>
      `if(n>1)process.stdout.write(${JSON.stringify(JSON.stringify(metadata))});`,
  );
  try {
    await f.run(f.file);
    assert.equal(await fs.readFile(f.counter, "utf8"), "2");
    await f.run(f.file);
    assert.equal(await fs.readFile(f.counter, "utf8"), "2");
    await fs.appendFile(f.file, "changed");
    await f.run(f.file);
    assert.equal(await fs.readFile(f.counter, "utf8"), "3");
  } finally {
    await f.video.close();
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});
test("Repeated invalid output fails cleanly, source changes fail before caching, policy failures are not retried", async () => {
  for (const kind of ["empty", "changed", "unsupported"]) {
    const f = await fixture(() =>
      kind === "empty"
        ? "process.stdout.write('{');"
        : kind === "changed"
          ? `fs.appendFileSync(process.argv.at(-1),'changed');process.stdout.write(${JSON.stringify(JSON.stringify(metadata))});`
          : `process.stdout.write(${JSON.stringify(JSON.stringify({ ...metadata, format: { duration: "181" } }))});`,
    );
    try {
      await assert.rejects(
        f.run(f.file),
        kind === "empty"
          ? /Не удалось прочитать сведения/
          : kind === "changed"
            ? /Файл видео изменился/
            : /до 3 минут/,
      );
      assert.equal(
        await fs.readFile(f.counter, "utf8"),
        kind === "empty" ? "2" : "1",
      );
    } finally {
      await f.video.close();
      await fs.rm(f.dir, { recursive: true, force: true });
    }
  }
});
