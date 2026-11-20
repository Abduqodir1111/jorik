import type { Account, Conversation, Mode } from "./types.js";
export interface InboxState {
  mode: Mode;
  localAccess: boolean;
  quickRepliesVersion: string;
  accounts: Account[];
  conversations: Conversation[];
  settings: Record<string, string>;
}
export type InboxSync =
  | { kind: "full"; version: string; state: InboxState }
  | {
      kind: "delta";
      baseVersion: string;
      version: string;
      upsert: Conversation[];
      removed: string[];
      metadata?: Omit<InboxState, "conversations">;
    };

export function applyInboxSync(
  previous: { version: string; state: InboxState } | undefined,
  update: InboxSync,
) {
  if (update.kind === "full")
    return { version: update.version, state: update.state };
  if (!previous || previous.version !== update.baseVersion) return undefined;
  if (!update.upsert.length && !update.removed.length && !update.metadata)
    return { version: update.version, state: previous.state };
  const rows = new Map(previous.state.conversations.map((c) => [c.id, c]));
  for (const id of update.removed) rows.delete(id);
  for (const c of update.upsert) rows.set(c.id, c);
  const conversations = [...rows.values()].sort(
    (a, b) =>
      b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
  );
  return {
    version: update.version,
    state: { ...previous.state, ...update.metadata, conversations },
  };
}
