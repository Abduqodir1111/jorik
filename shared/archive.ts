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
