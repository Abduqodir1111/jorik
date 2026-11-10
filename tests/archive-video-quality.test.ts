import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ArchiveIndex } from "../server/archive-index.js";
import { ArchiveVideo } from "../server/archive-video.js";
const run = promisify(execFile),
  MiB = 1024 * 1024;
const hdrFiltersAvailable = /\bzscale\b/.test(
  (await run("ffmpeg", ["-hide_banner", "-filters"])).stdout,
);
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jorik-video-quality-"));
  return {
    dir,
    source: path.join(dir, "Book.MOV"),
    cache: path.join(dir, "cache"),
    index: new ArchiveIndex([
      { path: dir, source: "Storebooks", share: "/Reviews", videos: true },
    ]),
  };
}
async function probe(file: string) {
  return JSON.parse(
    (
      await run("ffprobe", [
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        file,
      ])
    ).stdout,
  );
}
async function frameHashes(file: string) {
  const { stdout } = await run("ffmpeg", [
    "-v",
    "error",
    "-i",
    file,
    "-map",
    "0:v:0",
    "-f",
    "framemd5",
    "-",
  ]);
  return stdout
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split(",").at(-1)!.trim());
}
test(
  "Compatible short SDR clip is remuxed losslessly with low RAM and cached copies bypass encoding gates",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    let video: ArchiveVideo | undefined;
    try {
      await run("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=160x240:d=0.6:r=10",
        "-vf",
        "setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-colorspace",
        "bt709",
        "-color_range",
        "tv",
        f.source,
      ]);
      await f.index.build();
      const id = f.index.list()[0].id;
      video = new ArchiveVideo(f.index, f.cache, "ffmpeg", "ffprobe", {
        memory: async () => ({
          supported: true,
          hostAvailable: 110 * MiB,
          limit: 448 * MiB,
          usage: 380 * MiB,
          inactiveFile: 0,
        }),
        memoryWaitMs: 0,
      });
      const prepared = await video.prepare(id);
      assert.ok(prepared.size < 18 * MiB);
      assert.deepEqual(
        await frameHashes(prepared.file),
        await frameHashes(f.source),
      );
      const meta = await probe(prepared.file);
      assert.equal(meta.streams[0].color_transfer, "bt709");
      const bytes = await fs.readFile(prepared.file);
      assert.ok(
        bytes.indexOf(Buffer.from("moov")) < bytes.indexOf(Buffer.from("mdat")),
      );
      await video.close();
      video = new ArchiveVideo(
        f.index,
        f.cache,
        "/encoder-must-not-run",
        "ffprobe",
        {
          memory: async () => {
            throw Error("A cached clip must not request encoder RAM");
          },
        },
      );
      assert.equal((await video.prepare(id)).file, prepared.file);
    } finally {
      await video?.close();
      await fs.rm(f.dir, { recursive: true, force: true });
    }
  },
);
test(
  "Actual low memory prevents conversion, while transient pressure can recover for an explicit job",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    let video: ArchiveVideo | undefined;
    try {
      await run("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=160x240:d=0.4",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        f.source,
      ]);
      await f.index.build();
      const id = f.index.list()[0].id;
      video = new ArchiveVideo(
        f.index,
        f.cache,
        "/encoder-must-not-run",
        "ffprobe",
        {
          memory: async () => ({ supported: true, hostAvailable: 0 }),
          memoryWaitMs: 0,
        },
      );
      await assert.rejects(video.prepare(id), /недостаточно памяти/);
      await video.close();
      let reads = 0;
      video = new ArchiveVideo(f.index, f.cache, "ffmpeg", "ffprobe", {
        memory: async () => ({
          supported: true,
          hostAvailable: ++reads === 1 ? 0 : 512 * MiB,
        }),
        memoryWaitMs: 100,
        memoryRetryMs: 1,
      });
      const prepared = await video.prepare(id);
      assert.ok(reads >= 2);
      const p = await probe(prepared.file);
      assert.equal(p.streams[0].codec_name, "h264");
      assert.equal(p.streams[0].pix_fmt, "yuv420p");
      assert.equal(p.streams[0].color_primaries, "bt709");
    } finally {
      await video?.close();
      await fs.rm(f.dir, { recursive: true, force: true });
    }
  },
);
test(
  "iPhone-style HLG and PQ HEVC sources are really tone-mapped into SDR H264 BT.709",
  { timeout: 30000, skip: !hdrFiltersAvailable },
  async () => {
    for (const transfer of ["arib-std-b67", "smpte2084"]) {
      const f = await fixture();
      let video: ArchiveVideo | undefined;
      try {
        await run("ffmpeg", [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=s=160x240:d=0.4:r=10",
          "-vf",
          `format=yuv420p10le,setparams=range=limited:color_primaries=bt2020:color_trc=${transfer}:colorspace=bt2020nc`,
          "-c:v",
          "libx265",
          "-preset",
          "ultrafast",
          "-x265-params",
          "pools=1:frame-threads=1:log-level=error",
          "-pix_fmt",
          "yuv420p10le",
          "-color_primaries",
          "bt2020",
          "-color_trc",
          transfer,
          "-colorspace",
          "bt2020nc",
          f.source,
        ]);
        await f.index.build();
        video = new ArchiveVideo(f.index, f.cache);
        const out = await video.prepare(f.index.list()[0].id);
        const p = await probe(out.file),
          v = p.streams[0];
        assert.equal(v.codec_name, "h264");
        assert.equal(v.pix_fmt, "yuv420p");
        assert.equal(v.color_primaries, "bt709");
        assert.equal(v.color_transfer, "bt709");
        assert.equal(v.color_space, "bt709");
        assert.ok(out.size < 18 * MiB);
        assert.ok(Math.max(v.width, v.height) <= 720);
        assert.equal(v.width % 2, 0);
        assert.equal(v.height % 2, 0);
      } finally {
        await video?.close();
        await fs.rm(f.dir, { recursive: true, force: true });
      }
    }
  },
);
