import {
  instagramMessageKey,
  reconcileInstagramMessage,
} from "./instagram-message-key.js";
import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";
import type { Account, Conversation, Message } from "../shared/types.js";
import {
  adapterFor,
  SendFailure,
  type IncomingEvent,
  type Adapter,
} from "./adapters.js";
const conversationSelect = `SELECT c.id,c.account_id AS accountId,c.external_id AS externalId,c.name,c.username,c.stage,c.unread,(c.unread>0) AS needsReply,c.updated_at AS updatedAt,c.draft,COALESCE((SELECT text FROM messages WHERE conversation_id=c.id ORDER BY created_at DESC,rowid DESC LIMIT 1),'') AS preview FROM conversations c`;
export class Store {
  constructor(
    public db: DB,
    public changed: () => void = () => {},
    public notifyIncoming: () => void = () => {},
  ) {}
  resolveAdapter: (account: Account) => Adapter = adapterFor;
  accounts(): Account[] {
    return (
      this.db
        .prepare("SELECT *,last_sync AS lastSync FROM accounts")
        .all() as Account[]
    ).map((a) => ({ ...a, capabilities: this.resolveAdapter(a).capabilities }));
  }
  account(id: string) {
    const a = this.accounts().find((a) => a.id === id);
    if (!a) throw new Error("Аккаунт не найден");
    return a;
  }
  conversations(): Conversation[] {
    return (
      this.db
        .prepare(conversationSelect + " ORDER BY c.updated_at DESC")
        .all() as Conversation[]
    ).map((c) => ({ ...c, needsReply: c.unread > 0 }));
  }
  conversation(id: string) {
    const c = this.db.prepare(conversationSelect + " WHERE c.id=?").get(id) as
      Conversation | undefined;
    if (!c) throw new Error("Диалог не найден");
    return { ...c, needsReply: c.unread > 0 };
  }
  messages(id: string): Message[] {
    const rows = this.db
      .prepare(
        "SELECT id,conversation_id AS conversationId,external_id AS externalId,direction,text,status,created_at AS createdAt,error,attachments,reply_to_id AS replyToId,read_at AS readAt,reply_to_external_id AS replyExternalId,reply_to_snapshot AS replySnapshot FROM messages WHERE conversation_id=? ORDER BY created_at,rowid",
      )
      .all(id) as (Omit<Message, "attachments"> & {
      attachments: string;
      replyExternalId: string | null;
      replySnapshot: string | null;
    })[];
    const context = this.db
      .prepare(
        "SELECT c.name,c.username,a.name AS account_name,a.platform FROM conversations c JOIN accounts a ON a.id=c.account_id WHERE c.id=?",
      )
      .get(id) as
      | {
          name: string;
          username: string;
          account_name: string;
          platform: string;
        }
      | undefined;
    const canonical = (mid: string) =>
      context?.platform === "instagram" ? instagramMessageKey(mid) : mid;
    const byId = new Map(rows.map((m) => [m.id, m]));
    const byExternal = new Map(
      rows
        .filter((m) => m.externalId)
        .map((m) => [canonical(m.externalId!), m]),
    );
    return rows.map(({ replyExternalId, replySnapshot, ...m }) => {
      const target =
        (m.replyToId ? byId.get(m.replyToId) : undefined) ||
        (replyExternalId
          ? byExternal.get(canonical(replyExternalId))
          : undefined);
      let snapshot: Message["reply_to"];
      if (replySnapshot) {
        try {
          snapshot = JSON.parse(replySnapshot);
        } catch {
          /* A damaged snapshot must not break history. */
        }
      }
      const reply = target
        ? {
            sender_name:
              target.direction === "out"
                ? context?.account_name || "Вы"
                : context?.username
                  ? `@${context.username.replace(/^@/, "")}`
                  : context?.name || "Клиент",
            text: snapshot?.text || target.text,
            message_id: target.externalId || undefined,
          }
        : snapshot ||
          (replyExternalId || m.replyToId
            ? {
                sender_name: "Сообщение недоступно",
                text: "Исходное сообщение не загружено или удалено",
                message_id: replyExternalId || undefined,
              }
            : undefined);
      return {
        ...m,
        replyToId: target?.id || m.replyToId,
        attachments: JSON.parse(m.attachments),
        ...(reply ? { reply_to: reply } : {}),
      };
    });
  }

