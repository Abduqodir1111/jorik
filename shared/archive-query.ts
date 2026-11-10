import type { ArchiveEntry } from "./archive.js";

export function normalizeArchiveQuery(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

// Fuzzy suggestions must not hide the external catalog for a missing title.
export function archiveContainsTitle(entries: ArchiveEntry[], query: string) {
  const title = normalizeArchiveQuery(query).toLocaleLowerCase("ru");
  return (
    !!title &&
    entries.some(
      (entry) =>
        entry.type === "folder" &&
        normalizeArchiveQuery(entry.name)
          .toLocaleLowerCase("ru")
          .includes(title),
    )
  );
}
