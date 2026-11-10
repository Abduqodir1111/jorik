import { XMLParser, XMLValidator } from "fast-xml-parser";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readable, Transform } from "node:stream";
import type { ArchiveBook } from "../shared/archive.js";
import { normalizeArchiveQuery } from "../shared/archive-query.js";
const downloadPath = /^\/b\/\d+\/(fb2|epub|mobi|pdf|djvu)(?:\/opds)?$/;
const unavailable = (message: string, retryable = false) =>
  Object.assign(new Error(message), { statusCode: 502, retryable });
function aborted<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    task
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
export class ArchiveOPDS {
  private cache = new Map<string, { expires: number; books: ArchiveBook[] }>();
  private pending = new Map<string, Promise<ArchiveBook[]>>();
  private activeSearches = 0;
  constructor(
    readonly base: string,
    readonly fetcher: typeof fetch = fetch,
    readonly options: {
      attemptTimeoutMs?: number;
      searchTimeoutMs?: number;
      retryDelayMs?: number;
      cacheTtlMs?: number;
      now?: () => number;
      headerTimeoutMs?: number;
      idleTimeoutMs?: number;
    } = {},
  ) {}
  private async request(route: string, signal?: AbortSignal) {
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
    let target = new URL(route, base);
    for (let hop = 0; hop < 4; hop++) {
      const allowedHost =
        target.hostname === base.hostname ||
        (base.hostname === "flibusta.is" &&
          target.hostname === "static.flibusta.is");
      if (
        !allowedHost ||
        target.protocol !== "https:" ||
        target.username ||
        target.password ||
        target.port
      )
        throw new Error("Недопустимое перенаправление каталога");
      const controller = signal ? undefined : new AbortController();
      const requestSignal = signal || controller!.signal;
      const headerTimer = controller
        ? setTimeout(
            () => controller.abort(new DOMException("Timeout", "TimeoutError")),
            this.options.headerTimeoutMs ?? 20000,
          )
        : undefined;
      let response: Response;
      try {
        const addresses = await aborted(
          lookup(target.hostname, { all: true }),
          requestSignal,
        );
        if (
          !addresses.length ||
          addresses.some(({ address }) =>
            /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.|::|fc|fd|fe80)/i.test(
              address,
            ),
          )
        )
          throw new Error("Адрес OPDS недоступен");
        response = await this.fetcher(target, {
          signal: requestSignal,
          redirect: "manual",
          headers: {
            Accept: route.startsWith("/opds/")
              ? "application/atom+xml"
              : "application/octet-stream",
          },
        });
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode) throw error;
        throw unavailable(
          requestSignal.aborted
            ? "Флибуста не ответила вовремя. Повторите запрос."
            : "Не удалось связаться с Флибустой. Повторите запрос.",
          true,
        );
      } finally {
        if (headerTimer) clearTimeout(headerTimer);
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || route.startsWith("/opds/"))
          throw new Error("Недопустимое перенаправление каталога");
        target = new URL(location, target);
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw unavailable(
          response.status === 429
            ? "Флибуста ограничила запросы. Повторите чуть позже."
            : "Флибуста временно недоступна. Повторите запрос.",
          [502, 503, 504].includes(response.status),
        );
      }
      return response;
    }
    throw new Error("Слишком много перенаправлений каталога");
  }

  search(query: string): Promise<ArchiveBook[]> {
    const clean = normalizeArchiveQuery(query),
      key = clean.toLocaleLowerCase("ru");
    if (clean.length < 2 || clean.length > 200)
      return Promise.reject(new Error("Введите название от 2 до 200 символов"));
    const now = (this.options.now || Date.now)();
    for (const [k, value] of this.cache)
      if (value.expires <= now) this.cache.delete(k);
    const cached = this.cache.get(key);
    if (cached) return Promise.resolve(cached.books);
    const pending = this.pending.get(key);
    if (pending) return pending;
    if (this.pending.size >= 6)
      return Promise.reject(
        unavailable("Каталог занят. Повторите поиск чуть позже."),
      );
    const task = this.runSearch(clean)
      .then((books) => {
        if (this.cache.size >= 32)
          this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, {
          expires:
            (this.options.now || Date.now)() +
            (this.options.cacheTtlMs ?? (books.length ? 120000 : 20000)),
          books,
        });
        return books;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }
  private async runSearch(query: string) {
    if (this.activeSearches >= 2)
      throw unavailable("Каталог занят. Повторите поиск чуть позже.");
    this.activeSearches++;
    const deadline = Date.now() + (this.options.searchTimeoutMs ?? 25000);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const controller = new AbortController();
        const remaining = deadline - Date.now();
        if (remaining <= 0)
          throw unavailable("Флибуста не ответила вовремя. Повторите поиск.");
        const timer = setTimeout(
          () => controller.abort(new DOMException("Timeout", "TimeoutError")),
          Math.min(remaining, this.options.attemptTimeoutMs ?? 15000),
        );
        try {
          return await this.searchOnce(query, controller.signal);
        } catch (error) {
          if (attempt && controller.signal.aborted)
            throw unavailable("Флибуста не ответила вовремя. Повторите поиск.");
          if (
            attempt ||
            (!controller.signal.aborted &&
              !(error as { retryable?: boolean }).retryable)
          )
            throw error;
          if (deadline - Date.now() <= 100)
            throw unavailable("Флибуста не ответила вовремя. Повторите поиск.");
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              Math.min(this.options.retryDelayMs ?? 250, deadline - Date.now()),
            ),
          );
        } finally {
          clearTimeout(timer);
        }
      }
      throw unavailable("Флибуста временно недоступна. Повторите поиск.");
    } finally {
      this.activeSearches--;
    }
  }
  private async searchOnce(
    query: string,
    signal: AbortSignal,
  ): Promise<ArchiveBook[]> {
    const response = await this.request(
      "/opds/search?searchType=books&searchTerm=" + encodeURIComponent(query),
      signal,
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
    if (XMLValidator.validate(xml) !== true)
      throw unavailable("Каталог вернул повреждённый ответ. Повторите поиск.");
    const parsed = new XMLParser({
      parseTagValue: false,
      ignoreAttributes: false,
      attributeNamePrefix: "",
      removeNSPrefix: true,
      processEntities: false,
      isArray: (_name, jpath) =>
        jpath === "feed.entry" ||
        String(jpath).endsWith(".link") ||
        String(jpath).endsWith(".author"),
    }).parse(xml);
    if (!Object.prototype.hasOwnProperty.call(parsed, "feed"))
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
    const text = (value: any): string => {
      const raw = value && typeof value === "object" ? value["#text"] : value;
      return typeof raw === "string" ||
        typeof raw === "number" ||
        typeof raw === "boolean"
        ? String(raw)
        : "";
    };
    return (parsed.feed?.entry || [])
      .map((e: any) => ({
        id: text(e.id).slice(0, 200),
        title: text(e.title).slice(0, 300),
        author: (e.author || [])
          .map((a: any) => text(a.name))
          .join(", ")
          .slice(0, 300),
        formats: (e.link || []).map(format).filter(Boolean),
      }))
      .filter((e: ArchiveBook) => e.formats.length)
      .slice(0, 10);
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
    let idle: ReturnType<typeof setTimeout>;
    const resetIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () =>
          limiter.destroy(
            unavailable(
              "Скачивание остановилось: каталог долго не передаёт данные. Повторите скачивание.",
            ),
          ),
        this.options.idleTimeoutMs ?? 45000,
      );
      idle.unref();
    };
    const limiter = new Transform({
      transform(chunk, _enc, cb) {
        resetIdle();
        bytes += chunk.length;
        cb(
          bytes > 100 * 1024 * 1024 ? new Error("Файл превышает 100 МБ") : null,
          chunk,
        );
      },
    });
    const source = Readable.fromWeb(r.body! as any);
    source.on("error", (e) => limiter.destroy(e));
    resetIdle();
    limiter.on("close", () => {
      clearTimeout(idle);
      source.destroy();
    });
    limiter.on("end", () => clearTimeout(idle));
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
