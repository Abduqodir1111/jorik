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
  fullPage,
  conversationId,
  chatName,
}: {
  fullPage: boolean;
  conversationId?: string;
  chatName?: string;
}) {
  const [open, setOpen] = useState(false),
    [q, setQ] = useState(""),
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
  const active = fullPage || open;
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
        .then(setEntries)
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
  }, [q, active]);
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
  async function link(id: string) {
    const win = window.open("about:blank", "_blank");
    if (!win) {
      setError("Разрешите открытие новой вкладки для Jorik.");
      return;
    }
    win.opener = null;
    try {
      const { url } = await request<{ url: string }>("/link", { id });
      const u = new URL(url);
      if (!["https:", "http:"].includes(u.protocol))
        throw new Error("Недопустимая ссылка");
      win.location.href = u.href;
    } catch (e) {
      win.close();
      setError(e instanceof Error ? e.message : "Не удалось открыть ссылку");
    }
  }
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
  async function findBooks() {
    if (q.trim().length < 2) return;
    setBookQuery(q.trim());
    setLoading(true);
    setError("");
    try {
      setBooks(
        await request<ArchiveBook[]>(
          "/flibusta/search?q=" + encodeURIComponent(q.trim()),
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Каталог недоступен");
    } finally {
      setLoading(false);
    }
  }
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
    <section
      className={
        "archive-search " +
        (fullPage ? "archive-page" : "archive-widget") +
        (open ? " is-open" : "")
      }
      aria-label="Поиск по архиву"
    >
      {!fullPage && !open ? (
        <button className="archive-launch" onClick={() => setOpen(true)}>
          <Search size={18} />
          Поиск по архиву
        </button>
      ) : (
        <>
          <header>
            <div>
              <b>Поиск по архиву</b>
              <small>Книги, манга и видеообзоры</small>
            </div>
            {!fullPage && (
              <button aria-label="Закрыть поиск" onClick={() => setOpen(false)}>
                <X size={18} />
              </button>
            )}
          </header>
          <label className="archive-input">
            <Search size={18} />
            <input
              aria-label="Название в архиве"
              placeholder="Название книги или обзора…"
              value={q}
              onChange={(e) => {
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
          <div className="archive-results" aria-busy={loading}>
            {loading && (
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
                  <button onClick={() => void link(e.id)}>
                    <ExternalLink size={14} />
                    {e.type === "folder" ? "Открыть" : "Предпросмотр"}
                  </button>
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
                disabled={loading}
                onClick={() => void findBooks()}
              >
                Найти во Флибусте
              </button>
            )}
            {bookQuery === q.trim() &&
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
                          setFormats((s) => ({ ...s, [b.id]: e.target.value }))
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
              bookQuery === q.trim() &&
              !books.length &&
              bookQuery && (
                <p className="archive-hint">
                  Каталог не вернул книг с доступными форматами.
                </p>
              )}
          </div>
        </>
      )}
    </section>
  );
}
