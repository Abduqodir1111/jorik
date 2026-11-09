export interface ArchiveEntry {
  id: string;
  name: string;
  type: "folder" | "video";
  source: "Storebooks" | "Mangastore";
}
export interface ArchiveJob {
  id: string;
  state: "preparing" | "queued" | "sending" | "sent" | "error" | "unknown";
  error: string | null;
  messageId: string | null;
}
export interface ArchiveBook {
  id: string;
  title: string;
  author: string;
  formats: { ext: string; downloadPath: string }[];
}
