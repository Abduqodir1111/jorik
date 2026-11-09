import type { DB } from "./db.js";
export interface SynologyOptions {
  url: string;
  username: string;
  password: string;
  fetcher?: typeof fetch;
}
export class SynologySharing {
  private sid = "";
  private login?: Promise<void>;
  private pending = new Map<string, Promise<string>>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private db: DB,
    private opts: SynologyOptions,
  ) {}
  private async call(params: Record<string, string>) {
    const response = await (this.opts.fetcher || fetch)(
      new URL("/webapi/entry.cgi", this.opts.url),
      {
        method: "POST",
        body: new URLSearchParams(params),
        // Cold DSM authentication on the 1 GB NAS takes ~20s; file calls stay bounded separately.
        signal: AbortSignal.timeout(
          params.api === "SYNO.API.Auth" && params.method === "login"
            ? 60000
            : 15000,
        ),
        redirect: "error",
      },
    );
    if (!response.ok) throw new Error("DSM не отвечает");
    const text = await response.text();
    if (text.length > 1000000) throw new Error("Некорректный ответ DSM");
    return JSON.parse(text);
  }
  private async auth() {
    if (!this.login)
      this.login = (async () => {
        const r = await this.call({
          api: "SYNO.API.Auth",
          version: "6",
          method: "login",
          account: this.opts.username,
          passwd: this.opts.password,
          session: "FileStation",
          format: "sid",
        });
        if (!r.success || !r.data?.sid)
          throw new Error(
            "Не удалось войти в File Station. Проверьте учётные данные и права.",
          );
        this.sid = r.data.sid;
      })().finally(() => {
        this.login = undefined;
      });
    await this.login;
  }
  get(sharePath: string) {
    const cached = this.db
      .prepare("SELECT url FROM archive_links WHERE path=? AND expires_at>?")
      .get(sharePath, Date.now() + 60000) as { url: string } | undefined;
    if (cached) return Promise.resolve(cached.url);
    const found = this.pending.get(sharePath);
    if (found) return found;
    const task = this.queue
      .then(() => this.create(sharePath))
      .finally(() => this.pending.delete(sharePath));
    this.queue = task.catch(() => {});
    this.pending.set(sharePath, task);
    return task;
  }
  private async create(sharePath: string): Promise<string> {
    const cached = this.db
      .prepare("SELECT url FROM archive_links WHERE path=? AND expires_at>?")
      .get(sharePath, Date.now() + 60000) as { url: string } | undefined;
    if (cached) return cached.url;
    if (!this.opts.url || !this.opts.username || !this.opts.password)
      throw new Error("Подключение к File Station ещё не настроено.");
    if (!this.sid) await this.auth();
    const expires = Date.now() + 7 * 86400000;
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await this.call({
        api: "SYNO.FileStation.Sharing",
        version: "3",
        method: "create",
        path: JSON.stringify(sharePath),
        date_expired: JSON.stringify(
          new Date(expires).toISOString().slice(0, 10),
        ),
        _sid: this.sid,
      });
      if (
        !r.success &&
        [105, 106, 107, 119].includes(r.error?.code) &&
        attempt === 0
      ) {
        await this.auth();
        continue;
      }
      const link = r.data?.links?.[0];
      if (!r.success || !link?.url || link.error)
        throw new Error(
          "File Station не создал ссылку. Проверьте права доступа.",
        );
      const u = new URL(link.url);
      if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
        throw new Error("Некорректная ссылка File Station");
      // DSM may return its own HTTPS share URL instead of gofile.me. Preserve the official URL.
      this.db
        .prepare(
          "INSERT INTO archive_links VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET url=excluded.url,expires_at=excluded.expires_at",
        )
        .run(sharePath, u.href, expires - 86400000);
      return u.href;
    }
    throw new Error("Сессия File Station истекла");
  }
}
