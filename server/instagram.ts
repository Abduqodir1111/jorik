import { Readable } from "node:stream";
import { RECENT_CHAT_LIMIT } from "../shared/inbox.js";
import {
  instagramGraphMessageId,
  instagramMessageKey,
} from "./instagram-message-key.js";
import {
  instagramAttachments,
  instagramMedia,
  trustedInstagramMediaUrl,
  type InstagramMedia,
} from "./instagram-media.js";
import { randomUUID } from "node:crypto";
import type { Account, Message } from "../shared/types.js";
import { DemoAdapter, SendFailure, type Adapter } from "./adapters.js";
import type { Store } from "./store.js";
export type InstagramOptions = {
  accountId?: "instagram-1" | "instagram-2" | "instagram-3";
  token: string;
  receiveMode?: "polling" | "webhook";
  fetcher?: typeof fetch;
};
type Person = { id: string; username?: string; name?: string };
type IGMessage = {
  id: string;
  created_time: string;
  from: Person;
  message?: string;
  attachments?: { data: InstagramMedia[] };
};
type Thread = {
  id: string;
  updated_time: string;
  participants: { data: Person[] };
  messages?: { data: IGMessage[] };
  unread_count?: number;
};
const fields =
  "id,unread_count,updated_time,participants,messages.limit(30){id,created_time,from,message,attachments}";
