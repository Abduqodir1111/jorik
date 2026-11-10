import type { Store } from "./store.js";
import type { ArchiveJob, ArchiveProgress } from "../shared/archive.js";
export function archiveProgress(store: Store) {
  const select = `SELECT j.*,m.status AS message_status,m.error AS message_error FROM archive_jobs j LEFT JOIN messages m ON m.id=j.message_id`;
  function decode(r: any): ArchiveJob {
    const state = r.message_status || r.state;
    return {
      id: r.id,
      clientKey: r.idempotency_key,
      conversationId: r.conversation_id,
      entryId: r.entry_id,
      name: r.name || "Видеообзор",
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      state,
      messageId: r.message_id,
      error: r.message_error || r.error,
      phase:
        state === "sent"
          ? "complete"
          : state === "error"
            ? "error"
            : state === "unknown"
              ? "unknown"
              : r.phase,
      percent: state === "sent" ? 100 : r.percent,
      bytesSent: r.bytes_sent,
      totalBytes: r.total_bytes,
    };
  }
  const get = (id: string) => {
    const r = store.db.prepare(select + " WHERE j.id=?").get(id);
    if (!r)
      throw Object.assign(new Error("Задача не найдена"), { statusCode: 404 });
    return decode(r);
  };
  let lastId = "",
    lastAt = 0,
    lastPhase = "",
    lastPercent: number | null = null;
  function update(id: string, p: ArchiveProgress, force = false) {
    try {
      const percent =
        p.percent === null
          ? null
          : Math.max(0, Math.min(100, Math.floor(p.percent)));
      if (
        !force &&
        lastId === id &&
        lastPhase === p.phase &&
        Date.now() - lastAt < 750
      )
        return;
      if (
        !force &&
        lastId === id &&
        lastPhase === p.phase &&
        lastPercent === percent &&
        p.phase !== "uploading"
      )
        return;
      store.db
        .prepare(
          "UPDATE archive_jobs SET phase=?,percent=?,bytes_sent=COALESCE(?,bytes_sent),total_bytes=COALESCE(?,total_bytes),updated_at=MAX(updated_at+1,?) WHERE id=?",
        )
        .run(
          p.phase,
          percent,
          p.bytesSent ?? null,
          p.totalBytes ?? null,
          Date.now(),
          id,
        );
      lastId = id;
      lastAt = Date.now();
      lastPhase = p.phase;
      lastPercent = percent;
      store.archiveJobChanged(get(id));
    } catch {
      console.warn("Archive progress unavailable");
    }
  }
  store.reportArchiveProgress = (mid, p) => {
    try {
      const r = store.db
        .prepare("SELECT id FROM archive_jobs WHERE message_id=?")
        .get(mid) as { id: string } | undefined;
      if (r)
        update(
          r.id,
          p,
          ["queued", "complete", "confirming", "error", "unknown"].includes(
            p.phase,
          ),
        );
    } catch {
      console.warn("Archive progress unavailable");
    }
  };

  return {
    get,
    update,
    list: () =>
      (
        store.db
          .prepare(
            select +
              " WHERE (j.name!='' OR j.state='preparing' OR m.status IN ('queued','sending')) AND (m.status IS NULL OR m.status!='sent' OR j.created_at>?) ORDER BY j.created_at DESC LIMIT 50",
          )
          .all(Date.now() - 86400000) as any[]
      ).map(decode),
  };
}
