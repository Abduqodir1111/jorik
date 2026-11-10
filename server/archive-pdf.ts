import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
const busy = () =>
  Object.assign(new Error("Счётчик страниц PDF занят. Повторите чуть позже."), {
    statusCode: 503,
  });
export async function readPdfPages(file: string): Promise<number | null> {
  try {
    // Bound both virtual memory and CPU of the parser on the 1 GB NAS.
    // The validated path is a separate argument, never interpolated into shell code.
    const command = process.platform === "linux" ? "/bin/sh" : "pdfinfo";
    const args =
      process.platform === "linux"
        ? [
            "-c",
            'ulimit -v 196608; ulimit -t 4; exec pdfinfo -enc UTF-8 "$1"',
            "jorik-pdf-info",
            file,
          ]
        : ["-enc", "UTF-8", file];
    const { stdout } = await execute(command, args, {
      timeout: 5000,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
      env: { ...process.env, LC_ALL: "C" },
    });
    const match = stdout.match(/^Pages:\s+(\d+)\s*$/m),
      pages = match ? Number(match[1]) : null;
    return pages !== null &&
      Number.isSafeInteger(pages) &&
      pages > 0 &&
      pages <= 1000000
      ? pages
      : null;
  } catch (error) {
    if (
      /password|encrypted/i.test(
        String((error as { stderr?: string }).stderr || ""),
      )
    )
      return null;
    throw Object.assign(
      new Error("Не удалось определить число страниц PDF. Повторите позже."),
      { statusCode: 503 },
    );
  }
}
export class ArchivePdfMetadata {
  private cache = new Map<string, number | null>();
  private pending = new Map<string, Promise<number | null>>();
  private active = false;
  private ready: Promise<void>;
  constructor(
    readonly cacheFile: string,
    public read = readPdfPages,
  ) {
    this.ready = this.load();
  }
  private async load() {
    try {
      if ((await fs.stat(this.cacheFile)).size > 128 * 1024) return;
      const data = JSON.parse(await fs.readFile(this.cacheFile, "utf8"));
      if (
        data.version !== 1 ||
        !Array.isArray(data.entries) ||
        data.entries.length > 512
      )
        return;
      for (const row of data.entries)
        if (
          Array.isArray(row) &&
          /^[a-f0-9]{64}$/.test(row[0]) &&
          (row[1] === null ||
            (Number.isSafeInteger(row[1]) && row[1] > 0 && row[1] <= 1000000))
        )
          this.cache.set(row[0], row[1]);
    } catch {
      /* An optional cache can always be rebuilt on demand. */
    }
  }
  async get(file: string, key: string) {
    await this.ready;
    if (this.cache.has(key)) return this.cache.get(key)!;
    const pending = this.pending.get(key);
    if (pending) return pending;
    if (this.active) throw busy();
    this.active = true;
    const task = (async () => {
      const pages = await this.read(file);
      if (this.cache.size >= 512)
        this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, pages);
      try {
        await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });
        const temporary = this.cacheFile + ".tmp";
        await fs.writeFile(
          temporary,
          JSON.stringify({ version: 1, entries: [...this.cache] }),
          { mode: 0o600 },
        );
        await fs.rename(temporary, this.cacheFile);
      } catch {
        /* Keep the in-memory result even if persisting is temporarily unavailable. */
      }
      return pages;
    })().finally(() => {
      this.active = false;
      this.pending.delete(key);
    });
    this.pending.set(key, task);
    return task;
  }
}
