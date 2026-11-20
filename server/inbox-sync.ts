import { createHash } from "node:crypto";
import type { InboxState, InboxSync } from "../shared/inbox-sync.js";

type Snapshot = {
  version: string;
  state: InboxState;
  json: string;
  metadata: string;
  rows: Map<string, string>;
};
// Shared by operators; no per-session copies. Retain up to four prior versions,
// with an aggregate serialized limit of 4 MiB. Slow/disconnected clients
// safely fall back to a full list.
export class InboxSnapshots {
  private current?: Snapshot;
  private previous = new Map<string, Snapshot>();
  private previousBytes = 0;
  private loadedAt = -Infinity;
  private loadedEpoch = -1;
  constructor(
    private load: () => InboxState,
    private now = Date.now,
  ) {}
  read(since: string | undefined, epoch: number): InboxSync {
    if (
      !this.current ||
      this.loadedEpoch !== epoch ||
      this.now() - this.loadedAt >= 500
    ) {
      const state = this.load(),
        json = JSON.stringify(state);
      if (json !== this.current?.json) {
        if (this.current && !this.previous.has(this.current.version)) {
          this.previous.set(this.current.version, this.current);
          this.previousBytes += Buffer.byteLength(this.current.json);
          while (
            this.previous.size > 4 ||
            this.previousBytes > 4 * 1024 * 1024
          ) {
            const oldest = this.previous.keys().next().value!;
            this.previousBytes -= Buffer.byteLength(
              this.previous.get(oldest)!.json,
            );
            this.previous.delete(oldest);
          }
        }
        const { conversations, ...metadata } = state;
        this.current = {
          state,
          json,
          version: createHash("sha256").update(json).digest("hex"),
          metadata: JSON.stringify(metadata),
          rows: new Map(conversations.map((c) => [c.id, JSON.stringify(c)])),
        };
      }
      this.loadedAt = this.now();
      this.loadedEpoch = epoch;
    }
    const current = this.current!;
    const base =
      since === current.version
        ? current
        : since
          ? this.previous.get(since)
          : undefined;
    if (!base)
      return { kind: "full", version: current.version, state: current.state };
    return {
      kind: "delta",
      baseVersion: base.version,
      version: current.version,
      upsert: current.state.conversations.filter(
        (c) => base.rows.get(c.id) !== current.rows.get(c.id),
      ),
      removed: base.state.conversations
        .filter((c) => !current.rows.has(c.id))
        .map((c) => c.id),
      ...(base.metadata !== current.metadata
        ? { metadata: (({ conversations, ...rest }) => rest)(current.state) }
        : {}),
    };
  }
}
