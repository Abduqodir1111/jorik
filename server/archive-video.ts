import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mediaGate } from "./media-gate.js";
import type { ArchiveIndex } from "./archive-index.js";
const run = promisify(execFile);
export interface PreparedVideo {
  file: string;
  size: number;
  duration: number;
  width: number;
  height: number;
}
export class ArchiveVideo {
  private queue: {
    id: string;
    resolve: (v: PreparedVideo) => void;
    reject: (e: unknown) => void;
  }[] = [];
  private pending = new Map<string, Promise<PreparedVideo>>();
  private active = false;
  private stopped = false;
  private running?: Promise<void>;
  private controller = new AbortController();
  constructor(
    readonly index: ArchiveIndex,
    readonly cacheDir: string,
    readonly ffmpeg = process.env.FFMPEG_PATH || "ffmpeg",
    readonly ffprobe = process.env.FFPROBE_PATH || "ffprobe",
  ) {}
  private cachePath(e: {
    path: string;
    stat: { size: number; mtimeMs: number };
  }) {
    const key = createHash("sha256")
      .update(`${e.path}:${e.stat.size}:${e.stat.mtimeMs}:h264-v1`)
      .digest("hex");
    return path.join(this.cacheDir, key + ".chat.mp4");
  }
  // Preview may reuse a finished copy, but must never probe, encode or queue work.
  async cachedFile(id: string) {
    const e = await this.index.get(id, "video");
    const file = this.cachePath(e);
    try {
      const stat = await fs.lstat(file);
      if (
        stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.size > 0 &&
        stat.size <= 18 * 1024 * 1024 &&
        (await fs.realpath(file)) ===
          path.join(await fs.realpath(this.cacheDir), path.basename(file))
      )
        return file;
    } catch {
      /* No completed copy yet; stream the original. */
    }
    return undefined;
  }
  prepare(id: string, priority = false) {
    const existing = this.pending.get(id);
    if (existing) {
      if (priority) {
        const n = this.queue.findIndex((j) => j.id === id);
        if (n > 0) this.queue.unshift(...this.queue.splice(n, 1));
      }
      return existing;
    }
    const task = new Promise<PreparedVideo>((resolve, reject) => {
      const job = { id, resolve, reject };
      priority ? this.queue.unshift(job) : this.queue.push(job);
    });
    this.pending.set(id, task);
    void task.finally(() => this.pending.delete(id)).catch(() => {});
    if (!this.active) this.running = this.drain();
    return task;
  }
  private async hostHasHeadroom() {
    if (process.platform !== "linux") return true;
    try {
      const info = await fs.readFile("/proc/meminfo", "utf8");
      const available = Number(info.match(/^MemAvailable:\s+(\d+)/m)?.[1]);
      return !available || available >= 180 * 1024;
    } catch {
      return false;
    }
  }
  private async drain() {
    this.active = true;
    try {
      while (this.queue.length && !this.stopped) {
        const j = this.queue.shift()!;
        try {
          j.resolve(await mediaGate(() => this.convert(j.id)));
        } catch (e) {
          j.reject(e);
        }
      }
    } finally {
      this.active = false;
    }
  }
  private async probe(file: string) {
    const { stdout } = await run(
      this.ffprobe,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_type,codec_name,pix_fmt,width,height,color_transfer",
        "-of",
        "json",
        file,
      ],
      { timeout: 15000, maxBuffer: 65536, signal: this.controller.signal },
    );
    const p = JSON.parse(stdout),
      v = p.streams?.find((s: any) => s.codec_type === "video"),
      duration = Number(p.format?.duration);
    if (
      !v ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > 180 ||
      !v.width ||
      !v.height ||
      v.width * v.height > 2100000
    )
      throw new Error(
        "Для этого NAS: видео до 3 минут и Full HD (1920×1080 или 1080×1920). Видео 4K сначала уменьшите на компьютере.",
      );
    return {
      duration,
      width: Number(v.width),
      height: Number(v.height),
      codec: v.codec_name,
      pix: v.pix_fmt,
      transfer: v.color_transfer,
    };
  }
  private async convert(id: string): Promise<PreparedVideo> {
    if (this.stopped) throw new Error("Подготовка остановлена");
    if (!(await this.hostHasHeadroom()))
      throw new Error(
        "Сервер занят: недостаточно свободной памяти для видео. Повторите позже.",
      );
    const e = await this.index.get(id, "video");
    if (e.stat.size > 1024 * 1024 * 1024)
      throw new Error("Оригинал видео больше 1 ГБ.");
    const meta = await this.probe(e.path);
    await fs.mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    const file = this.cachePath(e);
    const result = async () => {
      const s = await fs.stat(file);
      if (!s.size || s.size > 18 * 1024 * 1024)
        throw new Error("Подготовленное видео превышает 18 МБ.");
      const p = await this.probe(file);
      if (p.codec !== "h264" || p.pix !== "yuv420p")
        throw new Error("Видео несовместимо");
      return {
        file,
        size: s.size,
        duration: p.duration,
        width: p.width,
        height: p.height,
      };
    };
    try {
      return await result();
    } catch {}
    // Always normalize MOV, HEVC, HDR and oversized MP4. Originals stay read-only.
    const temp = file + "." + randomUUID() + ".tmp.mp4";
    try {
      let cacheBytes = 0;
      for (const name of await fs.readdir(this.cacheDir)) {
        if (name.endsWith(".chat.mp4"))
          cacheBytes += (await fs.stat(path.join(this.cacheDir, name))).size;
      }
      if (cacheBytes > 2 * 1024 * 1024 * 1024)
        throw new Error(
          "Кэш видео достиг 2 ГБ. Требуется очистка старых копий.",
        );
      // Don't start another heavy process while the small NAS is under memory pressure.
      // The cgroup includes ffmpeg and Node; leave room for decoder frames and muxing.
      const readNumber = async (file: string) =>
        Number(await fs.readFile(file, "utf8"));
      try {
        let used: number, max: number;
        try {
          [used, max] = await Promise.all([
            readNumber("/sys/fs/cgroup/memory.current"),
            readNumber("/sys/fs/cgroup/memory.max"),
          ]);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          [used, max] = await Promise.all([
            readNumber("/sys/fs/cgroup/memory/memory.usage_in_bytes"),
            readNumber("/sys/fs/cgroup/memory/memory.limit_in_bytes"),
          ]);
        }

        if (Number.isFinite(max) && max - used < 160 * 1024 * 1024)
          throw new Error(
            "Недостаточно свободной памяти для видео. Повторите позже.",
          );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      const disk = await fs.statfs(this.cacheDir);
      if (disk.bavail * disk.bsize < 256 * 1024 * 1024)
        throw new Error("Недостаточно места для подготовки видео.");
      const scale =
        "scale='if(gt(iw,ih),min(720,iw),-2)':'if(gt(iw,ih),-2,min(720,ih))',setsar=1";
      const hdr = ["smpte2084", "arib-std-b67"].includes(meta.transfer);
      const filter = hdr
        ? `${scale},zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p`
        : scale;
      // Rate budget includes audio and mux overhead, verified again after conversion.
      const rate = Math.min(
        1200,
        Math.floor((17 * 1024 * 1024 * 8) / meta.duration / 1000) - 112,
      );
      await run(
        "nice",
        [
          "-n",
          "19",
          this.ffmpeg,
          "-nostdin",
          "-v",
          "error",
          "-y",
          "-threads",
          "1",
          "-filter_threads",
          "1",
          "-filter_complex_threads",
          "1",
          "-protocol_whitelist",
          "file,pipe",
          "-i",
          e.path,
          "-map",
          "0:v:0",
          "-map",
          "0:a:0?",
          "-map_metadata",
          "-1",
          "-t",
          "180",
          "-vf",
          filter,
          "-c:v",
          "libx264",
          "-threads",
          "1",
          "-preset",
          "ultrafast",
          "-crf",
          "28",
          "-maxrate",
          `${rate}k`,
          "-bufsize",
          `${rate * 2}k`,
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          "-c:a",
          "aac",
          "-b:a",
          "96k",
          "-ac",
          "2",
          temp,
        ],
        {
          timeout: 15 * 60000,
          maxBuffer: 65536,
          signal: this.controller.signal,
        },
      );
      const s = await fs.stat(temp);
      if (s.size > 18 * 1024 * 1024 || !s.size)
        throw new Error("Видео не удалось сжать до 18 МБ.");
      const after = await this.index.get(id, "video");
      if (
        after.stat.size !== e.stat.size ||
        after.stat.mtimeMs !== e.stat.mtimeMs
      )
        throw new Error("Оригинал изменился во время подготовки.");
      await fs.chmod(temp, 0o600);
      await fs.rename(temp, file);
      return await result();
    } catch (e) {
      if (e instanceof Error && !("stderr" in e)) throw e;
      throw new Error(
        "Не удалось подготовить видео. Проверьте формат, ffmpeg и доступную память.",
      );
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
  async close() {
    this.stopped = true;
    this.controller.abort();
    for (const j of this.queue.splice(0))
      j.reject(new Error("Подготовка остановлена"));
    await this.running?.catch(() => {});
  }
}
