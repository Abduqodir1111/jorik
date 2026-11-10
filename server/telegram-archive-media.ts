import { Api, type TelegramClient } from "teleproto";
import bigInt from "big-integer";
import type { DB } from "./db.js";
import type { PreparedVideo } from "./archive-video.js";
import type { ArchiveProgress } from "../shared/archive.js";
import { SendFailure } from "./adapters.js";
import { uploadArchiveTelegram } from "./archive-telegram-upload.js";

type Cached = Omit<PreparedVideo, "file"> & {
  document_id: string;
  access_hash: string;
  file_reference: Buffer;
  peer_id: string;
  message_id: number;
};
function identity(db: DB, account: string) {
  return (
    db
      .prepare("SELECT user_id FROM telegram_sessions WHERE account_id=?")
      .get(account) as { user_id: string | null } | undefined
  )?.user_id;
}
export function cachedTelegramArchiveMedia(
  db: DB,
  account: string,
  key: string,
) {
  const user = identity(db, account);
  if (!user) return undefined;
  return db
    .prepare(
      "SELECT * FROM telegram_archive_media WHERE account_id=? AND user_id=? AND source_key=?",
    )
    .get(account, user, key) as Cached | undefined;
}
const referenceError = (e: unknown) =>
  /^(FILE_REFERENCE_(EXPIRED|INVALID|EMPTY)|FILE_REFERENCE_\d+_EXPIRED|DOCUMENT_INVALID)$/.test(
    (e as { errorMessage?: string })?.errorMessage || "",
  );
