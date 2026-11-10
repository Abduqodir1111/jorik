import type { ArchiveJob } from "../shared/archive";
import type { Message } from "../shared/types";
export function mergeArchiveJobs(old: ArchiveJob[], incoming: ArchiveJob[]) {
  const next = [...old];
  for (const job of incoming) {
    const i = next.findIndex(
      (j) =>
        j.id === job.id || (job.clientKey && j.clientKey === job.clientKey),
    );
    if (i < 0) next.push(job);
    else if (
      (next[i].local && !job.local) ||
      (Boolean(job.local) === Boolean(next[i].local) &&
        (job.updatedAt ?? 0) >= (next[i].updatedAt ?? 0))
    )
      next[i] = job;
  }
  return next
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .slice(0, 50);
}
export function archiveTimeline(
  messages: Message[],
  jobs: ArchiveJob[],
  conversation: string | null,
): Message[] {
  const relevant = jobs.filter((j) => j.conversationId === conversation);
  const byMessage = new Map(
    relevant.filter((j) => j.messageId).map((j) => [j.messageId, j]),
  );
  const result = messages.map((m) => {
    const job = byMessage.get(m.id);
    if (!job) return m;
    // A confirmed send is terminal even if a progress event/snapshot was missed.
    if (m.status === "sent" || job.state === "sent")
      return {
        ...m,
        status: "sent" as const,
        archiveJob: {
          ...job,
          state: "sent" as const,
          phase: "complete" as const,
          percent: 100,
        },
      };
    if (m.status === "error" || m.status === "unknown")
      return {
        ...m,
        archiveJob: {
          ...job,
          state: m.status,
          phase: m.status,
          percent: null,
          error: m.error || job.error,
        },
      };
    return { ...m, archiveJob: job };
  });
  for (const job of relevant) {
    if (job.messageId && messages.some((m) => m.id === job.messageId)) continue;
    result.push({
      id: job.messageId || "archive-" + job.id,
      conversationId: conversation!,
      externalId: null,
      direction: "out",
      text: "",
      status: job.state === "preparing" ? "queued" : job.state,
      createdAt: new Date(job.createdAt ?? Date.now()).toISOString(),
      error: job.error,
      attachments: [
        {
          kind: "video",
          url: job.local ? "" : "/api/archive/video/" + job.id,
          name: job.name || "Видеообзор",
          mime: "video/mp4",
          size: job.totalBytes ?? 0,
        },
      ],
      archiveJob: job,
    });
  }
  return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
