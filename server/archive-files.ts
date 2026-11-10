import { createHash } from "node:crypto";
import type { ArchivePdfMetadata } from "./archive-pdf.js";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ArchiveIndex } from "./archive-index.js";
import type { ArchiveVideo } from "./archive-video.js";
import type { ArchiveFileEntry } from "../shared/archive.js";

const fail = (message: string, statusCode = 404) =>
  Object.assign(new Error(message), { statusCode });
const hidden = (name: string) =>
  /^[.@#]/.test(name) ||
  /^(Thumbs\.db|desktop\.ini)$/i.test(name) ||
  /\.(chat|tmp)\.mp4$/i.test(name);
const image = /\.(jpe?g|png|webp|gif)$/i;
const movie = /\.(mp4|mov|webm|m4v)$/i;
const book = /\.(pdf|epub|fb2|mobi|djvu|zip|rar|7z|cbr|cbz)$/i;
const query = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/),
  file: z.string().max(1024).default(""),
});

export class ArchiveFiles {
  constructor(readonly index: ArchiveIndex) {}
  async resolve(id: string, relative = "") {
    const entry = await this.index.get(id).catch(() => {
      throw fail("Элемент архива недоступен");
    });
    const parts = relative ? relative.split("/") : [];
    if (
      parts.length > 20 ||
      parts.some(
        (p) => !p || p === "." || p === ".." || hidden(p) || /[\\\0]/.test(p),
      ) ||
      path.isAbsolute(relative)
    )
      throw fail("Путь архива недоступен");
    if (entry.type === "video" && relative)
      throw fail("Путь архива недоступен");
    let target = entry.path;
    for (const part of parts) {
      target = path.join(target, part);
      const stat = await fs.lstat(target).catch(() => null);
      if (!stat || stat.isSymbolicLink()) throw fail("Файл архива недоступен");
    }
    const real = await fs.realpath(target).catch(() => "");
    const within = path.relative(entry.root, real);
    if (
      real !== target ||
      !within ||
      within.startsWith("..") ||
      path.isAbsolute(within)
    )
      throw fail("Путь архива недоступен");
    const stat = await fs.stat(real).catch(() => null);
    if (!stat || (!stat.isFile() && !stat.isDirectory()))
      throw fail("Файл архива недоступен");
    return { entry, file: real, stat };
  }
  async list(id: string, relative: string, offset: number, limit: number) {
    const selected = await this.resolve(id, relative);
    if (!selected.stat.isDirectory()) throw fail("Это не папка");
    const names: { name: string; folder: boolean }[] = [];
    const directory = await fs.opendir(selected.file).catch(() => {
      throw fail("Не удалось прочитать папку. Повторите позже.", 503);
    });
    try {
      for await (const e of directory) {
        if (
          hidden(e.name) ||
          e.isSymbolicLink() ||
          (!e.isFile() && !e.isDirectory())
        )
          continue;
        if (names.length >= 5000)
          throw fail(
            "В папке слишком много элементов. Откройте её через «Поделиться ссылкой».",
            413,
          );
        names.push({ name: e.name, folder: e.isDirectory() });
      }
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode) throw e;
      throw fail("Не удалось прочитать папку. Повторите позже.", 503);
    }
    const rank = (e: { name: string; folder: boolean }) =>
      e.folder ? 0 : image.test(e.name) ? 1 : movie.test(e.name) ? 2 : 3;
    names.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        a.name.localeCompare(b.name, "ru", { numeric: true }),
    );
    const entries: ArchiveFileEntry[] = [];
    // Bound disk metadata requests as well as the response size on the 1 GB NAS.
    const page = names.slice(offset, offset + limit);
    for (let n = 0; n < page.length; n += 4) {
      const batch = await Promise.all(
        page.slice(n, n + 4).map(async (e) => {
          const relativePath = relative ? relative + "/" + e.name : e.name;
          try {
            const checked = await this.resolve(id, relativePath);
            return {
              name: e.name,
              relativePath,
              ext: path.extname(e.name).toLowerCase(),
              type: checked.stat.isDirectory()
                ? "folder"
                : image.test(e.name)
                  ? "image"
                  : movie.test(e.name)
                    ? "video"
                    : book.test(e.name)
                      ? "book"
                      : "other",
              sizeBytes: checked.stat.isFile() ? checked.stat.size : 0,
            } as ArchiveFileEntry;
          } catch {
            return null;
          }
        }),
      );
      entries.push(...batch.filter((e): e is ArchiveFileEntry => e !== null));
    }
    return {
      items: entries,
      total: names.length,
      nextOffset: offset + limit < names.length ? offset + limit : null,
    };
  }
  async thumbnail(id: string, relative: string) {
    const original = await this.resolve(id, relative);
    if (!original.stat.isFile() || !image.test(original.file))
      throw fail("Это не изображение");
    const parent = path.dirname(original.file);
    for (const name of [
      "SYNOPHOTO_THUMB_M.jpg",
      "SYNOPHOTO_THUMB_SM.jpg",
      "SYNOPHOTO_THUMB_B.jpg",
    ]) {
      const file = path.join(
        parent,
        "@eaDir",
        path.basename(original.file),
        name,
      );
      try {
        let current = parent;
        for (const part of ["@eaDir", path.basename(original.file), name]) {
          current = path.join(current, part);
          if ((await fs.lstat(current)).isSymbolicLink())
            throw fail("Недоступная миниатюра");
        }
        if ((await fs.realpath(file)) !== file) continue;
        const stat = await fs.stat(file);
        if (stat.isFile() && stat.size > 0 && stat.size <= 2 * 1024 * 1024)
          return file;
      } catch {
        /* Optional DSM thumbnail; never generate one on the NAS. */
      }
    }
    return original.file;
  }
}