function videoDocument(message: unknown) {
  const m = message as { media?: unknown } | undefined;
  const doc =
    m?.media instanceof Api.MessageMediaDocument ? m.media.document : undefined;
  return doc instanceof Api.Document &&
    doc.mimeType === "video/mp4" &&
    !(m?.media as Api.MessageMediaDocument).ttlSeconds &&
    doc.attributes.some((a) => a instanceof Api.DocumentAttributeVideo)
    ? doc
    : undefined;
}
export async function sendTelegramArchive(options: {
  db: DB;
  client: Pick<TelegramClient, "invoke" | "getMessages">;
  account: string;
  peerId: string;
  peer: (id: string) => Api.InputPeerUser;
  random: string;
  messageId: string;
  archive: PreparedVideo & { source_key: string | null; entry_id: string };
  prepare?: (
    entryId: string,
    expectedKey?: string | null,
  ) => Promise<PreparedVideo>;
  progress: (p: ArchiveProgress) => void;
}) {
  const {
    db,
    client,
    account,
    peerId,
    peer,
    random,
    messageId,
    archive,
    progress,
  } = options;
  const user = identity(db, account),
    key = archive.source_key;
  let cached = key ? cachedTelegramArchiveMedia(db, account, key) : undefined;
  const invalidate = () => {
    if (key && user)
      db.prepare(
        "DELETE FROM telegram_archive_media WHERE account_id=? AND user_id=? AND source_key=?",
      ).run(account, user, key);
  };
  // Cache writes must never turn an acknowledged message into a failed send.
  const remember = (
    doc: Api.Document | undefined,
    id: number,
    v: PreparedVideo,
    sourcePeer = peerId,
  ) => {
    if (
      !doc ||
      !key ||
      !user ||
      !doc.accessHash ||
      !doc.fileReference?.length ||
      Number(doc.size) !== v.size
    )
      return;
    try {
      db.prepare(
        `INSERT INTO telegram_archive_media(account_id,user_id,source_key,document_id,access_hash,file_reference,peer_id,message_id,size,duration,width,height,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,user_id,source_key) DO UPDATE SET
        document_id=excluded.document_id,access_hash=excluded.access_hash,file_reference=excluded.file_reference,
        peer_id=excluded.peer_id,message_id=excluded.message_id,size=excluded.size,duration=excluded.duration,
        width=excluded.width,height=excluded.height,updated_at=excluded.updated_at`,
      ).run(
        account,
        user,
        key,
        doc.id.toString(),
        doc.accessHash.toString(),
        doc.fileReference,
        sourcePeer,
        id,
        v.size,
        v.duration,
        v.width,
        v.height,
        Date.now(),
      );
    } catch {
      console.warn("Telegram media cache unavailable");
    }
  };
  // Lazy adoption of a previously confirmed archive send. Never scan/download
  // videos in the background, and never adopt another account's message.
  if (!cached && key && user) {
    const previous = db
      .prepare(
        `SELECT m.external_id,c.external_id AS peer_id FROM archive_jobs j
      JOIN messages m ON m.id=j.message_id JOIN conversations c ON c.id=m.conversation_id
      WHERE c.account_id=? AND m.status='sent' AND m.deleted_at IS NULL AND m.external_id IS NOT NULL
      AND j.file=? AND (j.source_key=? OR j.source_key IS NULL) AND m.id!=?
      ORDER BY j.created_at DESC LIMIT 1`,
      )
      .get(account, archive.file, key, messageId) as
      { external_id: string; peer_id: string } | undefined;
    if (previous) {
      try {
        const doc = videoDocument(
          (
            await client.getMessages(peer(previous.peer_id), {
              ids: [Number(previous.external_id)],
            })
          )[0],
        );
        remember(doc, Number(previous.external_id), archive, previous.peer_id);
        cached = cachedTelegramArchiveMedia(db, account, key);
      } catch {
        /* Optional optimization; no send has occurred yet. */
      }
    }
  }
  const send = async (media: Api.TypeInputMedia, v: PreparedVideo) => {
    try {
      const result = await client.invoke(
        new Api.messages.SendMedia({
          peer: peer(peerId),
          randomId: bigInt(random),
          message: "",
          media,
        }),
      );
      let id: number | undefined, doc: Api.Document | undefined;
      if (result instanceof Api.UpdateShortSentMessage) {
        id = result.id;
        doc = videoDocument(result);
      } else if (
        result instanceof Api.Updates ||
        result instanceof Api.UpdatesCombined
      ) {
        id = result.updates.find(
          (u): u is Api.UpdateMessageID =>
            u instanceof Api.UpdateMessageID &&
            u.randomId?.toString() === random,
        )?.id;
        if (id) {
          const u = result.updates.find(
            (u) => u instanceof Api.UpdateNewMessage && u.message.id === id,
          );
          if (u instanceof Api.UpdateNewMessage) doc = videoDocument(u.message);
        }
      }
      if (!id) {
        const confirmed = db
          .prepare("SELECT external_id FROM messages WHERE id=?")
          .get(messageId) as { external_id: string | null };
        if (confirmed?.external_id) id = Number(confirmed.external_id);
      }
      if (!id) throw new Error("No confirmation");
      // Some MTProto responses contain only a short acknowledgement. Fetch only
      // this acknowledged message; failure disables caching, never resends it.
      if (!doc && key && user) {
        try {
          doc = videoDocument(
            (await client.getMessages(peer(peerId), { ids: [id] }))[0],
          );
        } catch {
          /* The send itself is already confirmed. */
        }
      }
      remember(doc, id, v);
      return { externalId: String(id) };
    } catch (e) {
      if (referenceError(e)) throw e; // Explicit rejection: safe to refresh/fallback.
      const err = e as { seconds?: number; errorMessage?: string };
      if (
        err.seconds &&
        /^(FLOOD_WAIT|SLOWMODE_WAIT)/.test(err.errorMessage || "")
      )
        throw new SendFailure(
          "Telegram просит подождать перед отправкой видео.",
          false,
          err.seconds * 1000,
        );
      throw new SendFailure(
        "Нет подтверждения отправки видео. Проверьте Telegram перед повтором.",
        true,
      );
    }
  };
  const sendDocument = (doc: { id: string; hash: string; reference: Buffer }) =>
    send(
      new Api.InputMediaDocument({
        id: new Api.InputDocument({
          id: bigInt(doc.id),
          accessHash: bigInt(doc.hash),
          fileReference: doc.reference,
        }),
      }),
      archive,
    );
  if (cached) {
    progress({ phase: "reusing", percent: null });
    try {
      return await sendDocument({
        id: cached.document_id,
        hash: cached.access_hash,
        reference: cached.file_reference,
      });
    } catch (e) {
      if (!referenceError(e)) throw e;
    }
    // Refresh an expired reference exactly once, without downloading the video.
    let refreshed: Api.Document | undefined;
    try {
      refreshed = videoDocument(
        (
          await client.getMessages(peer(cached.peer_id), {
            ids: [cached.message_id],
          })
        )[0],
      );
    } catch {
      // No send occurred during this read. A normal upload is still safe after
      // the preceding explicit rejection, even when the source was deleted.
    }
    if (
      refreshed &&
      refreshed.id.toString() === cached.document_id &&
      refreshed.accessHash &&
      refreshed.fileReference.length
    ) {
      try {
        return await sendDocument({
          id: refreshed.id.toString(),
          hash: refreshed.accessHash.toString(),
          reference: refreshed.fileReference,
        });
      } catch (e) {
        if (!referenceError(e)) throw e;
      }
    }
    invalidate();
  }
  let v = archive;
  let uploaded: Api.InputFile | Api.InputFileBig;
  try {
    // A remote cache hit may have skipped preparation even if local cache was
    // evicted. Prepare lazily ONLY after Telegram explicitly rejects reuse.
    if (options.prepare && key) {
      progress({ phase: "preparing", percent: null });
      v = { ...archive, ...(await options.prepare(archive.entry_id, key)) };
      db.prepare(
        "UPDATE archive_jobs SET file=?,size=?,duration=?,width=?,height=? WHERE message_id=?",
      ).run(v.file, v.size, v.duration, v.width, v.height, messageId);
    }
    progress({
      phase: "uploading",
      percent: 0,
      bytesSent: 0,
      totalBytes: v.size,
    });
    uploaded = await uploadArchiveTelegram(
      client,
      v.file,
      v.size,
      (bytes, total) =>
        progress({
          phase: "uploading",
          percent: Math.floor((bytes / total) * 100),
          bytesSent: bytes,
          totalBytes: total,
        }),
    );
  } catch {
    throw new SendFailure(
      "Не удалось загрузить видео в Telegram. Сообщение не отправлено.",
    );
  }
  progress({ phase: "confirming", percent: null });
  try {
    return await send(
      new Api.InputMediaUploadedDocument({
        file: uploaded,
        mimeType: "video/mp4",
        attributes: [
          new Api.DocumentAttributeFilename({ fileName: "review.mp4" }),
          new Api.DocumentAttributeVideo({
            duration: v.duration,
            w: v.width,
            h: v.height,
            supportsStreaming: true,
          }),
        ],
      }),
      v,
    );
  } catch (e) {
    if (referenceError(e))
      throw new SendFailure(
        "Telegram отклонил видео. Сообщение не отправлено.",
      );
    throw e;
  }
}
