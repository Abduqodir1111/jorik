export type DraftWrite = { text: string; version: number; key: string };
export type DraftSnapshot = { text: string; version: number };
/** Server revisions, never device clocks. Keep conflicting text until explicit resolution. */
export class DraftSync {
  readonly pending = new Map<string, DraftWrite>();
  readonly conflicts = new Map<string, DraftSnapshot>();
  private versions = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();
  constructor(
    private save: (
      id: string,
      value: DraftWrite,
    ) => Promise<{ version: number }>,
  ) {}
  hydrate(id: string, version: number) {
    if (this.pending.has(id) || version < (this.versions.get(id) ?? 0))
      return false;
    this.versions.set(id, version);
    return true;
  }
  edit(id: string, text: string) {
    this.pending.set(id, {
      text,
      version: this.pending.get(id)?.version ?? this.versions.get(id) ?? 0,
      key: crypto.randomUUID(),
    });
  }
  flush() {
    const run = async () => {
      while (this.pending.size) {
        const [id, value] = this.pending.entries().next().value!;
        if (this.conflicts.has(id))
          throw new Error(
            "Выберите вариант конфликтующего черновика перед отправкой.",
          );
        try {
          const result = await this.save(id, value);
          this.versions.set(id, result.version);
          const latest = this.pending.get(id);
          if (latest?.key === value.key) this.pending.delete(id);
          else if (latest) latest.version = result.version;
        } catch (error) {
          const conflict = (error as { currentDraft?: DraftSnapshot })
            .currentDraft;
          if (conflict) this.conflicts.set(id, conflict);
          throw error;
        }
      }
    };
    const result = this.chain.catch(() => {}).then(run);
    this.chain = result;
    return result;
  }
  resolve(id: string, keepLocal: boolean) {
    const remote = this.conflicts.get(id);
    if (!remote) return;
    this.versions.set(id, remote.version);
    this.conflicts.delete(id);
    if (keepLocal) {
      const local = this.pending.get(id);
      if (local)
        this.pending.set(id, {
          ...local,
          version: remote.version,
          key: crypto.randomUUID(),
        });
    } else this.pending.delete(id);
    return remote;
  }
}
