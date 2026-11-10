import { useEffect, useRef, useState, type RefObject } from "react";
import type { ArchiveFolderContents } from "../shared/archive";
export function pdfPagesLabel(pages: number) {
  const last = pages % 10,
    teen = pages % 100;
  return `${pages} ${teen >= 11 && teen <= 14 ? "страниц" : last === 1 ? "страница" : last >= 2 && last <= 4 ? "страницы" : "страниц"}`;
}
type Metadata = { pages: number | null; error?: string };
export function useArchivePdfPages(
  id: string,
  contents: ArchiveFolderContents | null,
  active: boolean,
  dialog: RefObject<HTMLDialogElement | null>,
) {
  const known = useRef<Record<string, Metadata>>({});
  const [pages, setPages] = useState<Record<string, Metadata>>({}),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!active || !contents) return;
    const controller = new AbortController();
    let stopped = false,
      running = false;
    const queue: string[] = [],
      queued = new Set<string>();
    async function load(file: string) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const request = new AbortController(),
          abort = () => request.abort();
        controller.signal.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(() => request.abort(), 12000);
        try {
          const r = await fetch(
            "/api/archive/pdf-info?" + new URLSearchParams({ id, file }),
            { signal: request.signal, cache: "no-store" },
          );
          const data = await r.json();
          if (r.status === 503 && attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
            if (stopped) return null;
            continue;
          }
          if (!r.ok)
            throw Error(data.error || "Не удалось определить страницы");
          if (
            data.pages !== null &&
            (!Number.isSafeInteger(data.pages) || data.pages <= 0)
          )
            throw Error("Некорректные данные PDF");
          return { pages: data.pages } as Metadata;
        } catch (error) {
          return {
            pages: null,
            error:
              error instanceof Error ? error.message : "Страницы недоступны",
          };
        } finally {
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", abort);
        }
      }
      return null;
    }
    async function pump() {
      if (running || stopped) return;
      running = true;
      try {
        while (queue.length && !stopped) {
          const file = queue.shift()!;
          const result = await load(file);
          if (stopped) return;
          if (result) {
            known.current[file] = result;
            setPages((s) => ({ ...s, [file]: result }));
          }
        }
      } finally {
        running = false;
      }
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries)
          if (e.isIntersecting) {
            const file = (e.target as HTMLElement).dataset.pdfFile;
            if (file && !known.current[file] && !queued.has(file)) {
              queued.add(file);
              queue.push(file);
            }
            observer.unobserve(e.target);
          }
        void pump();
      },
      {
        root: dialog.current?.querySelector(".archive-browser-scroll"),
        rootMargin: "100px",
      },
    );
    dialog.current
      ?.querySelectorAll("[data-pdf-file]")
      .forEach((el) => observer.observe(el));
    return () => {
      stopped = true;
      controller.abort();
      observer.disconnect();
    };
  }, [id, contents, active, dialog, retry]);
  return {
    pages,
    retry: (file: string) => {
      delete known.current[file];
      setPages((s) => {
        const next = { ...s };
        delete next[file];
        return next;
      });
      setRetry((n) => n + 1);
    },
  };
}
