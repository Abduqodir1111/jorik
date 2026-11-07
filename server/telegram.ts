import { gunzipSync } from "node:zlib";
import {
  richMedia,
  telegramReactions,
  RICH_MEDIA_LIMIT,
} from "./telegram-rich-media.js";
import { compatibleAudio } from "./audio-conversion.js";
import {
  recoveryDelay,
  telegramNeedsLogin,
  logRecovery,
} from "./integration-recovery.js";
import { CustomFile } from "teleproto/client/uploads";
import fs from "node:fs/promises";
import path from "node:path";
import {
  photoInfo,
  documentInfo,
  documentMime,
  MAX_DOCUMENT_BYTES,
  imageMime,
  MAX_PHOTO_BYTES,
  videoInfo,
  videoMime,
  MAX_VIDEO_BYTES,
} from "./telegram-photos.js";
import { Api, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { RECENT_CHAT_LIMIT } from "../shared/inbox.js";
import { Logger } from "teleproto/extensions";
import { NewMessage, Raw } from "teleproto/events";
import bigInt from "big-integer";
import { createHash, randomUUID } from "node:crypto";
import type { Account, Message } from "../shared/types.js";
import {
  DemoAdapter,
  SendFailure,
  type Adapter,
} from "./adapters.js";
import type { Store } from "./store.js";
import { seal, unseal } from "./secrets.js";
export type TelegramOptions = {
  accountId?: "telegram-1" | "telegram-2";
  attachmentDir?: string;
  apiId: number;
  apiHash: string;
  encryptionKey: string;
};

type Stage = "phone" | "code" | "password" | "connected";
type Peer = {
  user_id: string;
  access_hash: string;
  name: string;
  username: string;
};
export function telegramRandomId(key: string) {
  return bigInt(
    createHash("sha256").update(key).digest("hex").slice(0, 15),
    16,
  ).toString();
}
export function safeTelegramError(error: unknown) {
  const e = error as { errorMessage?: string; seconds?: number; code?: number };
  const code = e?.errorMessage ?? "";
  const known: Record<string, string> = {
    PHONE_NUMBER_INVALID: "Проверьте номер телефона в международном формате.",
    PHONE_CODE_INVALID: "Неверный код. Введите код из последнего запроса.",
    PHONE_CODE_EXPIRED: "Код истёк. Начните вход заново.",
    PASSWORD_HASH_INVALID: "Неверный пароль двухэтапной защиты.",
    API_ID_INVALID:
      "Telegram отклонил API ID / API hash. Проверьте локальную конфигурацию.",
    AUTH_KEY_UNREGISTERED: "Сессия Telegram отозвана. Выполните вход заново.",
    SESSION_REVOKED: "Сессия Telegram отозвана. Выполните вход заново.",
    USER_DEACTIVATED: "Аккаунт Telegram недоступен.",
    USER_DEACTIVATED_BAN: "Аккаунт Telegram заблокирован.",
    USER_IS_BLOCKED: "Отправка этому пользователю недоступна.",
    YOU_BLOCKED_USER: "Этот пользователь заблокирован в Telegram.",
    PEER_FLOOD:
      "Telegram ограничил отправку сообщений. Проверьте ограничения аккаунта.",
    CHAT_WRITE_FORBIDDEN: "Telegram не разрешает отправку в этот диалог.",
    MESSAGE_TOO_LONG:
      "Сообщение слишком длинное. Сократите его до 4096 символов.",
    AUTH_RESTART: "Telegram просит начать вход заново.",
    PHONE_NUMBER_BANNED: "Telegram не разрешает вход с этим номером.",
    FROZEN_METHOD_INVALID: "Telegram ограничил операции этого аккаунта.",
    ALLOW_PAYMENT_REQUIRED:
      "Этот диалог требует оплаты в Telegram. Платная отправка в Jorik отключена.",
  };
  if (code.startsWith("FLOOD_WAIT") || code.startsWith("SLOWMODE_WAIT"))
    return `Telegram просит подождать ${Math.max(1, e.seconds ?? 60)} сек.`;
  return (
    known[code] ??
    "Не удалось выполнить запрос Telegram. Проверьте соединение; при необходимости повторите вход."
  );
}
export class TelegramIntegration {
  private get accountId() {
    return this.opts.accountId ?? "telegram-1";
  }
  client?: TelegramClient;
  stage: Stage = "phone";
  error: string | null = null;
  syncing = false;
  closed = false;
  private authenticated = false;
  private loginBusy = false;
  private phone?: string;
  private phoneCodeHash?: string;
  private loginOwner?: string;
  private expiry?: ReturnType<typeof setTimeout>;
  private poll?: ReturnType<typeof setTimeout>;
  private recovery?: Promise<void>;
  private recoveryFailures = 0;
  private recoveryStopped = false;
  private needsReconnect = false;
  private nextRecoveryAt: number | null = null;
  private cooldownUntil = 0;
  private codeViaApp = true;
  private background?: Promise<void>;
  private live: Promise<void> = Promise.resolve();
  constructor(
    private store: Store,
    private opts: TelegramOptions,
  ) {
    store.db
      .prepare(
        "UPDATE accounts SET state='unconfigured',adapter='telegram-mtproto',error='Войдите в Telegram' WHERE id=?",
      )
      .run(this.accountId);
    const fallback = store.resolveAdapter;
    store.resolveAdapter = (a) =>
      a.mode === "real" && a.id === this.accountId ? this.adapter : fallback(a);
  }
  get ready() {
    return (
      Number.isInteger(this.opts.apiId) &&
      this.opts.apiId > 0 &&
      /^[a-f0-9]{32}$/i.test(this.opts.apiHash) &&
      /^[a-f0-9]{64}$/i.test(this.opts.encryptionKey)
    );
  }
  status() {
    return {
      ready: this.ready,
      stage: this.stage,
      busy: this.loginBusy,
      syncing: this.syncing,
      error: this.error,
      codeViaApp: this.codeViaApp,
      recovery: {
        attempt: this.recoveryFailures,
        nextAttemptAt: this.nextRecoveryAt,
        requiresLogin: this.recoveryStopped,
      },
      scope:
        "Личные диалоги; до 50 последних диалогов и 30 сообщений при открытии",
      connected: this.authenticated && !!this.client?.connected,
    };
  }
  private changed() {
    if (!this.closed) this.store.changed();
  }
  private setState(state: Account["state"], error: string | null) {
    if (this.closed) return;
    this.error = error;
    this.store.db
      .prepare("UPDATE accounts SET state=?,error=? WHERE id=?")
      .run(state, error, this.accountId);
    this.changed();
  }
  private newClient(session = "") {
    const logger = new Logger();
    logger.setLevel("none" as never);
    const c = new TelegramClient(
      new StringSession(session),
      this.opts.apiId,
      this.opts.apiHash,
      {
        connectionRetries: 2,
        reconnectRetries: 3,
        requestRetries: 1,
        timeout: 10,
        retryDelay: 1000,
        floodSleepThreshold: 0,
        baseLogger: logger,
        deviceModel: "Jorik · Mac",
        appVersion: "1.1.0",
        systemVersion: "Local desktop",
        langCode: "ru",
      },
    );
    // Connection timeout alone does not bound RPCs waiting on a dead transport.
    const invoke = c.invoke.bind(c);
    c.invoke = (request, dcId, options) =>
      invoke(request, dcId, {
        ...options,
        timeout: options?.timeout ?? 30000,
      });
    c.onError = async (error) => {
      if (
        this.authenticated &&
        this.client === c &&
        !this.closed &&
        !this.needsReconnect
      ) {
        this.needsReconnect = true;
        this.scheduleRecovery(5000);
        logRecovery(
          this.accountId,
          "retry",
          this.recoveryFailures,
          error,
          5000,
        );
        this.setState(
          "offline",
          "Связь с Telegram прервана. Повторяем подключение.",
        );
      }
    };
    c.addEventHandler((event) => {
      this.live = this.live
        .then(async () => {
          if (this.authenticated && !this.closed && this.client === c)
            await this.importMessage(event.message, true);
        })
        .catch(() => {
          this.setState(
            "offline",
            "Не удалось обновить диалог. Выполните синхронизацию.",
          );
        });
    }, new NewMessage({}));
    c.addEventHandler(
      (update: Api.TypeUpdate) => {
        if (
          this.authenticated &&
          this.client === c &&
          !this.closed &&
          update instanceof Api.UpdateMessageID
        )
          this.confirm(update.randomId?.toString() ?? "", String(update.id));
      },
      new Raw({ types: [Api.UpdateMessageID] }),
    );
    c.addEventHandler(
      (update: Api.TypeUpdate) => {
        if (
          !this.authenticated ||
          this.client !== c ||
          this.closed ||
          !(update instanceof Api.UpdateReadHistoryOutbox) ||
          !(update.peer instanceof Api.PeerUser)
        )
          return;
        this.markRead(update.peer.userId.toString(), update.maxId);
      },
      new Raw({ types: [Api.UpdateReadHistoryOutbox] }),
    );
    c.addEventHandler(
      (update: Api.TypeUpdate) => {
        if (
          this.authenticated &&
          this.client === c &&
          !this.closed &&
          update instanceof Api.UpdateReadHistoryInbox &&
          update.peer instanceof Api.PeerUser
        )
          this.markInboxRead(update.peer.userId.toString(), update.maxId);
      },
      new Raw({ types: [Api.UpdateReadHistoryInbox] }),
    );
    c.addEventHandler(
      (update: Api.TypeUpdate) => {
        if (!this.authenticated || this.closed || this.client !== c) return;
        this.live = this.live
          .then(async () => {
            if (!this.authenticated || this.closed || this.client !== c) return;
            if (
              update instanceof Api.UpdateEditMessage ||
              update instanceof Api.UpdateEditChannelMessage
            )
              await this.importMessage(update.message, false, true);
            else if (
              update instanceof Api.UpdateMessageReactions &&
              update.peer instanceof Api.PeerUser
            ) {
              const row = this.store.db
                .prepare(
                  "SELECT m.id,m.conversation_id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.account_id=? AND c.external_id=? AND m.external_id=?",
                )
                .get(
                  this.accountId,
                  update.peer.userId.toString(),
                  String(update.msgId),
                ) as { id: string; conversation_id: string } | undefined;
              if (row) {
                this.store.db
                  .prepare("UPDATE messages SET reactions=? WHERE id=?")
                  .run(
                    JSON.stringify(telegramReactions(update.reactions)),
                    row.id,
                  );
                this.store.publishMessage(row.id, row.conversation_id);
              }
            }
          })
          .catch(() => {
            /* A rejected edit must not disconnect the account. */
          });
      },
      new Raw({
        types: [
          Api.UpdateEditMessage,
          Api.UpdateEditChannelMessage,
          Api.UpdateMessageReactions,
        ],
      }),
    );
    this.client = c;
    return c;
  }
  private credentials() {
    return { apiId: this.opts.apiId, apiHash: this.opts.apiHash };
  }
  async start(phone: string, owner: string) {
    if (!this.ready)
      throw new Error(
        "Заполните TELEGRAM_API_ID, TELEGRAM_API_HASH и ключ шифрования на сервере.",
      );
    if (this.authenticated) throw new Error("Аккаунт уже подключён.");
    if (this.loginBusy) throw new Error("Запрос входа уже выполняется.");
    if (this.recovery)
      throw new Error(
        "Восстанавливаем соединение. Дождитесь завершения попытки.",
      );
    clearTimeout(this.poll);
    this.recoveryStopped = false;
    this.loginBusy = true;
    this.error = null;
    try {
      await this.client?.destroy();
      const c = this.newClient();
      await c.connect();
      const sent = await c.sendCode(this.credentials(), phone);
      if (sent.emailRequired || sent.emailCodeSent)
        throw new Error("EMAIL_FLOW_REQUIRED");
      this.phone = phone;
      this.phoneCodeHash = sent.phoneCodeHash;
      this.loginOwner = owner;
      this.codeViaApp = sent.isCodeViaApp;
      this.stage = "code";
      clearTimeout(this.expiry);
      this.expiry = setTimeout(
        () => {
          this.phone = undefined;
          this.phoneCodeHash = undefined;
          this.loginOwner = undefined;
          this.stage = "phone";
          void this.client?.destroy();
          this.setState(
            "unconfigured",
            "Время входа истекло. Введите номер ещё раз.",
          );
        },
        10 * 60 * 1000,
      );
      this.changed();
    } catch (e) {
      this.error =
        e instanceof Error && e.message === "EMAIL_FLOW_REQUIRED"
          ? "Telegram запросил дополнительную проверку email. Этот способ входа пока не поддержан; сообщите об этом, не передавая код."
          : safeTelegramError(e);
      this.stage = "phone";
      throw new Error(this.error);
    } finally {
      this.loginBusy = false;
    }
    return this.status();
  }
  async verify(value: string, owner: string, password = false) {
    if (this.loginBusy) throw new Error("Проверка уже выполняется.");
    if (owner !== this.loginOwner || !this.phoneCodeHash || !this.client)
      throw new Error("Начните вход с номера телефона в этом окне.");
    if (this.stage !== (password ? "password" : "code"))
      throw new Error("Этот этап входа уже завершён.");
    this.loginBusy = true;
    this.error = null;
    try {
      if (password) {
        await this.client.signInWithPassword(this.credentials(), {
          password: async () => value,
          onError: async (e) => {
            throw e;
          },
        });
      } else {
        const result = await this.client.invoke(
          new Api.auth.SignIn({
            phoneNumber: this.phone!,
            phoneCodeHash: this.phoneCodeHash,
            phoneCode: value,
          }),
        );
        if (result instanceof Api.auth.AuthorizationSignUpRequired)
          throw new Error("SIGNUP_NOT_SUPPORTED");
      }
      await this.finishLogin();
    } catch (e) {
      if (
        (e as { errorMessage?: string }).errorMessage ===
        "SESSION_PASSWORD_NEEDED"
      ) {
        this.stage = "password";
        this.changed();
      } else {
        this.error =
          e instanceof Error && e.message === "SIGNUP_NOT_SUPPORTED"
            ? "Нужен существующий Telegram-аккаунт. Регистрация здесь не выполняется."
            : e instanceof Error && e.message === "ACCOUNT_IDENTITY_MISMATCH"
              ? "Telegram 1 закреплён за другим аккаунтом. Войдите в прежний аккаунт, чтобы не смешать переписку."
              : safeTelegramError(e);
        throw new Error(this.error);
      }
    } finally {
      this.loginBusy = false;
      this.changed();
    }
    return this.status();
  }
  private async finishLogin() {
    const c = this.client!;
    const me = await c.getMe();
    if (!(me instanceof Api.User) || me.bot)
      throw new Error("Нужен личный аккаунт");
    const identity = this.store.db
      .prepare("SELECT user_id FROM telegram_sessions WHERE account_id=?")
      .get(this.accountId) as { user_id: string | null } | undefined;
    if (identity?.user_id && identity.user_id !== me.id.toString())
      throw new Error("ACCOUNT_IDENTITY_MISMATCH");
    const session = (c.session as StringSession).save();
    this.store.db
      .prepare(
        "INSERT INTO telegram_sessions(account_id,ciphertext,user_id) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET ciphertext=excluded.ciphertext,user_id=excluded.user_id",
      )
      .run(
        this.accountId,
        seal(session, this.opts.encryptionKey, this.accountId),
        me.id.toString(),
      );
    clearTimeout(this.expiry);
    this.phone = undefined;
    this.phoneCodeHash = undefined;
    this.loginOwner = undefined;
    this.authenticated = true;
    this.stage = "connected";
    this.rememberUser(me);
    this.ensureConversation(me.id.toString());
    this.setState("connected", null);
    this.runBackground();
  }
  restore() {
    if (
      !this.ready ||
      !this.store.db
        .prepare("SELECT 1 FROM telegram_sessions WHERE account_id=?")
        .get(this.accountId)
    )
      return;
    this.background = this.sync().catch(() => {});
  }
  private runBackground() {
    this.recoveryStopped = false;
    this.recoveryFailures = 0;
    this.needsReconnect = false;
    this.background = this.sync().catch(() => {});
    this.startPolling();
  }
  private startPolling() {
    this.scheduleRecovery(30000);
  }
  private scheduleRecovery(delay: number) {
    clearTimeout(this.poll);
    if (this.closed || this.recoveryStopped) return;
    this.nextRecoveryAt = Date.now() + delay;
    this.poll = setTimeout(() => {
      this.nextRecoveryAt = null;
      this.background = this.sync().catch(() => {});
    }, delay);
    this.poll.unref?.();
  }
  sync(): Promise<void> {
    if (this.recovery) return this.recovery;
    if (this.closed)
      return Promise.reject(new Error("Подключение Telegram закрыто."));
    if (this.recoveryStopped)
      return Promise.reject(
        new Error(this.error || "Выполните вход в Telegram заново."),
      );
    clearTimeout(this.poll);
    this.nextRecoveryAt = null;
    this.recovery = this.recoverAndSync().finally(() => {
      this.recovery = undefined;
    });
    return this.recovery;
  }
  private async recoverAndSync() {
    try {
      if (
        this.loginBusy ||
        this.stage === "code" ||
        this.stage === "password"
      ) {
        this.scheduleRecovery(30000);
        return;
      }
      if (Date.now() < this.cooldownUntil) {
        this.scheduleRecovery(this.cooldownUntil - Date.now());
        throw Object.assign(
          new Error("Дождитесь завершения ограничения Telegram."),
          { seconds: (this.cooldownUntil - Date.now()) / 1000 },
        );
      }
      const rebuild =
        this.needsReconnect || !this.authenticated || !this.client?.connected;
      if (rebuild) {
        // Never retire a transport while an outbox submission is in flight.
        if (this.store.busy) {
          this.scheduleRecovery(1000);
          return;
        }
        const saved = this.store.db
          .prepare(
            "SELECT ciphertext FROM telegram_sessions WHERE account_id=?",
          )
          .get(this.accountId) as { ciphertext: string } | undefined;
        if (!saved) throw { errorMessage: "LOGIN_REQUIRED" };
        let session: string;
        try {
          session = unseal(
            saved.ciphertext,
            this.opts.encryptionKey,
            this.accountId,
          );
        } catch {
          throw { errorMessage: "SESSION_DECRYPTION_FAILED" };
        }
        this.authenticated = false;
        await this.client?.destroy();
        if (this.closed) return;
        const client = this.newClient(session);
        await client.connect();
        if (this.closed) return;
        // checkAuthorization() hides network errors as false. Probe directly so
        // a timeout never gets mistaken for a revoked session.
        await client.invoke(new Api.updates.GetState());
        this.authenticated = true;
        this.stage = "connected";
        this.needsReconnect = false;
      }
      await this.syncConnected();
      if (this.closed) return;
      if (this.recoveryFailures || rebuild)
        logRecovery(this.accountId, "connected", this.recoveryFailures);
      this.recoveryFailures = 0;
      this.recoveryStopped = false;
      this.startPolling();
    } catch (error) {
      if (this.closed) return;
      this.recoveryFailures++;
      this.needsReconnect = true;
      if (telegramNeedsLogin(error)) {
        this.recoveryStopped = true;
        this.authenticated = false;
        this.stage = "phone";
        this.nextRecoveryAt = null;
        clearTimeout(this.poll);
        await this.client?.destroy().catch(() => {});
        this.setState(
          "unconfigured",
          "Сессия или настройки Telegram недействительны. Проверьте настройки и выполните вход заново.",
        );
        logRecovery(
          this.accountId,
          "requires_login",
          this.recoveryFailures,
          error,
        );
      } else {
        const seconds = Number((error as { seconds?: number })?.seconds) || 0;
        if (seconds > 0)
          this.cooldownUntil = Math.max(
            this.cooldownUntil,
            Date.now() + seconds * 1000,
          );
        const delay = recoveryDelay(
          this.recoveryFailures,
          this.cooldownUntil - Date.now(),
        );
        this.setState(
          "offline",
          `${safeTelegramError(error)} Автоподключение через ${Math.ceil(delay / 1000)} сек.`,
        );
        this.scheduleRecovery(delay);
        logRecovery(
          this.accountId,
          "retry",
          this.recoveryFailures,
          error,
          delay,
        );
      }
      throw error;
    }
  }
  private rememberUser(user: Api.TypeUser) {
    if (
      !(user instanceof Api.User) ||
      user.bot ||
      user.deleted ||
      user.id.toString() === "777000" ||
      user.accessHash === undefined
    )
      return false;
    const id = user.id.toString(),
      name = user.self
        ? "Избранное"
        : [user.firstName, user.lastName].filter(Boolean).join(" ") ||
          user.username ||
          "Клиент Telegram";
    this.store.db
      .prepare(
        "INSERT INTO telegram_peers VALUES(?,?,?,?,?) ON CONFLICT(account_id,user_id) DO UPDATE SET access_hash=excluded.access_hash,name=excluded.name,username=excluded.username",
      )
      .run(
        this.accountId,
        id,
        user.accessHash.toString(),
        name,
        user.username ?? "",
      );
    return true;
  }
  private ensureConversation(id: string) {
    const p = this.store.db
      .prepare("SELECT * FROM telegram_peers WHERE account_id=? AND user_id=?")
      .get(this.accountId, id) as Peer | undefined;
    if (!p) return;
    this.store.db
      .prepare(
        "INSERT INTO conversations(id,account_id,external_id,name,username,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,external_id) DO UPDATE SET name=excluded.name,username=excluded.username",
      )
      .run(
        randomUUID(),
        this.accountId,
        id,
        p.name,
        p.username,
        new Date(0).toISOString(),
      );
  }
  async profilePhoto(conversationId: string): Promise<Buffer | null> {
    const c = this.store.conversation(conversationId);
    if (c.accountId !== this.accountId)
      throw new Error("Неверный аккаунт Telegram");
    if (!this.authenticated || !this.client?.connected) return null;
    const photo = await this.client.downloadProfilePhoto(
      this.peer(c.externalId),
      { isBig: false },
    );
    return Buffer.isBuffer(photo) ? photo : null;
  }
  private peer(id: string) {
    const row = this.store.db
      .prepare("SELECT * FROM telegram_peers WHERE account_id=? AND user_id=?")
      .get(this.accountId, id) as Peer | undefined;
    if (!row)
      throw new SendFailure("Диалог ещё не синхронизирован с Telegram.");
    return new Api.InputPeerUser({
      userId: bigInt(row.user_id),
      accessHash: bigInt(row.access_hash),
    });
  }
  private async importMessage(
    m: Api.TypeMessage,
    unread: boolean,
    edited = false,
  ) {
    if (
      !(m instanceof Api.Message) ||
      !(m.peerId instanceof Api.PeerUser) ||
      this.closed
    )
      return;
    const id = m.peerId.userId.toString();
    if (id === "777000") return;
    if (
      !this.store.db
        .prepare(
          "SELECT 1 FROM telegram_peers WHERE account_id=? AND user_id=?",
        )
        .get(this.accountId, id)
    ) {
      try {
        const u = await this.client!.getEntity(m.peerId);
        if (u instanceof Api.User) this.rememberUser(u);
      } catch {
        return;
      }
    }
    this.ensureConversation(id);
    const c = this.store.db
      .prepare(
        "SELECT id,telegram_read_inbox_max_id FROM conversations WHERE account_id=? AND external_id=?",
      )
      .get(this.accountId, id) as
      { id: string; telegram_read_inbox_max_id: number } | undefined;
    if (!c) return;
    const previousVersion = this.store.db
      .prepare(
        "SELECT edited_at FROM messages WHERE conversation_id=? AND external_id=?",
      )
      .get(c.id, String(m.id)) as { edited_at: string | null } | undefined;
    const incomingEdit = m.editDate
      ? new Date(m.editDate * 1000).toISOString()
      : null;
    if (
      previousVersion?.edited_at &&
      (!incomingEdit || previousVersion.edited_at > incomingEdit)
    )
      return;
    const rich = richMedia(m);
    const photo = rich ? undefined : photoInfo(m);
    const video = videoInfo(m);
    const document = documentInfo(m);
    const mediaInfo = rich || photo || video || document;
    const text =
        m.message ||
        mediaInfo?.name ||
        "" ||
        (m.media
          ? "[Вложение Telegram — откройте оригинал в Telegram]"
          : "[Служебное сообщение]"),
      createdAt = new Date(m.date * 1000).toISOString();
    let insertedIncoming = false;
    const messageId = randomUUID();
    this.store.db.transaction(() => {
      const r = this.store.db
        .prepare(
          "INSERT OR IGNORE INTO messages(id,conversation_id,external_id,direction,text,status,created_at) VALUES(?,?,?,?,?,'sent',?)",
        )
        .run(
          messageId,
          c.id,
          String(m.id),
          m.out ? "out" : "in",
          text,
          createdAt,
        );
      insertedIncoming =
        !!r.changes && unread && !m.out && m.id > c.telegram_read_inbox_max_id;
      if (r.changes)
        this.store.db
          .prepare(
            "UPDATE conversations SET updated_at=MAX(updated_at,?),unread=unread+? WHERE id=?",
          )
          .run(
            createdAt,
            unread && !m.out && m.id > c.telegram_read_inbox_max_id ? 1 : 0,
            c.id,
          );
    })();
    // A native outgoing message handles earlier incoming IDs, never newer ones.
    if (m.out && !edited) this.markInboxRead(id, m.id - 1);
    if (insertedIncoming && Math.abs(Date.now() - m.date * 1000) < 60_000)
      this.store.notifyIncoming({ conversationId: c.id, messageId });
    if (mediaInfo) {
      const saved = this.store.db
        .prepare(
          "SELECT id FROM messages WHERE conversation_id=? AND external_id=?",
        )
        .get(c.id, String(m.id)) as { id: string };
      this.store.db
        .prepare("UPDATE messages SET text=?,attachments=? WHERE id=?")
        .run(
          m.message || mediaInfo.name,
          JSON.stringify([
            {
              kind:
                rich?.kind || (document ? "file" : video ? "video" : "image"),
              ...mediaInfo,
              url: rich
                ? rich.kind === "location"
                  ? ""
                  : `/api/telegram/media/${saved.id}`
                : `/api/telegram/${document ? "documents" : video ? "videos" : "photos"}/${saved.id}`,
            },
          ]),
          saved.id,
        );
    }
    const savedRow = this.store.db
      .prepare(
        "SELECT id,edited_at FROM messages WHERE conversation_id=? AND external_id=?",
      )
      .get(c.id, String(m.id)) as { id: string; edited_at: string | null };
    const editAt = m.editDate
      ? new Date(m.editDate * 1000).toISOString()
      : null;
    // History and edit updates share the same identity, unread and original date.
    if (!savedRow.edited_at || !editAt || editAt >= savedRow.edited_at) {
      this.store.db
        .prepare(
          "UPDATE messages SET text=?,edited_at=COALESCE(?,edited_at),reactions=? WHERE id=?",
        )
        .run(
          text,
          editAt,
          JSON.stringify(telegramReactions(m.reactions)),
          savedRow.id,
        );
    }
    if (m.replyTo instanceof Api.MessageReplyHeader) {
      const header = m.replyTo;
      const samePeer =
        !header.replyToPeerId ||
        (header.replyToPeerId instanceof Api.PeerUser &&
          header.replyToPeerId.userId.toString() === id);
      const external =
        samePeer && header.replyToMsgId && header.replyToMsgId !== m.id
          ? String(header.replyToMsgId)
          : null;
      const row = this.store.db
        .prepare(
          "SELECT id,reply_to_snapshot FROM messages WHERE conversation_id=? AND external_id=?",
        )
        .get(c.id, String(m.id)) as {
        id: string;
        reply_to_snapshot: string | null;
      };
      let snapshot: Message["reply_to"];
      if (header.quoteText)
        snapshot = {
          sender_name: header.replyFrom?.fromName || "Сообщение",
          text: header.quoteText.slice(0, 4096),
          message_id: external || undefined,
        };
      if (
        external &&
        !row.reply_to_snapshot &&
        !this.store.db
          .prepare(
            "SELECT 1 FROM messages WHERE conversation_id=? AND external_id=?",
          )
          .get(c.id, external)
      ) {
        try {
          const original = (
            await this.client!.getMessages(this.peer(id), {
              ids: [Number(external)],
            })
          )[0];
          if (
            original instanceof Api.Message &&
            original.peerId instanceof Api.PeerUser &&
            original.peerId.userId.toString() === id
          ) {
            const text =
              header.quoteText ||
              original.message ||
              photoInfo(original)?.name ||
              videoInfo(original)?.name ||
              documentInfo(original)?.name ||
              "Вложение";
            snapshot = {
              sender_name: original.out
                ? this.store.account(this.accountId).name
                : this.store.conversation(c.id).name,
              text: text.slice(0, 4096),
              message_id: external,
            };
          }
        } catch {
          /* Keep the reply even if the original is unavailable. */
        }
      }
      if (external || snapshot)
        this.store.db
          .prepare(
            "UPDATE messages SET reply_to_external_id=COALESCE(?,reply_to_external_id),reply_to_snapshot=COALESCE(?,reply_to_snapshot) WHERE id=?",
          )
          .run(external, snapshot ? JSON.stringify(snapshot) : null, row.id);
    }
    if (edited) this.store.publishMessage(savedRow.id, c.id);
    else this.changed();
  }
  private actionTarget(messageId: string) {
    const row = this.store.db
      .prepare(
        "SELECT m.*,c.external_id AS peer_id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=? AND c.account_id=?",
      )
      .get(messageId, this.accountId) as
      | {
          external_id: string;
          peer_id: string;
          conversation_id: string;
          text: string;
          direction: string;
          status: string;
          attachments: string;
        }
      | undefined;
    if (
      !row ||
      !row.external_id ||
      !this.authenticated ||
      !this.client?.connected
    )
      throw new Error("Сообщение или подключение Telegram недоступно.");
    return row;
  }
  private actionLocks = new Set<string>();
  async edit(messageId: string, text: string, expectedText: string) {
    const row = this.actionTarget(messageId);
    if (
      row.direction !== "out" ||
      row.status !== "sent" ||
      JSON.parse(row.attachments).length
    )
      throw new Error(
        "Редактировать можно только отправленный текст Telegram.",
      );
    if (row.text !== expectedText)
      throw new Error(
        "Сообщение уже изменилось. Откройте редактирование заново.",
      );
    if (text === row.text)
      return this.store
        .messages(row.conversation_id)
        .find((m) => m.id === messageId)!;
    if (this.actionLocks.has(messageId))
      throw new Error("Операция с сообщением уже выполняется.");
    this.actionLocks.add(messageId);
    try {
      const result = await this.client!.invoke(
        new Api.messages.EditMessage({
          peer: this.peer(row.peer_id),
          id: Number(row.external_id),
          message: text,
          noWebpage: true,
        }),
      );
      if (
        result instanceof Api.Updates ||
        result instanceof Api.UpdatesCombined
      ) {
        for (const u of result.updates)
          if (u instanceof Api.UpdateEditMessage)
            await this.importMessage(u.message, false, true);
      }
      // Telegram may return an empty updates container; never enqueue a new send.
      this.store.db
        .prepare("UPDATE messages SET text=?,edited_at=? WHERE id=?")
        .run(
          text,
          new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
          messageId,
        );
      this.store.publishMessage(messageId, row.conversation_id);
      return this.store
        .messages(row.conversation_id)
        .find((m) => m.id === messageId)!;
    } catch (e) {
      throw new Error(safeTelegramError(e));
    } finally {
      this.actionLocks.delete(messageId);
    }
  }
  async react(messageId: string, emoji: string | null) {
    const row = this.actionTarget(messageId);
    try {
      await this.client!.invoke(
        new Api.messages.SendReaction({
          peer: this.peer(row.peer_id),
          msgId: Number(row.external_id),
          reaction: emoji ? [new Api.ReactionEmoji({ emoticon: emoji })] : [],
        }),
      );
      const ms = await this.client!.getMessages(this.peer(row.peer_id), {
        ids: [Number(row.external_id)],
      });
      if (ms[0] instanceof Api.Message) {
        this.store.db
          .prepare("UPDATE messages SET reactions=? WHERE id=?")
          .run(JSON.stringify(telegramReactions(ms[0].reactions)), messageId);
        this.store.publishMessage(messageId, row.conversation_id);
      }
      return this.store
        .messages(row.conversation_id)
        .find((m) => m.id === messageId)!;
    } catch (e) {
      throw new Error(safeTelegramError(e));
    }
  }
  private richRequests = new Map<
    string,
    Promise<{ bytes: Buffer; mime: string }>
  >();
  private conversionChain: Promise<unknown> = Promise.resolve();
  async specialMedia(
    messageId: string,
    compatible = false,
  ): Promise<{ bytes: Buffer; mime: string }> {
    const key = `${messageId}:${compatible}`;
    const current = this.richRequests.get(key);
    if (current) return current;
    const task = (async () => {
      if (this.mediaActive >= 3)
        await new Promise<void>((resolve) => this.mediaWaiting.push(resolve));
      else this.mediaActive++;
      try {
        return await this.loadSpecialMedia(messageId, compatible);
      } finally {
        const next = this.mediaWaiting.shift();
        if (next) next();
        else this.mediaActive--;
      }
    })();
    this.richRequests.set(key, task);
    try {
      return await task;
    } finally {
      this.richRequests.delete(key);
    }
  }
  private async loadSpecialMedia(messageId: string, compatible: boolean) {
    const row = this.store.db
      .prepare(
        "SELECT m.external_id,m.attachments,c.external_id AS peer_id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=? AND c.account_id=?",
      )
      .get(messageId, this.accountId) as
      { external_id: string; attachments: string; peer_id: string } | undefined;
    const att =
      row &&
      (JSON.parse(row.attachments) as Message["attachments"]).find(
        (a) => a.kind === "voice" || a.kind === "sticker",
      );
    if (!row || !att || !this.opts.attachmentDir)
      throw new Error("Вложение не найдено");
    const dir = this.opts.attachmentDir;
    const file = path.join(
      dir,
      "tg-rich-" +
        createHash("sha256")
          .update(this.accountId + ":" + messageId)
          .digest("hex"),
    );
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      if (!this.authenticated || !this.client?.connected)
        throw new Error("Нет подключения к Telegram");
      const m = (
        await this.client.getMessages(this.peer(row.peer_id), {
          ids: [Number(row.external_id)],
        })
      )[0];
      const info = m instanceof Api.Message ? richMedia(m) : undefined;
      if (
        !info ||
        info.kind !== att.kind ||
        info.mime !== att.mime ||
        info.size > RICH_MEDIA_LIMIT ||
        (info.duration || 0) > 1800
      )
        throw new Error("Вложение недоступно или больше 20 МБ");
      const data = await this.client.downloadMedia(m, {
        signal: AbortSignal.timeout(60000),
        progressCallback: (got, total) => {
          if (
            Number(got) > RICH_MEDIA_LIMIT ||
            Number(total) > RICH_MEDIA_LIMIT
          )
            throw new Error("Вложение больше 20 МБ");
        },
      });
      if (
        !Buffer.isBuffer(data) ||
        !data.length ||
        data.length > RICH_MEDIA_LIMIT
      )
        throw new Error("Вложение недоступно");
      bytes = data;
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = file + "." + randomUUID() + ".tmp";
      try {
        await fs.writeFile(tmp, bytes, { mode: 0o600 });
        await fs.rename(tmp, file);
      } finally {
        await fs.rm(tmp, { force: true });
      }
    }
    if (att.mime === "application/x-tgsticker") {
      const animation = JSON.parse(
        gunzipSync(bytes, { maxOutputLength: 2 * 1024 * 1024 }).toString(
          "utf8",
        ),
      );
      if (
        !Array.isArray(animation.layers) ||
        (animation.assets || []).some(
          (a: { p?: string; u?: string }) => a.p || a.u,
        ) ||
        (animation.fonts?.list || []).some((f: { fPath?: string }) => f.fPath)
      )
        throw new Error("Неподдерживаемый стикер");
      return {
        bytes: Buffer.from(JSON.stringify(animation)),
        mime: "application/json",
      };
    }
    if (
      compatible &&
      att.kind === "voice" &&
      ["audio/ogg", "audio/opus"].includes(att.mime)
    ) {
      const convert = this.conversionChain.then(() =>
        compatibleAudio(file, file + ".m4a"),
      );
      this.conversionChain = convert.catch(() => {});
      return { bytes: await convert, mime: "audio/mp4" };
    }
    return { bytes, mime: att.mime };
  }
  private photos = new Map<string, Promise<{ bytes: Buffer; mime: string }>>();
  private mediaActive = 0;
  private mediaWaiting: (() => void)[] = [];
  private async queuedPhoto(messageId: string, video: boolean | "document") {
    if (this.mediaActive >= 3)
      await new Promise<void>((resolve) => this.mediaWaiting.push(resolve));
    else this.mediaActive++;
    try {
      return await this.downloadPhoto(messageId, video);
    } finally {
      const next = this.mediaWaiting.shift();
      if (next) next();
      else this.mediaActive--;
    }
  }
  async photo(
    messageId: string,
    video: boolean | "document" = false,
  ): Promise<{ bytes: Buffer; mime: string }> {
    const key =
      (video === "document" ? "document:" : video ? "video:" : "photo:") +
      messageId;
    const existing = this.photos.get(key);
    if (existing) return existing;
    const task = this.queuedPhoto(messageId, video);
    this.photos.set(key, task);
    try {
      return await task;
    } finally {
      this.photos.delete(key);
    }
  }
  private async downloadPhoto(messageId: string, video: boolean | "document") {
    const limit =
      video === "document"
        ? MAX_DOCUMENT_BYTES
        : video
          ? MAX_VIDEO_BYTES
          : MAX_PHOTO_BYTES;
    const mimeOf =
      video === "document" ? documentMime : video ? videoMime : imageMime;
    const row = this.store.db
      .prepare(
        "SELECT m.external_id,c.external_id AS peer_id,m.attachments FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=? AND c.account_id=?",
      )
      .get(messageId, this.accountId) as
      { external_id: string; peer_id: string; attachments: string } | undefined;
    if (
      !row ||
      !JSON.parse(row.attachments).some(
        (a: { kind: string }) =>
          a.kind ===
          (video === "document" ? "file" : video ? "video" : "image"),
      )
    )
      throw new Error("Фото или видеозапись не найдена в этом аккаунте.");
    const dir = this.opts.attachmentDir;
    if (!dir) throw new Error("Не настроено локальное хранение вложений.");
    const file = path.join(
      dir,
      "telegram-" +
        createHash("sha256")
          .update(this.accountId + ":" + messageId)
          .digest("hex") +
        (video === "document" ? ".doc" : video ? ".mp4" : ".img"),
    );
    try {
      const bytes = await fs.readFile(file);
      return { bytes, mime: mimeOf(bytes) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (!this.authenticated || !this.client?.connected)
      throw new Error(
        "Для первой загрузки вложения нужно соединение с Telegram.",
      );
    try {
      const messages = await this.client.getMessages(this.peer(row.peer_id), {
        ids: [Number(row.external_id)],
      });
      const message = messages[0];
      if (!(message instanceof Api.Message))
        throw new Error("PHOTO_UNAVAILABLE");
      const info =
        video === "document"
          ? documentInfo(message)
          : video
            ? videoInfo(message)
            : photoInfo(message);
      if (!info) throw new Error("PHOTO_UNAVAILABLE");
      if (info.size > limit) throw new Error("PHOTO_TOO_LARGE");
      const bytes = await this.client.downloadMedia(message, {
        signal: AbortSignal.timeout(video ? 180000 : 60000),
        progressCallback: (received, total) => {
          if (Number(received) > limit || Number(total) > limit)
            throw new Error("PHOTO_TOO_LARGE");
        },
      });
      if (!Buffer.isBuffer(bytes) || !bytes.length)
        throw new Error("PHOTO_UNAVAILABLE");
      if (bytes.length > limit) throw new Error("PHOTO_TOO_LARGE");
      const mime = mimeOf(bytes);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const temporary = file + "." + randomUUID() + ".tmp";
      try {
        await fs.writeFile(temporary, bytes, { mode: 0o600 });
        await fs.rename(temporary, file);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      return { bytes, mime };
    } catch (e) {
      if (e instanceof Error && e.message === "PHOTO_TOO_LARGE")
        throw new Error(
          `Вложение больше ${limit / 1024 / 1024} МБ. Откройте оригинал в Telegram.`,
        );
      if (e instanceof Error && e.message === "PHOTO_UNAVAILABLE")
        throw new Error(
          "Вложение удалено, недоступно или имеет таймер самоуничтожения.",
        );
      throw new Error(
        "Не удалось загрузить вложение из Telegram. Проверьте подключение и нажмите «Повторить».",
      );
    }
  }
  private confirm(randomId: string, externalId: string) {
    const job = this.store.db
      .prepare(
        "SELECT o.message_id,o.id,o.conversation_id FROM outbox o JOIN conversations c ON c.id=o.conversation_id WHERE o.provider_random_id=? AND c.account_id=?",
      )
      .get(randomId, this.accountId) as
      { message_id: string; id: string; conversation_id: string } | undefined;
    if (!job) return;
    this.store.db.transaction(() => {
      this.store.db
        .prepare(
          "DELETE FROM messages WHERE conversation_id=? AND external_id=? AND id!=? AND id NOT IN (SELECT message_id FROM outbox)",
        )
        .run(job.conversation_id, externalId, job.message_id);
      this.store.db
        .prepare(
          "UPDATE messages SET status='sent',external_id=?,error=NULL WHERE id=?",
        )
        .run(externalId, job.message_id);
      this.store.db
        .prepare("UPDATE outbox SET state='sent' WHERE id=?")
        .run(job.id);
    })();
    this.changed();
  }
  private saveState(state: {
    pts: number;
    qts: number;
    date: number;
    seq: number;
  }) {
    this.store.db
      .prepare(
        "INSERT INTO telegram_state VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET state_json=excluded.state_json",
      )
      .run(
        this.accountId,
        JSON.stringify({
          pts: state.pts,
          qts: state.qts,
          date: state.date,
          seq: state.seq,
        }),
      );
  }
  private markInboxRead(peer: string, maxId: number) {
    // A monotonic watermark survives reconnects and prevents history replay
    // from making messages read on another device unread again.
    // Count only messages beyond the watermark, including newer live arrivals.
    const updated = this.store.db
      .prepare(
        `
      UPDATE conversations SET telegram_read_inbox_max_id=?,
        unread=MIN(unread, (SELECT COUNT(*) FROM messages
          WHERE conversation_id=conversations.id AND direction='in'
            AND CAST(external_id AS INTEGER)>?))
      WHERE account_id=? AND external_id=? AND telegram_read_inbox_max_id<?
    `,
      )
      .run(maxId, maxId, this.accountId, peer, maxId);
    if (updated.changes) this.changed();
  }
  private markRead(peer: string, maxId: number) {
    const updated = this.store.db
      .prepare(
        "UPDATE messages SET read_at=? WHERE read_at IS NULL AND direction='out' AND CAST(external_id AS INTEGER)<=? AND conversation_id IN (SELECT id FROM conversations WHERE account_id=? AND external_id=?)",
      )
      .run(new Date().toISOString(), maxId, this.accountId, peer);
    if (updated.changes) this.changed();
  }
  private async difference() {
    let saved = this.store.db
      .prepare("SELECT state_json FROM telegram_state WHERE account_id=?")
      .get(this.accountId) as { state_json: string } | undefined;
    if (!saved) {
      this.saveState(await this.client!.invoke(new Api.updates.GetState()));
      return;
    }
    for (let i = 0; i < 20 && !this.closed; i++) {
      const state = JSON.parse(saved.state_json);
      const result = await this.client!.invoke(
        new Api.updates.GetDifference({
          pts: state.pts,
          qts: state.qts,
          date: state.date,
        }),
      );
      if (result instanceof Api.updates.DifferenceTooLong) {
        this.saveState(await this.client!.invoke(new Api.updates.GetState()));
        this.error =
          "Долгий перерыв: обновлены последние диалоги. Полная история может потребовать отдельной загрузки.";
        return;
      }
      if (result instanceof Api.updates.DifferenceEmpty) {
        this.saveState({ ...state, date: result.date, seq: result.seq });
        return;
      }
      for (const u of result.users) this.rememberUser(u);
      for (const m of result.newMessages) await this.importMessage(m, true);
      for (const update of result.otherUpdates) {
        if (update instanceof Api.UpdateMessageID)
          this.confirm(update.randomId?.toString() ?? "", String(update.id));
        if (
          update instanceof Api.UpdateReadHistoryOutbox &&
          update.peer instanceof Api.PeerUser
        )
          this.markRead(update.peer.userId.toString(), update.maxId);
      }
      for (const update of result.otherUpdates) {
        if (
          update instanceof Api.UpdateReadHistoryInbox &&
          update.peer instanceof Api.PeerUser
        )
          this.markInboxRead(update.peer.userId.toString(), update.maxId);
      }
      const next =
        result instanceof Api.updates.DifferenceSlice
          ? result.intermediateState
          : result.state;
      this.saveState(next);
      saved = { state_json: JSON.stringify(next) };
      if (!(result instanceof Api.updates.DifferenceSlice)) return;
    }
  }
  private async syncConnected() {
    if (!this.authenticated || this.closed)
      throw new Error("Сначала войдите в Telegram.");
    if (this.syncing) return;
    if (Date.now() < this.cooldownUntil)
      throw new Error("Дождитесь завершения ограничения Telegram.");
    this.syncing = true;
    this.changed();
    try {
      const c = this.client!;
      if (!c.connected) await c.connect();
      this.error = null;
      await this.difference();
      let imported = 0;
      // Groups, channels and excluded users must not consume the personal-chat limit.
      for await (const d of c.iterDialogs({})) {
        if (this.closed) return;
        if (d.entity instanceof Api.User && this.rememberUser(d.entity)) {
          this.ensureConversation(d.entity.id.toString());
          if (d.message) await this.importMessage(d.message, false);
          if (d.dialog instanceof Api.Dialog) {
            this.markRead(d.entity.id.toString(), d.dialog.readOutboxMaxId);
            this.markInboxRead(d.entity.id.toString(), d.dialog.readInboxMaxId);
          }
          if (++imported >= RECENT_CHAT_LIMIT) break;
        }
      }
      if (this.closed) return;
      this.store.db
        .prepare("UPDATE accounts SET last_sync=? WHERE id=?")
        .run(new Date().toISOString(), this.accountId);
      this.setState("connected", this.error);
      (c.session as StringSession).save();
    } catch (e) {
      const secs = (e as { seconds?: number }).seconds;
      if (secs) this.cooldownUntil = Date.now() + secs * 1000;
      this.setState("offline", safeTelegramError(e));
      throw e;
    } finally {
      this.syncing = false;
      this.changed();
    }
  }
  async history(id: string) {
    const conv = this.store.conversation(id);
    if (conv.accountId !== this.accountId || !this.authenticated)
      throw new Error("Этот диалог не относится к подключённому Telegram.");
    try {
      const ms = await this.client!.getMessages(this.peer(conv.externalId), {
        limit: 30,
      });
      for (const m of [...ms].reverse()) await this.importMessage(m, false);
      return this.store.messages(id);
    } catch (e) {
      throw new Error(safeTelegramError(e));
    }
  }
  readonly adapter: Adapter = {
    capabilities: {
      text: true,
      images: true,
      files: false,
      voice: false,
      history: true,
      readReceipts: true,
      replyWindowSeconds: null,
      idempotency: true,
    },
    connectionState: (a) => a.state,
    normalizeIncoming: (p) => new DemoAdapter().normalizeIncoming(p),
    loadDialogs: async () => {
      await this.sync();
      return [];
    },
    loadHistory: async (_a, id) => {
      const c = this.store
        .conversations()
        .find((c) => c.accountId === this.accountId && c.externalId === id);
      if (c) await this.history(c.id);
      return [];
    },
    reconnectAndSync: async () => {
      await this.sync();
      return [];
    },
    validateReply: (a, m) => {
      if (
        !this.authenticated ||
        !this.client?.connected ||
        a.state !== "connected"
      )
        throw new SendFailure(
          "Нет подключения к Telegram. Откройте «Аккаунты» и восстановите связь.",
        );
      if ([...m.text].length > 4096)
        throw new SendFailure("Максимум 4096 символов в сообщении Telegram.");
      if (Date.now() < this.cooldownUntil)
        throw new SendFailure(
          "Telegram ограничил частоту запросов.",
          false,
          this.cooldownUntil - Date.now(),
        );
      const c = this.store.conversation(m.conversationId);
      if (c.accountId !== this.accountId)
        throw new SendFailure("Неверный аккаунт отправки.");
      this.peer(c.externalId);
    },
    send: async (a, m, key) => {
      this.adapter.validateReply(a, m);
      const conv = this.store.conversation(m.conversationId),
        random = telegramRandomId(key);
      this.store.db
        .prepare("UPDATE outbox SET provider_random_id=? WHERE message_id=?")
        .run(random, m.id);
      try {
        const target = m.replyToId
          ? this.store
              .messages(m.conversationId)
              .find((x) => x.id === m.replyToId)?.externalId
          : undefined;
        if (m.attachments.length) {
          const id = m.attachments[0].url.split("/").at(-1);
          const upload = this.store.db
            .prepare(
              "SELECT name,bytes FROM uploads WHERE id=? AND conversation_id=?",
            )
            .get(id, m.conversationId) as
            { name: string; bytes: Buffer } | undefined;
          if (!upload) throw new SendFailure("Файл для отправки не найден.");
          try {
            const sent = await this.client!.sendFile(
              this.peer(conv.externalId),
              {
                file: new CustomFile(
                  upload.name,
                  upload.bytes.length,
                  "",
                  upload.bytes,
                ),
                caption: m.text,
                replyTo: target ? Number(target) : undefined,
              },
            );
            return { externalId: String(sent.id) };
          } catch {
            throw new SendFailure(
              "Нет подтверждения отправки изображения. Проверьте Telegram перед повторной отправкой.",
              true,
            );
          }
        }
        const result = await this.client!.invoke(
          new Api.messages.SendMessage({
            peer: this.peer(conv.externalId),
            message: m.text,
            randomId: bigInt(random),
            noWebpage: true,
            replyTo: target
              ? new Api.InputReplyToMessage({ replyToMsgId: Number(target) })
              : undefined,
          }),
        );
        let id: string | undefined;
        if (result instanceof Api.UpdateShortSentMessage)
          id = String(result.id);
        else if (
          result instanceof Api.Updates ||
          result instanceof Api.UpdatesCombined
        ) {
          for (const u of result.updates) {
            if (
              u instanceof Api.UpdateMessageID &&
              u.randomId?.toString() === random
            )
              id = String(u.id);
          }
        }
        if (!id) {
          const saved = this.store.db
            .prepare("SELECT external_id FROM messages WHERE id=?")
            .get(m.id) as { external_id: string | null };
          id = saved.external_id ?? undefined;
        }
        if (!id)
          throw new SendFailure(
            "Telegram не вернул подтверждение. Результат неизвестен; повтор автоматически не выполняется.",
            true,
          );
        return { externalId: id };
      } catch (e) {
        if (e instanceof SendFailure) throw e;
        const err = e as {
          code?: number;
          seconds?: number;
          errorMessage?: string;
        };
        if (err.seconds) {
          this.cooldownUntil = Date.now() + err.seconds * 1000;
          throw new SendFailure(
            safeTelegramError(e),
            false,
            err.seconds * 1000,
          );
        }
        const definitive =
          err.code !== undefined &&
          err.code >= 400 &&
          err.code < 500 &&
          err.errorMessage !== "RANDOM_ID_DUPLICATE";
        throw new SendFailure(safeTelegramError(e), !definitive);
      }
    },
  };
  async close() {
    this.closed = true;
    clearTimeout(this.poll);
    this.nextRecoveryAt = null;
    clearTimeout(this.expiry);
    await this.client?.destroy();
    await Promise.allSettled(this.photos.values());
    await this.recovery?.catch(() => {});
    await this.background?.catch(() => {});
    await this.live.catch(() => {});
  }
}
