import type { Account, Capabilities, Message } from "../shared/types.js";
export interface IncomingEvent {
  externalConversationId: string;
  externalMessageId: string;
  name: string;
  username: string;
  text: string;
}
export class SendFailure extends Error {
  constructor(
    message: string,
    public ambiguous = false,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}
export interface Adapter {
  capabilities: Capabilities;
  connectionState(account: Account): Account["state"];
  normalizeIncoming(payload: unknown): IncomingEvent;
  loadDialogs(account: Account): Promise<IncomingEvent[]>;
  loadHistory(
    account: Account,
    externalConversationId: string,
  ): Promise<IncomingEvent[]>;
  send(
    account: Account,
    message: Message,
    idempotencyKey: string,
  ): Promise<{ externalId: string }>;
  validateReply(account: Account, message: Message): void;
  reconnectAndSync(account: Account): Promise<IncomingEvent[]>;
  handleWebhook?(
    rawBody: Buffer,
    headers: Record<string, string>,
  ): Promise<IncomingEvent[]>;
}
const none: Capabilities = {
  text: false,
  images: false,
  files: false,
  voice: false,
  history: false,
  readReceipts: false,
  replyWindowSeconds: null,
  idempotency: false,
};
export class DemoAdapter implements Adapter {
  capabilities = { ...none, text: true, history: true, idempotency: true };
  connectionState(a: Account) {
    return a.state;
  }
  normalizeIncoming(payload: unknown) {
    const p = payload as IncomingEvent;
    if (
      !p.externalConversationId ||
      !p.externalMessageId ||
      typeof p.text !== "string"
    )
      throw new Error("Некорректное событие");
    return p;
  }
  async loadDialogs() {
    return [];
  }
  async loadHistory() {
    return [];
  }
  async reconnectAndSync() {
    return [];
  }
  validateReply(a: Account) {
    if (a.state !== "connected")
      throw new SendFailure(
        "Подключение недоступно. Восстановите его в разделе «Аккаунты».",
      );
  }
  async send(a: Account, m: Message, key: string) {
    this.validateReply(a);
    if (m.text.includes("[ошибка]"))
      throw new SendFailure("Демо: провайдер отклонил сообщение.");
    if (m.text.includes("[неизвестно]"))
      throw new SendFailure(
        "Демо: подтверждение потеряно. Результат отправки неизвестен.",
        true,
      );
    if (m.text.includes("[лимит]"))
      throw new SendFailure(
        "Демо: ограничение частоты. Повторите без маркера [лимит].",
      );
    return { externalId: `demo:${a.id}:${key}` };
  }
}
export class UnconfiguredAdapter implements Adapter {
  capabilities = none;
  connectionState() {
    return "unconfigured" as const;
  }
  normalizeIncoming(): IncomingEvent {
    throw new Error("API не настроен");
  }
  async loadDialogs(): Promise<IncomingEvent[]> {
    throw new Error("API не настроен");
  }
  async loadHistory(): Promise<IncomingEvent[]> {
    throw new Error("API не настроен");
  }
  async reconnectAndSync(): Promise<IncomingEvent[]> {
    throw new Error("API не настроен");
  }
  validateReply() {
    throw new SendFailure("Аккаунт не настроен. Выберите и подключите API.");
  }
  async send(): Promise<{ externalId: string }> {
    throw new SendFailure("API не настроен");
  }
}
export const adapterFor = (a: { mode: string }): Adapter =>
  a.mode === "demo" ? new DemoAdapter() : new UnconfiguredAdapter();
