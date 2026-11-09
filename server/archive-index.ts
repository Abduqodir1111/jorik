import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import Fuse from "fuse.js";
import type { ArchiveEntry } from "../shared/archive.js";
export interface ArchiveRoot {
  path: string;
  share: string;
  source: ArchiveEntry["source"];
  videos: boolean;
}
export interface IndexedEntry extends ArchiveEntry {
  path: string;
  sharePath: string;
  root: string;
}
const hidden = (name: string) =>
  /^[.@#]/.test(name) || /\.(chat|tmp)\.mp4$/i.test(name);
const fail = (message: string) =>
  Object.assign(new Error(message), { statusCode: 404 });
export class ArchiveIndex {
  private entries = new Map<string, IndexedEntry>();
  private fuse = new Fuse<IndexedEntry>([], {
    keys: ["name"],
    threshold: 0.3,
    ignoreLocation: true,
    minMatchCharLength: 2,
  });
  private closed = false;
  indexing = false;
  updatedAt: string | null = null;
  error: string | null = null;
  constructor(
    readonly roots: ArchiveRoot[],
    readonly maxEntries = 30000,
  ) {}
  list() {
    return [...this.entries.values()];
  }
  get count() {
    return this.entries.size;
  }
  search(q: string): ArchiveEntry[] {
    if (q.trim().length < 2) return [];
    return this.fuse
      .search(q.trim().slice(0, 200), { limit: 15 })
      .map(({ item: { id, name, type, source } }) => ({
        id,
        name,
        type,
        source,
      }));
  }
  close() {
    this.closed = true;
  }
  private async resolvedRoots() {
    return Promise.all(
      this.roots.map(async (r) => ({ ...r, path: await fs.realpath(r.path) })),
    );
  }
  async load(file: string) {
    try {
      const stat = await fs.stat(file);
      if (stat.size > 12 * 1024 * 1024) return false;
      const saved = JSON.parse(await fs.readFile(file, "utf8"));
      const roots = await this.resolvedRoots();
      if (
        saved.version !== 1 ||
        JSON.stringify(saved.roots) !== JSON.stringify(roots) ||
        !Array.isArray(saved.entries) ||
        saved.entries.length > this.maxEntries ||
        !Number.isFinite(Date.parse(saved.updatedAt))
      )
        return false;
      const next: IndexedEntry[] = [];
      for (const tuple of saved.entries) {
        if (
          !Array.isArray(tuple) ||
          tuple.length !== 2 ||
          !Number.isInteger(tuple[0]) ||
          typeof tuple[1] !== "string"
        )
          return false;
        const root = roots[tuple[0]],
          relative = tuple[1];
        const parts = relative.split(path.sep);
        if (
          !root ||
          parts.length > 2 ||
          parts.some((s: string) => !s || s === ".." || hidden(s)) ||
          path.isAbsolute(relative) ||
          (root.videos && !/\.(mp4|mov)$/i.test(relative))
        )
          return false;
        const full = path.join(root.path, relative);
        next.push({
          id: createHash("sha256").update(full).digest("hex").slice(0, 24),
          name: parts.join(" / "),
          type: root.videos ? "video" : "folder",
          source: root.source,
          path: full,
          root: root.path,
          sharePath: path.posix.join(root.share, parts.join("/")),
        });
      }
      this.fuse.setCollection(next);
      this.entries = new Map(next.map((e) => [e.id, e]));
      this.updatedAt = saved.updatedAt;
      return true;
    } catch {
      return false;
    }
  }
  async save(file: string) {
    const roots = await this.resolvedRoots();
    // Store each relative path once; avoid serializing three repeated absolute paths per entry.
    const entries = this.list().map((e) => [
      roots.findIndex((r) => r.path === e.root && r.source === e.source),
      path.relative(e.root, e.path),
    ]);
    const temp = file + ".tmp";
    await fs.writeFile(
      temp,
      JSON.stringify({ version: 1, roots, updatedAt: this.updatedAt, entries }),
      { mode: 0o600 },
    );
    await fs.rename(temp, file);
  }
  async build() {
    if (this.indexing) return false;
    this.indexing = true;
    this.error = null;
    try {
      const next: IndexedEntry[] = [];
      let dirs = 0;
      for (const root of this.roots) {
        const realRoot = await fs.realpath(root.path);
        const walk = async (dir: string, depth: number, prefix: string) => {
          if (this.closed) throw new Error("Index closed");
          // Async I/O alone doesn't protect the NAS disk queue; pace directory reads as well.
          await delay(
            process.platform === "linux" && os.loadavg()[0] > 4 ? 200 : 5,
          );
          if (++dirs % 50 === 0)
            await new Promise<void>((r) => setImmediate(r));
          for (const e of await fs.readdir(dir, { withFileTypes: true })) {
            if (hidden(e.name) || e.isSymbolicLink()) continue;
            const full = path.join(dir, e.name),
              name = prefix ? prefix + " / " + e.name : e.name;
            const type = root.videos
              ? e.isFile() && /\.(mp4|mov)$/i.test(e.name)
                ? "video"
                : null
              : e.isDirectory()
                ? "folder"
                : null;
            if (type) {
              if (next.length >= this.maxEntries)
                throw new Error("Архив превышает безопасный размер индекса");
              next.push({
                id: createHash("sha256")
                  .update(full)
                  .digest("hex")
                  .slice(0, 24),
                name,
                type,
                source: root.source,
                path: full,
                root: realRoot,
                sharePath: path.posix.join(
                  root.share,
                  path.relative(realRoot, full).split(path.sep).join("/"),
                ),
              });
            }
            if (e.isDirectory() && depth < 2) await walk(full, depth + 1, name);
          }
        };
        await walk(realRoot, 1, "");
      }
      // Construct before swapping: an incomplete/unreadable scan never replaces a good index.
      const map = new Map(next.map((e) => [e.id, e]));
      this.fuse.setCollection(next);
      this.entries = map;
      this.updatedAt = new Date().toISOString();
      return true;
    } catch {
      this.error =
        "Не удалось обновить архив. Проверьте доступ к папкам и размер индекса.";
      return false;
    } finally {
      this.indexing = false;
    }
  }
  async get(id: string, type?: "video" | "folder") {
    const e = this.entries.get(id);
    if (!e || (type && e.type !== type)) throw fail("Элемент архива не найден");
    const real = await fs.realpath(e.path).catch(() => "");
    const rel = path.relative(e.root, real);
    if (real !== e.path || !rel || rel.startsWith("..") || path.isAbsolute(rel))
      throw fail("Путь архива недоступен");
    const stat = await fs.stat(real);
    if (e.type === "video" ? !stat.isFile() : !stat.isDirectory())
      throw fail("Элемент архива изменился");
    return { ...e, stat };
  }
}