export function registerArchiveFiles(
  app: FastifyInstance,
  index: ArchiveIndex,
  video: ArchiveVideo,
  pdfMetadata: ArchivePdfMetadata,
) {
  const files = new ArchiveFiles(index);
  let listings = 0,
    streams = 0;
  function acquire(reply: FastifyReply) {
    if (streams >= 8) {
      reply.header("Retry-After", "2");
      throw fail("Сервер занят передачей файлов. Повторите чуть позже.", 503);
    }
    streams++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        streams--;
      }
    };
    reply.raw.once("finish", release);
    reply.raw.once("close", release);
  }
  app.get("/api/archive/folder-contents", async (req) => {
    const q = query
      .extend({
        offset: z.coerce.number().int().min(0).max(5000).default(0),
        limit: z.coerce.number().int().min(1).max(100).default(80),
      })
      .parse(req.query);
    if (listings >= 2)
      throw fail("Сервер читает другие папки. Повторите чуть позже.", 503);
    listings++;
    try {
      return await files.list(q.id, q.file, q.offset, q.limit);
    } finally {
      listings--;
    }
  });
  app.get("/api/archive/pdf-info", async (req, reply) => {
    const q = query.parse(req.query);
    const original = await files.resolve(q.id, q.file);
    if (!original.stat.isFile() || !/\.pdf$/i.test(original.file))
      throw fail("Это не PDF", 415);
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          q.id,
          q.file,
          original.stat.size,
          original.stat.mtimeMs,
        ]),
      )
      .digest("hex");
    try {
      return { pages: await pdfMetadata.get(original.file, key) };
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 503)
        reply.header("Retry-After", "2");
      throw error;
    }
  });
  app.get("/api/archive/thumb", { compress: false }, async (req, reply) => {
    const q = query.parse(req.query);
    acquire(reply);
    const file = await files.thumbnail(q.id, q.file);
    reply.header("Cache-Control", "no-store");
    return reply.sendFile(path.basename(file), path.dirname(file), {
      cacheControl: false,
    });
  });
  app.get("/api/archive/file", { compress: false }, async (req, reply) => {
    const q = query
      .extend({
        download: z.enum(["0", "1"]).default("0"),
        preview: z.enum(["0", "1"]).default("0"),
      })
      .parse(req.query);
    acquire(reply);
    const original = await files.resolve(q.id, q.file);
    if (!original.stat.isFile()) throw fail("Выберите файл в папке");
    const pdfPreview = q.preview === "1" && q.download === "0";
    if (pdfPreview) {
      if (!/\.pdf$/i.test(original.file))
        throw fail("Предпросмотр доступен только для PDF", 415);
      const handle = await fs.open(original.file, "r").catch(() => {
        throw fail("Не удалось открыть PDF. Повторите просмотр.", 503);
      });
      try {
        const header = Buffer.alloc(1024);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        if (!header.subarray(0, bytesRead).includes(Buffer.from("%PDF-")))
          throw fail("Файл не является корректным PDF", 415);
      } finally {
        await handle.close();
      }
      reply
        .type("application/pdf")
        .header("X-Frame-Options", "SAMEORIGIN")
        .header("Content-Security-Policy", "frame-ancestors 'self'");
      const report = reply.getHeader("Content-Security-Policy-Report-Only");
      if (typeof report === "string")
        reply.header(
          "Content-Security-Policy-Report-Only",
          report.replace("frame-ancestors 'none'", "frame-ancestors 'self'"),
        );
    }
    let file = original.file;
    if (q.download === "0" && original.entry.type === "video")
      file = (await video.cachedFile(q.id)) || file;
    const inline = image.test(file) || movie.test(file) || pdfPreview;
    const disposition = q.download === "1" || !inline ? "attachment" : "inline";
    const filename = path.basename(original.file);
    reply
      .header("Cache-Control", "no-store")
      .header(
        "Content-Disposition",
        `${disposition}; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}`,
      );
    if (!inline) reply.type("application/octet-stream");
    return reply.sendFile(path.basename(file), path.dirname(file), {
      cacheControl: false,
      acceptRanges: true,
      contentType: inline && !pdfPreview,
    });
  });
}