export class InstagramIntegration {
  private get accountId() {
    return this.opts.accountId ?? "instagram-1";
  }
  private pageId = "";
  private igId = "";
  private username = "";
  private closed = false;
  private controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private archiveRunning?: Promise<{ imported: number }>;
  private archiveStatus: {
    state: "idle" | "running" | "complete" | "error";
    imported: number;
    error?: string;
  } = { state: "idle", imported: 0 };
  recentImportStatus() {
    return { ...this.archiveStatus };
  }
  private cooldown = 0;
  private compactListing = false;
  constructor(
    private store: Store,
    private opts: InstagramOptions,
  ) {
    store.db
      .prepare(
        "INSERT OR IGNORE INTO accounts(id,name,platform,adapter,mode,state,color) VALUES(?,?,'instagram','instagram-graph','real','offline','#934866')",
      )
      .run(this.accountId, `Instagram ${this.accountId.split("-")[1]}`);
    store.db.transaction(() => {
      const rows = store.db
        .prepare(
          "SELECT m.id,m.external_id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.account_id=? AND m.external_id IS NOT NULL AND m.instagram_key IS NULL",
        )
        .all(this.accountId) as { id: string; external_id: string }[];
      const update = store.db.prepare(
        "UPDATE OR IGNORE messages SET instagram_key=? WHERE id=?",
      );
      for (const row of rows)
        update.run(instagramMessageKey(row.external_id), row.id);
    })();
    const fallback = store.resolveAdapter;
    store.resolveAdapter = (a) =>
      a.mode === "real" && a.id === this.accountId ? this.adapter : fallback(a);
    store.db
      .prepare(
        "UPDATE accounts SET adapter='instagram-graph',state='offline',error='Подключаем Instagram…' WHERE id=?",
      )
      .run(this.accountId);
  }
  private state(state: Account["state"], error: string | null) {
    if (this.closed) return;
    this.store.db
      .prepare("UPDATE accounts SET state=?,error=? WHERE id=?")
      .run(state, error, this.accountId);
    this.store.changed();
  }
  private async request(route: string, body?: unknown): Promise<any> {
    let response: Response;
    try {
      response = await (this.opts.fetcher ?? fetch)(
        "https://graph.facebook.com/v25.0/" + route,
        {
          method: body ? "POST" : "GET",
          redirect: "error",
          headers: {
            Authorization: "Bearer " + this.opts.token,
            ...(body instanceof FormData
              ? {}
              : { "Content-Type": "application/json" }),
          },
          body:
            body instanceof FormData
              ? body
              : body
                ? JSON.stringify(body)
                : undefined,
          signal: AbortSignal.any([
            this.controller.signal,
            AbortSignal.timeout(body ? 20000 : 45000),
          ]),
        },
      );
    } catch {
      throw new SendFailure(
        "Нет подтверждения от Instagram. Проверьте соединение.",
        !!body,
      );
    }
    let data: any;
    try {
      data = await response.json();
    } catch {
      throw new SendFailure("Meta вернула неполный ответ.", !!body);
    }
    if (!response.ok || data.error) {
      const code = data.error?.code;
      if (code === 190)
        this.state(
          "offline",
          "Токен Instagram истёк или отозван. Обновите токен.",
        );
      if (response.status === 429 || [4, 17, 32, 613].includes(code))
        this.cooldown = Date.now() + 60000;
      throw Object.assign(
        new SendFailure(
          data.error?.error_subcode === 2534084
            ? "Meta ограничила загрузку чатов: приложению нужен расширенный доступ instagram_manage_messages для переписок с пользователями без роли в приложении (2534084). Уже загруженные диалоги доступны."
            : data.error?.error_subcode === 2534022
              ? "Meta не открыла окно ответа для этого диалога (2534022). Попросите собеседника отправить новое сообщение в Instagram; если оно уже есть, проверьте режим приложения и подключение к сообщениям."
              : data.error?.error_subcode === 2534041
                ? "В Instagram этого аккаунта выключен доступ к Direct. Включите «Разрешить доступ к сообщениям» в разделе «Связанные инструменты»."
                : code === 190
                  ? "Токен Instagram недействителен."
                  : [10, 200].includes(code)
                    ? "Meta не разрешила запрос: проверьте доступ к сообщениям и срок ответа клиенту."
                    : `Instagram отклонил запрос (код ${Number(code) || response.status}).`,
          !!body && response.status >= 500,
        ),
        { graphCode: code, graphSubcode: data.error?.error_subcode },
      );
    }
    return data;
  }
  private async identify() {
    const me = await this.request(
      "me?fields=id,name,instagram_business_account{id,username}",
    );
    if (!me.id || !me.instagram_business_account?.id)
      throw new Error(
        "У страницы нет связанного профессионального Instagram-аккаунта.",
      );
    const identity = this.store.db
      .prepare("SELECT * FROM instagram_identity WHERE account_id=?")
      .get(this.accountId) as { page_id: string; ig_id: string } | undefined;
    if (
      identity &&
      (identity.page_id !== me.id ||
        identity.ig_id !== me.instagram_business_account.id)
    )
      throw new Error(
        "Токен принадлежит другому аккаунту. Подключение к сохранённым диалогам остановлено.",
      );
    if (this.closed) return;
    this.pageId = me.id;
    this.igId = me.instagram_business_account.id;
    this.username = me.instagram_business_account.username ?? me.name;
    this.store.db
      .prepare(
        "INSERT INTO instagram_identity VALUES(?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET username=excluded.username",
      )
      .run(this.accountId, this.pageId, this.igId, this.username);
    this.store.db
      .prepare("UPDATE accounts SET name=? WHERE id=? AND name=?")
      .run(
        this.username,
        this.accountId,
        `Instagram ${this.accountId.split("-")[1]}`,
      );
  }
  private async completeMedia(thread: Thread) {
    // Meta sometimes omits camera attachments in a conversation expansion,
    // while the individual message endpoint still returns them.
    const missing = (thread.messages?.data ?? [])
      .slice(0, 20)
      .filter((m) => !m.message && !m.attachments?.data?.length);
    for (let i = 0; i < missing.length; i += 3) {
      await Promise.all(
        missing.slice(i, i + 3).map(async (m) => {
          try {
            const detail = await this.request(
              `${encodeURIComponent(instagramGraphMessageId(m.id))}?fields=id,attachments`,
            );
            if (detail.attachments?.data?.length)
              m.attachments = detail.attachments;
          } catch {
            /* Keep the message visible if Meta cannot provide its media. */
          }
        }),
      );
    }
    return thread;
  }
  private importThread(thread: Thread, notify: boolean) {
    if (this.closed || !thread.participants?.data) return;
    const peers = thread.participants.data.filter(
      (p) => p.id !== this.igId && p.id !== this.pageId,
    );
    if (peers.length !== 1) return;
    const peer = peers[0];
    const db = this.store.db;
    let incoming = false;
    db.transaction(() => {
      const existing = db
        .prepare(
          "SELECT id FROM conversations WHERE account_id=? AND external_id=?",
        )
        .get(this.accountId, thread.id) as { id: string } | undefined;
      const byPeer = db
        .prepare(
          "SELECT c.id FROM conversations c JOIN instagram_threads t ON t.conversation_id=c.id WHERE c.account_id=? AND t.recipient_id=?",
        )
        .get(this.accountId, peer.id) as { id: string } | undefined;
      if (!existing && byPeer) {
        db.prepare("UPDATE conversations SET external_id=? WHERE id=?").run(
          thread.id,
          byPeer.id,
        );
      }
      const id = existing?.id ?? byPeer?.id ?? randomUUID();
      const date = new Date(thread.updated_time);
      if (!Number.isFinite(date.getTime())) return;
      db.prepare(
        "INSERT INTO conversations(id,account_id,external_id,name,username,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,external_id) DO UPDATE SET name=excluded.name,username=excluded.username,updated_at=MAX(conversations.updated_at,excluded.updated_at)",
      ).run(
        id,
        this.accountId,
        thread.id,
        peer.username ?? peer.name ?? "Клиент Instagram",
        peer.username ?? "",
        date.toISOString(),
      );
      const savedPeer = db
        .prepare(
          "SELECT recipient_id FROM instagram_threads WHERE conversation_id=?",
        )
        .get(id) as { recipient_id: string } | undefined;
      if (savedPeer && savedPeer.recipient_id !== peer.id)
        throw new Error("Изменился получатель Instagram-диалога.");
      db.prepare("INSERT OR IGNORE INTO instagram_threads VALUES(?,?)").run(
        id,
        peer.id,
      );
      for (const m of [...(thread.messages?.data ?? [])].reverse()) {
        const created = new Date(m.created_time);
        if (!m.id || !m.from?.id || !Number.isFinite(created.getTime()))
          continue;
        const out = m.from.id === this.igId || m.from.id === this.pageId;
        if (!out && m.from.id !== peer.id) continue;
        const key = instagramMessageKey(m.id);
        const previous = db
          .prepare(
            "SELECT id FROM messages WHERE conversation_id=? AND (external_id=? OR instagram_key=?) LIMIT 1",
          )
          .get(id, m.id, key) as { id: string } | undefined;
        const inserted = previous
          ? { changes: 0 }
          : db
              .prepare(
                "INSERT OR IGNORE INTO messages(id,conversation_id,external_id,direction,text,status,created_at,instagram_key) VALUES(?,?,?,?,?,'sent',?,?)",
              )
              .run(
                randomUUID(),
                id,
                m.id,
                out ? "out" : "in",
                m.message || "[Вложение Instagram — откройте в Instagram]",
                created.toISOString(),
                key,
              );
        const saved =
          previous ??
          (db
            .prepare(
              "SELECT id FROM messages WHERE conversation_id=? AND external_id=?",
            )
            .get(id, m.id) as { id: string });
        db.prepare(
          "UPDATE OR IGNORE messages SET instagram_key=? WHERE id=?",
        ).run(key, saved.id);
        const media = instagramAttachments(m.attachments?.data, saved.id);
        if (m.attachments) {
          db.prepare("UPDATE messages SET attachments=?,text=? WHERE id=?").run(
            JSON.stringify(media),
            m.message ||
              (media.length
                ? media.some((a) => a.kind === "video")
                  ? "Видео"
                  : "Фотография"
                : "[Вложение Instagram недоступно — откройте в Instagram]"),
            saved.id,
          );
        }
        const read = db.prepare("SELECT read_through FROM instagram_inbox_reads WHERE conversation_id=?").get(id) as { read_through: string } | undefined;
        if (
          inserted.changes && notify && !out &&
          (!read || created.toISOString() > read.read_through) &&
          Math.abs(Date.now() - created.getTime()) < 60_000
        ) incoming = true;
        if (inserted.changes && notify && !out && (!read || created.toISOString() > read.read_through))
          db.prepare("UPDATE conversations SET unread=unread+1 WHERE id=?").run(
            id,
          );
        if (out) {
          const confirmed = db.prepare("SELECT created_at FROM messages WHERE id=?").get(saved.id) as { created_at: string };
          this.markInboxRead(id, confirmed.created_at);
        }
      }
      // Only an explicit provider zero is read evidence. Do not use a missing field.
      // Limit the boundary to this provider snapshot so newer webhooks survive.
      if (thread.unread_count === 0) this.markInboxRead(id, date.toISOString());
    })();
    if (incoming) this.store.notifyIncoming();
  }
  importRecent() {
    if (this.archiveRunning) return this.archiveRunning;
    this.archiveStatus = { state: "running", imported: 0 };
    this.store.changed();
    this.archiveRunning = this.performRecentImport()
      .then((result) => {
        this.archiveStatus = { state: "complete", imported: result.imported };
        return result;
      })
      .catch((error) => {
        this.archiveStatus = {
          ...this.archiveStatus,
          state: "error",
          error:
            error instanceof Error
              ? error.message
              : "Не удалось загрузить историю Instagram.",
        };
        throw error;
      })
      .finally(() => {
        this.archiveRunning = undefined;
        if (!this.closed) this.store.changed();
      });
    return this.archiveRunning;
  }
  private async performRecentImport() {
    if (this.closed) throw new Error("Подключение Instagram закрыто.");
    if (Date.now() < this.cooldown)
      throw new Error("Meta ограничила запросы. Подождите минуту.");
    if (!this.igId) await this.identify();
    const imported = new Set<string>();
    const cursors = new Set<string>();
    let after = "";
    for (let page = 0; page < 100 && !this.closed; page++) {
      const result = await this.request(
        `${this.pageId}/conversations?platform=instagram&fields=id,updated_time&limit=${Math.min(10, RECENT_CHAT_LIMIT - imported.size)}${after ? "&after=" + encodeURIComponent(after) : ""}`,
      );
      if (!Array.isArray(result.data))
        throw new Error("Meta не вернула список диалогов.");
      const items = result.data as Thread[];
      for (let offset = 0; offset < items.length && !this.closed; offset += 3) {
        const outcomes = await Promise.allSettled(
          items.slice(offset, offset + 3).map(async (item) => {
            const detail = await this.request(
              `${encodeURIComponent(item.id)}?fields=${encodeURIComponent(fields.replace("messages.limit(30)", "messages.limit(1)"))}`,
            );
            this.importThread(detail, false);
            const saved = this.store.db
              .prepare(
                "SELECT id FROM conversations WHERE account_id=? AND external_id=?",
              )
              .get(this.accountId, item.id) as { id: string } | undefined;
            if (saved) imported.add(saved.id);
            this.archiveStatus.imported = imported.size;
          }),
        );
        const failed = outcomes.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
        if (imported.size >= RECENT_CHAT_LIMIT) break;
      }
      this.store.changed();
      if (imported.size >= RECENT_CHAT_LIMIT || !result.data.length) break;
      after = result.paging?.next ? (result.paging?.cursors?.after ?? "") : "";
      if (!after || cursors.has(after)) break;
      cursors.add(after);
    }
    this.state("connected", null);
    return { imported: imported.size };
  }
  sync() {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.performSync().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async performSync() {
    if (Date.now() < this.cooldown)
      throw new Error("Meta ограничила запросы. Подождите минуту.");
    let importedThreads = 0;
    try {
      if (this.opts.receiveMode === "webhook") {
        await this.identify();
        this.state("connected", null);
        return;
      }
      if (!this.igId) await this.identify();
      const syncStarted = new Date().toISOString();
      const lastSync = this.store.account(this.accountId).lastSync;
      const cutoff = lastSync ? Date.parse(lastSync) - 2000 : 0;
      const listFields = lastSync
        ? "id,updated_time"
        : fields.replace("messages.limit(30)", "messages.limit(1)");
      let after = "",
        count = 0;
      do {
        const list = () =>
          this.request(
            `${this.pageId}/conversations?platform=instagram&fields=${encodeURIComponent(this.compactListing ? "id,updated_time" : listFields)}&limit=${this.compactListing ? 1 : 10}${after ? "&after=" + encodeURIComponent(after) : ""}`,
          );
        let result;
        try {
          result = await list();
        } catch (error) {
          // Some Pages reject even small batches. Retain pagination and load
          // individual conversations without expanding messages in the list.
          if (
            this.compactListing ||
            ![1, -2].includes((error as { graphCode?: number }).graphCode ?? 0)
          )
            throw error;
          this.compactListing = true;
          result = await list();
        }
        if (this.closed) return;
        if (!Array.isArray(result.data))
          throw new Error("Meta не вернула список диалогов.");
        for (const thread of result.data as Thread[]) {
          if (lastSync && Date.parse(thread.updated_time) < cutoff) continue;
          const detail = thread.messages
            ? thread
            : await this.request(
                `${encodeURIComponent(thread.id)}?fields=${encodeURIComponent(fields)}`,
              );
          this.importThread(
            lastSync ? await this.completeMedia(detail) : detail,
            !!lastSync ||
              !!this.store.db
                .prepare(
                  "SELECT 1 FROM conversations WHERE account_id=? AND external_id=?",
                )
                .get(this.accountId, thread.id),
          );
          importedThreads++;
        }
        count += result.data.length;
        after = result.paging?.next
          ? (result.paging?.cursors?.after ?? "")
          : "";
        this.state("connected", null);
        if (
          lastSync &&
          result.data.length &&
          result.data.every((t: Thread) => Date.parse(t.updated_time) < cutoff)
        )
          break;
      } while (after && count < RECENT_CHAT_LIMIT);
      if (this.closed) return;
      this.store.db
        .prepare("UPDATE accounts SET last_sync=? WHERE id=?")
        .run(syncStarted, this.accountId);
      this.state("connected", null);
    } catch (e) {
      const accessLimited =
        (e as { graphSubcode?: number }).graphSubcode === 2534084;
      const partial =
        importedThreads > 0 &&
        [1, -2].includes((e as { graphCode?: number }).graphCode ?? 0);
      this.state(
        partial ? "connected" : "offline",
        partial && !accessLimited
          ? "Последние диалоги загружены. Meta временно не отдаёт часть истории; повторим загрузку автоматически."
          : e instanceof Error
            ? e.message
            : "Ошибка Instagram",
      );
      throw e;
    }
  }
  private markInboxRead(id: string, through: string) {
    const db = this.store.db;
    db.prepare("INSERT INTO instagram_inbox_reads(conversation_id,read_through) VALUES(?,?) ON CONFLICT(conversation_id) DO UPDATE SET read_through=MAX(read_through,excluded.read_through)").run(id, through);
    db.prepare(`UPDATE conversations SET unread=MIN(unread, (SELECT COUNT(*) FROM messages
      WHERE conversation_id=? AND direction='in' AND created_at>(SELECT read_through FROM instagram_inbox_reads WHERE conversation_id=?))) WHERE id=?`).run(id, id, id);
  }
  private receiveRead(event: any, identity: { ig_id: string; page_id: string }) {
    const sender = event?.sender?.id, recipient = event?.recipient?.id;
    if (typeof sender !== "string" || typeof recipient !== "string") return false;
    const own = (id: string) => id === identity.ig_id || id === identity.page_id;
    if (own(sender) === own(recipient)) return false;
    const inbox = own(sender), peer = inbox ? recipient : sender;
    const row = this.store.db.prepare("SELECT c.id FROM conversations c JOIN instagram_threads t ON t.conversation_id=c.id WHERE c.account_id=? AND t.recipient_id=?").get(this.accountId, peer) as { id: string } | undefined;
    if (!row) return false;
    const read = event.read;
    let through: string | undefined;
    if (typeof read?.mid === "string") {
      const m = this.store.db.prepare("SELECT created_at FROM messages WHERE conversation_id=? AND direction=? AND (external_id=? OR instagram_key=?) AND status='sent'").get(row.id, inbox ? "in" : "out", read.mid, instagramMessageKey(read.mid)) as { created_at: string } | undefined;
      through = m?.created_at;
    } else if (Number.isFinite(read?.watermark) && read.watermark > 0 && read.watermark <= Date.now() + 60_000) {
      through = new Date(read.watermark).toISOString();
    }
    if (!through) return false;
    if (inbox) this.markInboxRead(row.id, through);
    else {
      // A customer reading our reply does not acknowledge their incoming messages.
      const seen = new Date().toISOString();
      this.store.db.prepare("UPDATE messages SET read_at=? WHERE conversation_id=? AND direction='out' AND status='sent' AND created_at<=? AND read_at IS NULL").run(seen, row.id, through);
    }
    return true;
  }
  receiveWebhook(entry: any) {
    if (this.closed) return 0;
    const identity = this.store.db
      .prepare(
        "SELECT ig_id,page_id FROM instagram_identity WHERE account_id=?",
      )
      .get(this.accountId) as { ig_id: string; page_id: string } | undefined;
    if (!identity || ![identity.ig_id, identity.page_id].includes(entry?.id))
      return 0;
    if (!this.igId) {
      this.igId = identity.ig_id;
      this.pageId = identity.page_id;
    }
    let handled = 0;
    const events = [
      ...(Array.isArray(entry.messaging)
        ? entry.messaging.map((event: any) => ({ event, standby: false }))
        : []),
      ...(Array.isArray(entry.standby)
        ? entry.standby.map((event: any) => ({ event, standby: true }))
        : []),
      ...(Array.isArray(entry.changes)
        ? entry.changes
            .filter((change: any) =>
              ["messages", "standby", "messaging_seen", "message_reads", "message_echoes"].includes(change?.field),
            )
            .map((change: any) => ({
              event: change.value,
              standby: change.field === "standby",
            }))
        : []),
    ];
    for (const { event, standby } of events) {
      if (event?.read) {
        if (this.receiveRead(event, identity)) handled++;
        continue;
      }
      const message = event?.message;
      const sender = event?.sender?.id,
        recipient = event?.recipient?.id;
      const timestamp = Number(event?.timestamp);
      const date = new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp);
      if (
        typeof message?.mid !== "string" ||
        typeof sender !== "string" ||
        typeof recipient !== "string" ||
        !Number.isFinite(date.getTime())
      )
        continue;
      const out = sender === identity.ig_id || sender === identity.page_id;
      if (
        !out &&
        recipient !== identity.ig_id &&
        recipient !== identity.page_id
      )
        continue;
      if (message.is_echo && !out) continue;
      const peer = out ? recipient : sender;
      const saved = this.store.db
        .prepare(
          "SELECT c.external_id,c.name,c.username FROM conversations c JOIN instagram_threads t ON t.conversation_id=c.id WHERE c.account_id=? AND t.recipient_id=?",
        )
        .get(this.accountId, peer) as
        { external_id: string; name: string; username: string } | undefined;
      // Reuse the same importer and message IDs as polling to deduplicate retries.
      this.importThread(
        {
          id: saved?.external_id ?? `webhook:${peer}`,
          updated_time: date.toISOString(),
          participants: {
            data: [
              { id: identity.ig_id },
              {
                id: peer,
                name: saved?.name ?? "Клиент Instagram",
                username: saved?.username || undefined,
              },
            ],
          },
          messages: {
            data: [
              {
                id: message.mid,
                created_time: date.toISOString(),
                from: { id: out ? identity.ig_id : peer },
                message:
                  typeof message.text === "string" ? message.text : undefined,
                attachments: Array.isArray(message.attachments)
                  ? {
                      data: message.attachments.map((a: any) =>
                        a.type === "video"
                          ? { video_data: { url: a.payload?.url } }
                          : { image_data: { url: a.payload?.url } },
                      ),
                    }
                  : undefined,
              },
            ],
          },
        },
        true,
      );
      if (!out) {
        const conversation = this.store.db
          .prepare(
            "SELECT c.id FROM conversations c JOIN instagram_threads t ON t.conversation_id=c.id WHERE c.account_id=? AND t.recipient_id=?",
          )
          .get(this.accountId, peer) as { id: string } | undefined;
        if (conversation)
          this.store.db
            .prepare(
              "INSERT INTO instagram_thread_control(conversation_id,standby,event_timestamp) VALUES(?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET standby=excluded.standby,event_timestamp=excluded.event_timestamp WHERE excluded.event_timestamp>=instagram_thread_control.event_timestamp",
            )
            .run(conversation.id, standby ? 1 : 0, date.getTime());
      }
      console.info(
        "Meta webhook stream",
        this.accountId,
        standby ? "standby" : "messages",
      );
      handled++;
    }
    if (handled) {
      if (this.opts.receiveMode === "webhook")
        this.store.db
          .prepare(
            "UPDATE accounts SET state='connected',error=NULL,last_sync=? WHERE id=?",
          )
          .run(new Date().toISOString(), this.accountId);
      this.store.changed();
    }
    return handled;
  }
  start() {
    if (this.opts.receiveMode === "webhook") {
      void this.sync().catch(() => {});
      return;
    }
    const run = async () => {
      let delay = 5000;
      try {
        await this.sync();
      } catch {
        delay = Math.max(30000, this.cooldown - Date.now());
      }
      if (!this.closed) this.timer = setTimeout(run, delay);
    };
    void run();
  }
  async history(id: string) {
    const conv = this.store.conversation(id);
    if (conv.accountId !== this.accountId)
      throw new Error("Неверный аккаунт Instagram.");
    if (!this.igId) await this.identify();
    const historyFields =
      this.opts.receiveMode === "webhook"
        ? fields.replace("messages.limit(30)", "messages.limit(10)")
        : fields;
    let thread: Thread;
    if (conv.externalId.startsWith("webhook:")) {
      const peer = this.store.db
        .prepare(
          "SELECT recipient_id FROM instagram_threads WHERE conversation_id=?",
        )
        .get(id) as { recipient_id: string } | undefined;
      if (!peer) throw new Error("Получатель Instagram не найден.");
      const result = await this.request(
        `${this.pageId}/conversations?platform=instagram&user_id=${encodeURIComponent(peer.recipient_id)}&fields=${encodeURIComponent(historyFields)}&limit=1`,
      );
      thread = result.data?.[0];
      if (!thread) return { ok: true };
    } else {
      thread = await this.request(
        `${encodeURIComponent(conv.externalId)}?fields=${encodeURIComponent(historyFields)}`,
      );
    }
    this.importThread(await this.completeMedia(thread), false);
    if (!this.closed) this.store.changed();
    return { ok: true };
  }
  async media(messageId: string, index: number, range?: string) {
    const row = this.store.db
      .prepare(
        "SELECT m.external_id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=? AND c.account_id=?",
      )
      .get(messageId, this.accountId) as { external_id: string } | undefined;
    if (!row || !Number.isInteger(index) || index < 0 || index > 99)
      throw new Error("Вложение не найдено.");
    if (range && !/^bytes=\d*-\d*$/.test(range))
      throw new Error("Некорректный диапазон видео.");
    // Refresh expiring CDN URLs without exposing the page token to the browser.
    const data = await this.request(
      `${encodeURIComponent(instagramGraphMessageId(row.external_id))}?fields=id,attachments`,
    );
    const item = instagramMedia(data.attachments?.data).find(
      (a) => a.index === index,
    );
    if (!item) throw new Error("Meta больше не предоставляет это вложение.");
    let url = item.url;
    let response: Response | undefined;
    for (let redirect = 0; redirect < 5; redirect++) {
      response = await (this.opts.fetcher ?? fetch)(url, {
        redirect: "manual",
        headers: range ? { Range: range } : {},
        signal: AbortSignal.any([
          this.controller.signal,
          AbortSignal.timeout(60000),
        ]),
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel();
      const next =
        location && trustedInstagramMediaUrl(new URL(location, url).href);
      if (!next) throw new Error("Недоступный адрес вложения Instagram.");
      url = next;
    }
    if (!response || ![200, 206].includes(response.status) || !response.body) {
      await response?.body?.cancel();
      throw new Error("Не удалось загрузить вложение Instagram.");
    }
    const mime = response.headers.get("content-type")?.split(";")[0] ?? "";
    if (
      !(item.kind === "image"
        ? ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime)
        : ["video/mp4", "video/webm", "video/quicktime"].includes(mime))
    ) {
      await response.body.cancel();
      throw new Error("Формат вложения не поддерживается.");
    }
    const maximum =
      item.kind === "image" ? 25 * 1024 * 1024 : 150 * 1024 * 1024;
    if (Number(response.headers.get("content-length")) > maximum) {
      await response.body.cancel();
      throw new Error("Вложение слишком большое для просмотра.");
    }
    const body = response.body;
    async function* bounded() {
      let total = 0;
      for await (const chunk of body as any) {
        total += chunk.length;
        if (total > maximum) throw new Error("Превышен размер вложения");
        yield chunk;
      }
    }
    return {
      stream: Readable.from(bounded()),
      mime,
      status: response.status,
      range: response.headers.get("content-range"),
      length: response.headers.get("content-length"),
    };
  }
  async profilePhoto(conversationId: string): Promise<Buffer | null> {
    const c = this.store.conversation(conversationId);
    if (c.accountId !== this.accountId)
      throw new Error("Неверный аккаунт Instagram");
    const peer = this.store.db
      .prepare(
        "SELECT recipient_id FROM instagram_threads WHERE conversation_id=?",
      )
      .get(conversationId) as { recipient_id: string } | undefined;
    if (!peer || this.closed) return null;
    const profile = await this.request(
      `${encodeURIComponent(peer.recipient_id)}?fields=profile_pic`,
    );
    const url = trustedInstagramMediaUrl(profile.profile_pic);
    if (!url) return null;
    const response = await (this.opts.fetcher ?? fetch)(url, {
      redirect: "error",
      signal: AbortSignal.any([
        this.controller.signal,
        AbortSignal.timeout(15000),
      ]),
    });
    if (!response.ok || !response.body) return null;
    if (Number(response.headers.get("content-length")) > 2 * 1024 * 1024) {
      await response.body.cancel();
      return null;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body as any) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024)
        throw new Error("Фото профиля слишком большое");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  private seenRequests = new Map<string, Promise<void>>();

  async markSeen(conversationId: string): Promise<void> {
    const conv = this.store.conversation(conversationId);
    if (conv.accountId !== this.accountId)
      throw new Error("Неверный аккаунт Instagram.");
    const existing = this.seenRequests.get(conversationId);
    if (existing) return existing;
    const task = (async () => {
      if (
        this.closed ||
        !this.pageId ||
        this.store.account(this.accountId).state !== "connected"
      )
        throw new Error("Instagram не подключён для отметки прочтения.");
      const peer = this.store.db
        .prepare(
          "SELECT recipient_id FROM instagram_threads WHERE conversation_id=?",
        )
        .get(conversationId) as { recipient_id: string } | undefined;
      if (!peer) throw new Error("Получатель Instagram не найден.");
      await this.request(`${encodeURIComponent(this.pageId)}/messages`, {
        recipient: { id: peer.recipient_id },
        sender_action: "mark_seen",
      });
    })();
    this.seenRequests.set(conversationId, task);
    try {
      await task;
    } finally {
      this.seenRequests.delete(conversationId);
    }
  }

  private recipient(m: Message) {
    if (this.store.conversation(m.conversationId).accountId !== this.accountId)
      throw new SendFailure("Неверный аккаунт отправки.");
    const peer = this.store.db
      .prepare(
        "SELECT recipient_id FROM instagram_threads WHERE conversation_id=?",
      )
      .get(m.conversationId) as { recipient_id: string } | undefined;
    if (!peer) throw new SendFailure("Получатель Instagram не найден.");
    return peer.recipient_id;
  }
  adapter: Adapter = {
    capabilities: {
      text: true,
      images: true,
      files: false,
      voice: false,
      history: true,
      readReceipts: true,
      replyWindowSeconds: 86400,
      idempotency: false,
    },
    connectionState: (a) => a.state,
    normalizeIncoming: new DemoAdapter().normalizeIncoming,
    loadDialogs: async () => {
      await this.sync();
      return [];
    },
    loadHistory: async () => [],
    reconnectAndSync: async () => {
      await this.sync();
      return [];
    },
    validateReply: (a, m) => {
      if (a.id !== this.accountId || a.state !== "connected" || !this.pageId)
        throw new SendFailure("Instagram не подключён.");
      this.recipient(m);
      const control = this.store.db
        .prepare(
          "SELECT standby FROM instagram_thread_control WHERE conversation_id=?",
        )
        .get(m.conversationId) as { standby: number } | undefined;
      if (control?.standby)
        throw new SendFailure(
          "Этой перепиской управляет другое приложение Meta. Сообщение доступно для просмотра; для ответа нужно передать управление перепиской в Jorik.",
        );
      if (Buffer.byteLength(m.text, "utf8") > 1000)
        throw new SendFailure("Сократите ответ Instagram до 1000 байт.");
      const last = this.store.db
        .prepare(
          "SELECT MAX(created_at) AS date FROM messages WHERE conversation_id=? AND direction='in'",
        )
        .get(m.conversationId) as { date: string | null };
      if (!last.date || Date.now() - Date.parse(last.date) >= 86400000)
        throw new SendFailure(
          "Прошло больше 24 часов с сообщения клиента. Ответьте в Instagram или дождитесь нового сообщения.",
        );
      if (Date.now() < this.cooldown)
        throw new SendFailure("Meta ограничила запросы. Подождите минуту.");
    },
    send: async (a, m) => {
      this.adapter.validateReply(a, m);
      const target = m.replyToId
        ? this.store
            .messages(m.conversationId)
            .find((x) => x.id === m.replyToId)
        : undefined;
      const quotedText = target
        ? `↪ ${target.text.slice(0, 160)}\n\n${m.text}`
        : m.text;
      if (!m.attachments.length && Buffer.byteLength(quotedText, "utf8") > 1000)
        throw new SendFailure("Сократите ответ вместе с цитатой до 1000 байт.");
      let message: unknown = {
        text: target ? `↪ ${target.text.slice(0, 160)}\n\n${m.text}` : m.text,
      };
      if (m.attachments.length) {
        if (m.replyToId)
          throw new SendFailure(
            "В Instagram отправьте изображение отдельно от цитаты.",
          );
        if (m.text)
          throw new SendFailure(
            "В Instagram отправьте фото и текст отдельными сообщениями.",
          );
        const id = m.attachments[0].url.split("/").at(-1);
        const upload = this.store.db
          .prepare(
            "SELECT name,mime,bytes FROM uploads WHERE id=? AND conversation_id=?",
          )
          .get(id, m.conversationId) as
          { name: string; mime: string; bytes: Buffer } | undefined;
        if (!upload) throw new SendFailure("Файл не найден.");
        const form = new FormData();
        form.set("platform", "instagram");
        form.set(
          "message",
          JSON.stringify({
            attachment: { type: "image", payload: { is_reusable: true } },
          }),
        );
        form.set(
          "filedata",
          new Blob([new Uint8Array(upload.bytes)], { type: upload.mime }),
          upload.name,
        );
        const uploaded = await this.request(
          `${this.pageId}/message_attachments`,
          form,
        );
        if (!uploaded.attachment_id)
          throw new SendFailure("Instagram не подтвердил загрузку файла.");
        message = {
          attachment: {
            type: "image",
            payload: { attachment_id: uploaded.attachment_id },
          },
        };
      }
      const result = await this.request(`${this.pageId}/messages`, {
        recipient: { id: this.recipient(m) },
        messaging_type: "RESPONSE",
        message,
      });
      if (!result.message_id)
        throw new SendFailure(
          "Meta не подтвердила отправку. Проверьте сообщение в Instagram.",
          true,
        );
      return { externalId: result.message_id };
    },
  };
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.controller.abort();
    await this.running?.catch(() => {});
    await this.archiveRunning?.catch(() => {});
  }
}
