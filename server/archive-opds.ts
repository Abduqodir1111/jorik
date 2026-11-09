import { XMLParser } from "fast-xml-parser";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readable, Transform } from "node:stream";
import type { ArchiveBook } from "../shared/archive.js";
const downloadPath = /^\/b\/\d+\/(fb2|epub|mobi|pdf|djvu)(?:\/opds)?$/;
export class ArchiveOPDS {
  constructor(
    readonly base: string,
    readonly fetcher: typeof fetch = fetch,
  ) {}
  private async request(route: string) {
    const base = new URL(this.base);
    if (
      base.protocol !== "https:" ||
      base.username ||
      base.password ||
      base.port ||
      isIP(base.hostname) ||
      base.hostname === "localhost"
    )
      throw new Error("Некорректный адрес OPDS");
    // The base is server configuration only; clients cannot choose a host or redirect destination.
    const addresses = await lookup(base.hostname, { all: true });
    if (
      !addresses.length ||
      addresses.some(({ address }) =>
        /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.|::|fc|fd|fe80)/i.test(
          address,
        ),
      )
    )
      throw new Error("Адрес OPDS недоступен");
    const response = await this.fetcher(new URL(route, base), {
      signal: AbortSignal.timeout(8000),
      redirect: "error",
      headers: {
        Accept: route.startsWith("/opds/")
          ? "application/atom+xml"
          : "application/octet-stream",
      },
    });
    if (!response.ok || !response.body)
      throw new Error("Каталог сейчас недоступен. Повторите позже.");
    return response;
  }
  async search(query: string): Promise<ArchiveBook[]> {
    const response = await this.request(
      "/opds/search?searchType=books&searchTerm=" + encodeURIComponent(query),
    );
    const reader = response.body!.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1024 * 1024)
          throw new Error("Ответ каталога слишком большой");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const xml = new TextDecoder().decode(Buffer.concat(chunks));
    if (/<!DOCTYPE|<!ENTITY/i.test(xml))
      throw new Error("Недопустимый XML каталога");
    const parsed = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
      removeNSPrefix: true,
      processEntities: false,
      isArray: (_name, jpath) =>
        jpath === "feed.entry" ||
        String(jpath).endsWith(".link") ||
        String(jpath).endsWith(".author"),
    }).parse(xml);
    if (!parsed.feed)
      throw new Error("Каталог вернул страницу вместо OPDS. Повторите позже.");
    const format = (l: any) => {
      if (
        l.rel !== "http://opds-spec.org/acquisition/open-access" ||
        typeof l.href !== "string"
      )
        return null;
      try {
        const u = new URL(l.href, this.base);
        if (u.origin !== new URL(this.base).origin || u.search || u.hash)
          return null;
        const match = u.pathname.match(downloadPath);
        return match ? { ext: match[1], downloadPath: u.pathname } : null;
      } catch {
        return null;
      }
    };
    const text = (v: any): string =>
      typeof v === "string"
        ? v
        : typeof v === "number"
          ? String(v)
          : v?.["#text"] || "";
    return (parsed.feed?.entry || [])
      .slice(0, 10)
      .map((e: any) => ({
        id: text(e.id).slice(0, 200),
        title: text(e.title).slice(0, 300),
        author: (e.author || [])
          .map((a: any) => text(a.name))
          .join(", ")
          .slice(0, 300),
        formats: (e.link || []).map(format).filter(Boolean),
      }))
      .filter((e: ArchiveBook) => e.formats.length);
  }
  async download(p: string) {
    if (!downloadPath.test(p)) throw new Error("Недопустимый формат книги");
    const match = p.match(downloadPath)!;
    const r = await this.request(p);
    if (/text\/html/i.test(r.headers.get("content-type") || "")) {
      await r.body!.cancel();
      throw new Error("Каталог вернул страницу вместо книги");
    }
    let bytes = 0;
    const limiter = new Transform({
      transform(chunk, _enc, cb) {
        bytes += chunk.length;
        cb(
          bytes > 100 * 1024 * 1024 ? new Error("Файл превышает 100 МБ") : null,
          chunk,
        );
      },
    });
    const source = Readable.fromWeb(r.body! as any);
    source.on("error", (e) => limiter.destroy(e));
    limiter.on("close", () => source.destroy());
    const type = (r.headers.get("content-type") || "")
      .split(";")[0]
      .toLowerCase();
    const extension =
      match[1] +
      (["application/zip", "application/x-zip-compressed"].includes(type) &&
      match[1] !== "epub"
        ? ".zip"
        : "");
    return { stream: source.pipe(limiter), extension };
  }
}
