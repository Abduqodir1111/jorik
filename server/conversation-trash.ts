import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Store } from "./store.js";

export function registerConversationTrash(app: FastifyInstance, store: Store) {
  const db = store.db;
  const snapshot = (id: string) => {
    const c = store.conversation(id);
    const last = db
      .prepare(
        "SELECT MAX(rowid) AS row,COUNT(*) AS count,MAX(edited_at) AS edited,MAX(deleted_at) AS deleted FROM messages WHERE conversation_id=?",
      )
      .get(id);
    return {
      c,
      version: createHash("sha256")
        .update(
          JSON.stringify([
            id,
            c.deletedAt,
            c.updatedAt,
            c.draftVersion,
            last,
            db
              .prepare(
                "SELECT visibility_version FROM conversations WHERE id=?",
              )
              .get(id),
          ]),
        )
        .digest("hex"),
    };
  };
  const pending = (id: string) =>
    !!db
      .prepare(
        "SELECT 1 FROM outbox WHERE conversation_id=? AND state IN ('queued','sending') UNION ALL SELECT 1 FROM archive_jobs WHERE conversation_id=? AND state='preparing' LIMIT 1",
      )
      .get(id, id);
  app.get<{ Params: { id: string } }>("/api/conversations/:id", async (req) =>
    store.conversation(z.string().uuid().parse(req.params.id)),
  );
  app.get<{ Params: { id: string } }>(
    "/api/conversations/:id/deletion-preview",
    async (req) => {
      const { c, version } = snapshot(z.string().uuid().parse(req.params.id));
      return {
        version,
        pending: pending(c.id),
        hasDraft: !!c.draft,
        deleted: !!c.deletedAt,
      };
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/conversations/:id",
    async (req) => {
      const id = z.string().uuid().parse(req.params.id);
      const expected = req.headers["if-match"];
      if (!expected)
        throw Object.assign(
          new Error("Откройте подтверждение удаления заново."),
          { statusCode: 428 },
        );
      db.transaction(() => {
        const { c, version } = snapshot(id);
        if (expected !== JSON.stringify(version))
          throw Object.assign(
            new Error(
              "Диалог изменился. Закройте подтверждение и проверьте новые сообщения.",
            ),
            { statusCode: 409 },
          );
        if (pending(id))
          throw Object.assign(
            new Error(
              "Дождитесь завершения отправки сообщения или подготовки видео.",
            ),
            { statusCode: 409 },
          );
        if (!c.deletedAt)
          db.prepare(
            "UPDATE conversations SET deleted_at=?,visibility_version=visibility_version+1 WHERE id=?",
          ).run(new Date().toISOString(), id);
        // Do not deliver old queued notifications after a later restoration.
        db.prepare(
          "DELETE FROM push_jobs WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=?)",
        ).run(id);
      })();
      store.changed();
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/conversations/:id/restore",
    async (req) => {
      const id = z.string().uuid().parse(req.params.id);
      store.conversation(id);
      db.prepare(
        "UPDATE conversations SET deleted_at=NULL,visibility_version=visibility_version+1 WHERE id=? AND deleted_at IS NOT NULL",
      ).run(id);
      store.changed();
      return { ok: true };
    },
  );
  app.get("/api/conversations/deleted", async (req) => {
    const { cursor } = z
      .object({ cursor: z.string().max(500).optional() })
      .parse(req.query);
    let after: { at: string; id: string } | undefined;
    if (cursor) {
      try {
        after = z
          .object({ at: z.string().datetime(), id: z.string().uuid() })
          .parse(JSON.parse(Buffer.from(cursor, "base64url").toString()));
      } catch {
        throw Object.assign(
          new Error("Некорректная страница удалённых диалогов."),
          { statusCode: 400 },
        );
      }
    }
    const rows = db
      .prepare(
        "SELECT c.id,c.name,c.username,c.deleted_at AS deletedAt,a.name AS accountName FROM conversations c JOIN accounts a ON a.id=c.account_id WHERE c.deleted_at IS NOT NULL" +
          (after
            ? " AND (c.deleted_at<? OR (c.deleted_at=? AND c.id<?))"
            : "") +
          " ORDER BY c.deleted_at DESC,c.id DESC LIMIT 51",
      )
      .all(...(after ? [after.at, after.at, after.id] : [])) as {
      id: string;
      deletedAt: string;
    }[];
    const conversations = rows.slice(0, 50),
      last = conversations.at(-1);
    return {
      conversations,
      nextCursor:
        rows.length > 50 && last
          ? Buffer.from(
              JSON.stringify({ at: last.deletedAt, id: last.id }),
            ).toString("base64url")
          : null,
    };
  });
}
