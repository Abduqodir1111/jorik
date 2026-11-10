import { useEffect, useRef, useState } from "react";
import {
  Search,
  X,
  Folder,
  Video,
  ExternalLink,
  Send,
  RefreshCw,
  Download,
  Loader,
} from "lucide-react";
import type { ArchiveEntry, ArchiveJob, ArchiveBook } from "../shared/archive";
import "./archive-search.css";
import ArchiveBrowser from "./ArchiveBrowser";
import {
  archiveContainsTitle,
  normalizeArchiveQuery,
} from "../shared/archive-query";
async function request<T>(
  url: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const r = await fetch("/api/archive" + url, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "Не удалось выполнить запрос");
  return d;
}
export default function ArchiveSearch({
  open,
  onClose,
  conversationId,
  chatName,
}: {
  open: boolean;
  onClose: () => void;
  conversationId?: string;
  chatName?: string;
}) {
  const [q, setQ] = useState(""),
    [entries, setEntries] = useState<ArchiveEntry[]>([]),
    [books, setBooks] = useState<ArchiveBook[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const [status, setStatus] = useState<{
    indexing: boolean;
    updatedAt: string | null;
    error: string | null;
    count: number;
    enabled: boolean;
  } | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const catalogRequest = useRef<AbortController | null>(null);
  const currentQuery = useRef(q);
  currentQuery.current = q;
  const [bookQuery, setBookQuery] = useState(""),
    [formats, setFormats] = useState<Record<string, string>>({});
  const [job, setJob] = useState<ArchiveJob | null>(null),
    [sending, setSending] = useState(false),
    [target, setTarget] = useState("");
  const pending = useRef<{
      entry: string;
      conversation: string;
      key: string;
    } | null>(null),
    lock = useRef(false);
  const active = open;
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [closing, setClosing] = useState(false);
  const [preview, setPreview] = useState<ArchiveEntry | null>(null);
  useEffect(() => {
    const element = dialog.current;
    if (open) {
      setClosing(false);
      if (!element?.open) element?.showModal();
      input.current?.focus({ preventScroll: true });
    } else {
      element?.close();
      setPreview(null);
      setClosing(false);
    }
    return () => {
      element?.close();
    };
  }, [open]);
  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(onClose, 180);
    return () => clearTimeout(timer);
  }, [closing, onClose]);
  function close() {
    if (open && !closing) setClosing(true);
  }

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const load = () =>
      request<typeof status>("/status", undefined, controller.signal)
        .then(setStatus)
        .catch(() => {});
    void load();
    const timer = setInterval(() => void load(), 10000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [active]);
  useEffect(() => {
    catalogRequest.current?.abort();
    catalogRequest.current = null;
    setCatalogLoading(false);
    setCatalogError("");
    setBookQuery("");
    if (!active) return;
    const controller = new AbortController();
    setError("");
    setBooks([]);
    setEntries([]);
    if (q.trim().length < 2) {
      setLoading(false);
      return () => controller.abort();
    }
    setLoading(true);
    const timer = setTimeout(() => {
      void request<ArchiveEntry[]>(
        "/search?q=" + encodeURIComponent(q.trim()),
        undefined,
        controller.signal,
      )
        .then(async (matches) => {
          if (controller.signal.aborted) return;
          setEntries(matches);
          if (status?.updatedAt && !archiveContainsTitle(matches, q)) {
            await new Promise((resolve) => setTimeout(resolve, 400));
            if (!controller.signal.aborted) void findBooks(q);
          }
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, active, status?.updatedAt]);
  useEffect(() => {
    if (!job || !["preparing", "queued", "sending"].includes(job.state)) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void request<ArchiveJob>("/jobs/" + job.id, undefined, controller.signal)
        .then(setJob)
        .catch(() => {});
    }, 2000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [job?.id, job?.state]);
  async function send(entry: ArchiveEntry) {
    if (!conversationId || lock.current) return;
    lock.current = true;
    setSending(true);
    setError("");
    setTarget(chatName || "Выбранный диалог");
    const old = pending.current;
    const intent =
      old?.entry === entry.id && old.conversation === conversationId
        ? old
        : {
            entry: entry.id,
            conversation: conversationId,
            key: crypto.randomUUID(),
          };
    pending.current = intent;
    try {
      setJob(
        await request<ArchiveJob>("/send-video", {
          id: intent.entry,
          conversationId: intent.conversation,
          idempotencyKey: intent.key,
        }),
      );
      pending.current = null;
    } catch (e) {
      setError(
        (e instanceof Error ? e.message : "Ошибка отправки") +
          " При повторе этого действия новая отправка не создаётся.",
      );
    } finally {
      lock.current = false;
      setSending(false);
    }
  }
  async function findBooks(query = q) {
    const clean = normalizeArchiveQuery(query);
    if (clean.length < 2 || catalogRequest.current) return;
    const controller = new AbortController();
    catalogRequest.current = controller;
    setBookQuery("");
    setBooks([]);
    setCatalogLoading(true);
    setCatalogError("");
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 30000);
    const current = () =>
      catalogRequest.current === controller &&
      normalizeArchiveQuery(currentQuery.current) === clean;
    try {
      const result = await request<ArchiveBook[]>(
        "/flibusta/search?q=" + encodeURIComponent(clean),
        undefined,
        controller.signal,
      );
      if (current() && !controller.signal.aborted) {
        setBooks(result);
        setBookQuery(clean);
      }
    } catch (e) {
      if (current() && (!controller.signal.aborted || timedOut))
        setCatalogError(
          timedOut
            ? "Каталог не ответил вовремя. Повторите поиск."
            : e instanceof Error
              ? e.message
              : "Каталог недоступен. Повторите поиск.",
        );
    } finally {
      clearTimeout(timer);
      if (current()) {
        catalogRequest.current = null;
        setCatalogLoading(false);
      }
    }
  }
  useEffect(() => () => catalogRequest.current?.abort(), []);
  const busy =
    sending ||
    (!!job && ["preparing", "queued", "sending"].includes(job.state));
  const labels = {
    preparing: "Подготавливаем видео",
    queued: "В очереди отправки",
    sending: "Отправляем",
    sent: "Видео отправлено",
    error: "Не удалось отправить",
    unknown: "Результат неизвестен — проверьте чат у провайдера",
  };
  return (
    <>
      <dialog
        ref={dialog}
        id="archive-search-drawer"
        className={"archive-drawer" + (closing ? " is-closing" : "")}
        aria-label="Поиск по архиву"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const rect = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            close();
        }}
      >
        <section
          className="archive-search archive-drawer-content"
          aria-label="Поиск по архиву"
        >
          <header>
            <div>
              <b>Поиск по архиву</b>
              <small>Книги, манга и видеообзоры</small>
            </div>
            <button aria-label="Закрыть поиск" onClick={close}>
              <X size={18} />
            </button>
          </header>
          <label className="archive-input">
            <Search size={18} />
            <input
              ref={input}
              aria-label="Название в архиве"
              placeholder="Название книги или обзора…"
              value={q}
              onChange={(e) => {
                catalogRequest.current?.abort();
                catalogRequest.current = null;
                setCatalogLoading(false);
                setCatalogError("");
                setQ(e.target.value);
                setBookQuery("");
              }}
            />
          </label>
          <div className="archive-status">
            {status?.indexing
              ? "Обновляем индекс…"
              : status?.error ||
                (!status?.enabled
                  ? "Архив не подключён"
                  : status.updatedAt
                    ? `В архиве: ${status.count}`
                    : "Подготавливаем индекс…")}
            <button
              title="Обновить индекс"
              aria-label="Обновить индекс"
              disabled={!status?.enabled || status.indexing}
              onClick={() =>
                void request("/reindex", {})
                  .then(() =>
                    setStatus((s) => (s ? { ...s, indexing: true } : s)),
                  )
                  .catch((e) => setError(e.message))
              }
            >
              <RefreshCw size={14} />
            </button>
          </div>
          {conversationId && (
            <small className="archive-target">Отправка в: {chatName}</small>
          )}
          {error && (
            <p className="archive-error" role="alert">
              {error}
            </p>
          )}
          {job && (
            <p className={"archive-job " + job.state} role="status">
              {labels[job.state]} · {target}
              {job.error && <small>{job.error}</small>}
            </p>
          )}
          <div
            className="archive-results"
            aria-busy={loading || catalogLoading}
          >
            {(loading || catalogLoading) && (
              <p className="archive-hint">
                <Loader size={16} /> Ищем…
              </p>
            )}
            {entries.map((e) => (
              <article key={e.id}>
                <div className="archive-entry-title">
                  {e.type === "folder" ? (
                    <Folder size={18} />
                  ) : (
                    <Video size={18} />
                  )}
                  <b>
                    {e.type === "video"
                      ? e.name.replace(/\.(mp4|mov)$/i, "")
                      : e.name}
                  </b>
                </div>
                <span className={"archive-source " + e.source.toLowerCase()}>
                  {e.source.toUpperCase()}
                </span>
                <div className="archive-actions">
                  <button onClick={() => setPreview(e)}>
                    {e.type === "folder" ? (
                      <Folder size={14} />
                    ) : (
                      <Video size={14} />
                    )}
                    {e.type === "folder" ? "Открыть" : "Предпросмотр"}
                  </button>
                  <a
                    href={"/archive-open.html?id=" + encodeURIComponent(e.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink size={14} />
                    Поделиться ссылкой
                  </a>
                  {e.type === "video" && (
                    <button
                      disabled={!conversationId || busy}
                      onClick={() => void send(e)}
                    >
                      <Send size={14} />В чат
                    </button>
                  )}
                </div>
              </article>
            ))}
            {!loading && q.trim().length >= 2 && !entries.length && (
              <p className="archive-hint">В локальном архиве совпадений нет.</p>
            )}
            {q.trim().length >= 2 && (
              <button
                className="archive-catalog"
                disabled={catalogLoading}
                onClick={() => void findBooks()}
              >
                {catalogError
                  ? "Повторить поиск во Флибусте"
                  : "Найти во Флибусте"}
              </button>
            )}
            {catalogError && (
              <p className="archive-error" role="alert">
                {catalogError}
              </p>
            )}
            {bookQuery === normalizeArchiveQuery(q) &&
              books.map((b, i) => {
                const format =
                  b.formats.find((f) => f.downloadPath === formats[b.id]) ||
                  b.formats[0];
                return (
                  <article key={b.id + ":" + i}>
                    <b>{b.title}</b>
                    <small>{b.author}</small>
                    <div className="archive-actions">
                      <select
                        aria-label={"Формат: " + b.title}
                        value={format.downloadPath}
                        onChange={(e) =>
                          setFormats((s) => ({
                            ...s,
                            [b.id]: e.target.value,
                          }))
                        }
                      >
                        {b.formats.map((f) => (
                          <option key={f.downloadPath} value={f.downloadPath}>
                            {f.ext.toUpperCase()}
                          </option>
                        ))}
                      </select>
                      <a
                        href={
                          "/api/archive/flibusta/download?path=" +
                          encodeURIComponent(format.downloadPath) +
                          "&title=" +
                          encodeURIComponent(b.author + " - " + b.title)
                        }
                      >
                        <Download size={14} /> Скачать
                      </a>
                    </div>
                  </article>
                );
              })}
            {!loading &&
              bookQuery === normalizeArchiveQuery(q) &&
              !books.length &&
              bookQuery && (
                <p className="archive-hint">
                  Каталог не вернул книг с доступными форматами.
                </p>
              )}
          </div>
        </section>
      </dialog>
      {preview && (
        <ArchiveBrowser
          key={preview.id}
          entry={preview}
          chatName={chatName}
          canSend={!!conversationId}
          busy={busy}
          sendStatus={
            job
              ? labels[job.state] +
                " · " +
                target +
                (job.error ? ": " + job.error : "")
              : ""
          }
          onSend={() => void send(preview)}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}
