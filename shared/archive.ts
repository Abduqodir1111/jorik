export interface ArchiveEntry {
  id: string;
  name: string;
  type: "folder" | "video";
  source: "Storebooks" | "Mangastore";
}
export interface ArchiveFileEntry {
  name: string;
  ext: string;
  type: "folder" | "image" | "video" | "book" | "other";
  sizeBytes: number;
  relativePath: string;
}
export interface ArchiveFolderContents {
  items: ArchiveFileEntry[];
  total: number;
  nextOffset: number | null;
}
export interface ArchiveJob {
  conversationId?: string;
  entryId?: string;
  clientKey?: string;
  name?: string;
  createdAt?: number;
  updatedAt?: number;
  phase?: ArchivePhase;
  percent?: number | null;
  bytesSent?: number;
  totalBytes?: number | null;
  local?: boolean;
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

export type ArchivePhase =
  | "waiting"
  | "preparing"
  | "queued"
  | "uploading"
  | "confirming"
  | "complete"
  | "error"
  | "unknown";
export interface ArchiveProgress {
  phase: ArchivePhase;
  percent: number | null;
  bytesSent?: number;
  totalBytes?: number | null;
}