  incoming(accountId: string, event: IncomingEvent) {
    const a = this.account(accountId);
    const e = this.resolveAdapter(a).normalizeIncoming(event);
    const result = this.db.transaction(() => {
      let c = this.db
        .prepare(
          "SELECT id FROM conversations WHERE account_id=? AND external_id=?",
        )
        .get(accountId, e.externalConversationId) as { id: string } | undefined;
      const now = new Date().toISOString();
      if (!c) {
        c = { id: randomUUID() };
        this.db
          .prepare(
            "INSERT INTO conversations(id,account_id,external_id,name,username,updated_at) VALUES(?,?,?,?,?,?)",
          )
          .run(
            c.id,
            accountId,
            e.externalConversationId,
            e.name,
            e.username,
            now,
          );
      }
      const r = this.db
        .prepare(
          "INSERT OR IGNORE INTO messages(id,conversation_id,external_id,direction,text,status,created_at) VALUES(?,?,?,'in',?,'sent',?)",
        )
        .run(randomUUID(), c.id, e.externalMessageId, e.text, now);
      if (r.changes) {
        this.db
          .prepare(
            "UPDATE conversations SET unread=unread+1,updated_at=? WHERE id=?",
          )
          .run(now, c.id);
        this.db
          .prepare("UPDATE accounts SET last_sync=? WHERE id=?")
          .run(now, accountId);
      }
      return c.id;
    })();
    this.changed();
    return result;
  }
  enqueue(
    id: string,
    text: string,
    key: string,
    options: {
      replyToId?: string;
      uploadId?: string;
      preserveDraft?: boolean;
    } = {},
  ) {
    const c = this.conversation(id);
    return this.db.transaction(() => {
      const existing = this.db
        .prepare(
          "SELECT message_id,conversation_id FROM outbox WHERE idempotency_key=?",
        )
        .get(key) as
        { message_id: string; conversation_id: string } | undefined;
      if (existing) {
        if (existing.conversation_id !== id)
          throw new Error("Ключ отправки уже используется");
        return existing.message_id;
      }
      if (
        options.replyToId &&
        !this.db
          .prepare(
            "SELECT 1 FROM messages WHERE id=? AND conversation_id=? AND external_id IS NOT NULL",
          )
          .get(options.replyToId, id)
      )
        throw new Error("Сообщение для ответа не найдено в этом диалоге.");
      const upload = options.uploadId
        ? (this.db
            .prepare(
              "SELECT id,name,mime,length(bytes) AS size FROM uploads WHERE id=? AND conversation_id=?",
            )
            .get(options.uploadId, id) as
            | { id: string; name: string; mime: string; size: number }
            | undefined)
        : undefined;
      if (options.uploadId && !upload)
        throw new Error("Вложение не принадлежит этому диалогу.");
      const mid = randomUUID(),
        now = new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO messages(id,conversation_id,direction,text,status,created_at) VALUES(?,?,'out',?,'queued',?)",
        )
        .run(mid, c.id, text, now);
      this.db
        .prepare("UPDATE messages SET reply_to_id=?,attachments=? WHERE id=?")
        .run(
          options.replyToId || null,
          JSON.stringify(
            upload
              ? [
                  {
                    kind: "image",
                    url: "/api/uploads/" + upload.id,
                    name: upload.name,
                    mime: upload.mime,
                    size: upload.size,
                  },
                ]
              : [],
          ),
          mid,
        );
      this.db
        .prepare(
          "INSERT INTO outbox(id,message_id,conversation_id,idempotency_key,state) VALUES(?,?,?,?,'queued')",
        )
        .run(randomUUID(), mid, c.id, key);
      this.db
        .prepare(
          "UPDATE conversations SET draft=CASE WHEN ? THEN draft ELSE '' END,updated_at=? WHERE id=?",
        )
        .run(options.preserveDraft ? 1 : 0, now, id);
      this.changed();
      return mid;
    })();
  }
  busy = false;
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const job = this.db
        .prepare(
          "SELECT * FROM outbox WHERE state='queued' AND available_at<=? ORDER BY rowid LIMIT 1",
        )
        .get(Date.now()) as
        | {
            id: string;
            message_id: string;
            conversation_id: string;
            idempotency_key: string;
          }
        | undefined;
      if (!job) return;
      const c = this.conversation(job.conversation_id),
        a = this.account(c.accountId),
        adapter = this.resolveAdapter(a),
        m = this.messages(c.id).find((m) => m.id === job.message_id)!;
      this.db.transaction(() => {
        this.db
          .prepare("UPDATE outbox SET state='sending' WHERE id=?")
          .run(job.id);
        this.db
          .prepare("UPDATE messages SET status='sending' WHERE id=?")
          .run(m.id);
      })();
      this.changed();
      try {
        adapter.validateReply(a, m);
        const result = await adapter.send(a, m, job.idempotency_key);
        this.db.transaction(() => {
          if (a.platform === "instagram")
            reconcileInstagramMessage(this.db, m.id, c.id, result.externalId);
          // A live Telegram echo may arrive before the RPC response.
          this.db
            .prepare(
              "DELETE FROM messages WHERE conversation_id=? AND external_id=? AND id!=? AND id NOT IN (SELECT message_id FROM outbox)",
            )
            .run(c.id, result.externalId, m.id);
          this.db
            .prepare(
              "UPDATE messages SET status='sent',external_id=?,error=NULL WHERE id=?",
            )
            .run(result.externalId, m.id);
          this.db
            .prepare("UPDATE outbox SET state='sent' WHERE id=?")
            .run(job.id);
        })();
      } catch (e) {
        const err =
          e instanceof SendFailure
            ? e
            : new SendFailure("Не получено подтверждение провайдера", true);
        const state = err.ambiguous
          ? "unknown"
          : err.retryAfterMs
            ? "queued"
            : "error";
        this.db.transaction(() => {
          this.db
            .prepare("UPDATE messages SET status=?,error=? WHERE id=?")
            .run(state, err.message, m.id);
          this.db
            .prepare("UPDATE outbox SET state=?,available_at=? WHERE id=?")
            .run(state, Date.now() + (err.retryAfterMs ?? 0), job.id);
        })();
      }
      this.changed();
    } finally {
      this.busy = false;
    }
  }
}
export function seed(store: Store) {
  if (store.accounts().some((a) => a.mode !== "demo"))
    throw new Error("Демо-данные запрещены в реальном режиме");
  const names = [
    [
      "Анна Смирнова",
      "anna.s",
      "Здравствуйте! Подскажите, есть ли в наличии бежевая сумка?",
    ],
    ["Михаил Волков", "m.volkov", "Спасибо! Когда можно забрать заказ?"],
    [
      "София Каримова",
      "sofia.k",
      "Очень понравилась новая коллекция ✨ Можно посмотреть детали?",
    ],
    ["Даниил Петров", "dan.petrov", "Добрый день! Доставляете в Ташкент?"],
    ["Екатерина Ли", "kate.li", "Подскажите, пожалуйста, размеры"],
    ["Александр Ким", "alex.kim", "Можно оформить заказ на подарок?"],
    [
      "Мария Соколова",
      "maria.s",
      "Получила посылку, всё прекрасно! Спасибо 🤍",
    ],
    ["Тимур Рахимов", "timur.r", "Хотел бы уточнить статус моего заказа"],
  ];
  for (let i = 0; i < 4; i++) {
    const a = store.accounts()[i % 4];
    const [name, username, text] = names[i];
    store.incoming(a.id, {
      externalConversationId: String(i % 2),
      externalMessageId: "welcome",
      name,
      username,
      text: "Здравствуйте! Рады знакомству.",
    });
    store.incoming(a.id, {
      externalConversationId: String(i % 2),
      externalMessageId: `question-${i}`,
      name,
      username,
      text,
    });
  }
  // Additional separate dialogs; identical external IDs intentionally exist across accounts.
  for (let i = 4; i < 8; i++) {
    const [name, username, text] = names[i];
    store.incoming(store.accounts()[i % 4].id, {
      externalConversationId: "second",
      externalMessageId: "welcome",
      name,
      username,
      text,
    });
  }
}
