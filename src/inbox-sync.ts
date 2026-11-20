import {
  applyInboxSync,
  type InboxState,
  type InboxSync,
} from "../shared/inbox-sync";
export class InboxSyncClient {
  private snapshot?: { version: string; state: InboxState };
  private generation = 0;
  constructor(private fetch: (url: string) => Promise<InboxSync>) {}
  reset() {
    this.generation++;
    this.snapshot = undefined;
  }
  async read() {
    const generation = this.generation;
    const update = await this.fetch(
      "/inbox-sync" + (this.snapshot ? "?since=" + this.snapshot.version : ""),
    );
    if (generation !== this.generation)
      throw new Error("Сессия обновления завершена");
    let next = applyInboxSync(this.snapshot, update);
    if (!next) {
      const full = await this.fetch("/inbox-sync");
      if (generation !== this.generation)
        throw new Error("Сессия обновления завершена");
      next = applyInboxSync(undefined, full);
    }
    if (!next) throw new Error("Не удалось синхронизировать список диалогов");
    this.snapshot = next;
    return next.state;
  }
}
