import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Download,
  ExternalLink,
  Folder,
  FileText,
  Loader,
  Send,
  Video,
  X,
} from "lucide-react";
import type {
  ArchiveEntry,
  ArchiveFileEntry,
  ArchiveFolderContents,
} from "../shared/archive";

const url = (route: string, id: string, file = "", download = false) =>
  "/api/archive/" +
  route +
  "?" +
  new URLSearchParams({ id, file, ...(download ? { download: "1" } : {}) });
const size = (bytes: number) =>
  bytes >= 1024 * 1024
    ? (bytes / 1024 / 1024).toFixed(1) + " МБ"
    : Math.max(1, Math.ceil(bytes / 1024)) + " КБ";

export default function ArchiveBrowser({
  entry,
  chatName,
  canSend,
  busy,
  sendStatus,
  onSend,
  onClose,
}: {
  entry: ArchiveEntry;
  chatName?: string;
  canSend: boolean;
  busy: boolean;
  sendStatus: string;
  onSend: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [folder, setFolder] = useState("");
  const [contents, setContents] = useState<ArchiveFolderContents | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [media, setMedia] = useState<ArchiveFileEntry | null>(
    entry.type === "video"
      ? {
          name: entry.name,
          type: "video",
          ext: "",
          relativePath: "",
          sizeBytes: 0,
        }
      : null,
  );
  const [mediaError, setMediaError] = useState(false);
  const [pdfState, setPdfState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [pdfError, setPdfError] = useState("");
  const [pdfRetry, setPdfRetry] = useState(0);
  const pdfUrl =
    media?.ext === ".pdf"
      ? url("file", entry.id, media.relativePath) + "&preview=1"
      : "";
  useEffect(() => {
    if (!pdfUrl) return;
    const controller = new AbortController();
    let timedOut = false;
    setPdfState("loading");
    setPdfError("");
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 20000);
    void fetch(pdfUrl, {
      signal: controller.signal,
      headers: { Range: "bytes=0-0" },
      cache: "no-store",
    })
      .then(async (response) => {
        const ok =
          response.ok &&
          (response.headers.get("content-type") || "").startsWith(
            "application/pdf",
          );
        await response.body?.cancel();
        if (!ok)
          throw Error(
            response.status === 503
              ? "Сервер занят. Повторите просмотр."
              : "Не удалось открыть PDF. Попробуйте снова или скачайте файл.",
          );
        if (!controller.signal.aborted) setPdfState("ready");
      })
      .catch((error) => {
        if (!controller.signal.aborted || timedOut) {
          setPdfState("error");
          setPdfError(
            timedOut
              ? "PDF не ответил вовремя. Повторите просмотр."
              : error instanceof Error
                ? error.message
                : "Не удалось открыть PDF",
          );
        }
      })
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [pdfUrl, pdfRetry]);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  useEffect(() => {
    if (entry.type !== "folder") return;
    const controller = new AbortController();
    let disposed = false;
    const timer = setTimeout(
      () => controller.abort(new DOMException("Timeout", "TimeoutError")),
      20000,
    );
    setLoading(true);
    setError("");
    if (!offset) setContents(null);
    void fetch(url("folder-contents", entry.id, folder) + "&offset=" + offset, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (r) => {
        if (!(r.headers.get("content-type") || "").includes("application/json"))
          throw Error("Сервер не отвечает. Повторите открытие папки.");
        const data = await r.json();
        if (!r.ok) throw Error(data.error || "Не удалось прочитать папку");
        return data as ArchiveFolderContents;
      })
      .then((data) => {
        if (!controller.signal.aborted)
          setContents((previous) => ({
            ...data,
            items:
              offset && previous
                ? [...previous.items, ...data.items]
                : data.items,
          }));
      })
      .catch((e) => {
        if (!disposed)
          setError(
            controller.signal.aborted
              ? "Сервер долго отвечает. Попробуйте ещё раз."
              : e.message,
          );
      })
      .finally(() => {
        clearTimeout(timer);
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [entry.id, entry.type, folder, offset, retry]);
  function navigate(next: string) {
    setFolder(next);
    setOffset(0);
    setMedia(null);
    setMediaError(false);
  }
  const preview =
    media ||
    (entry.type === "video"
      ? { name: entry.name, type: "video", relativePath: "" }
      : null);
  return (
    <dialog
      ref={dialog}
      className="archive-browser"
      aria-labelledby="archive-browser-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="archive-browser-card">
        <header>
          <div>
            <small>{entry.source.toUpperCase()}</small>
            <h2 id="archive-browser-title">
              {preview ? preview.name : "Содержимое папки: " + entry.name}
            </h2>
          </div>
          <button aria-label="Закрыть просмотр архива" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <div className="archive-browser-toolbar">
          {entry.type === "folder" && (media || folder) && (
            <button
              onClick={() =>
                media
                  ? (setMedia(null), setMediaError(false))
                  : navigate(folder.split("/").slice(0, -1).join("/"))
              }
            >
              <ArrowLeft size={16} />
              Назад
            </button>
          )}
          <a
            href={"/archive-open.html?id=" + encodeURIComponent(entry.id)}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink size={15} />
            {folder ? "Поделиться исходной папкой" : "Поделиться ссылкой"}
          </a>
        </div>
        <div className="archive-browser-scroll">
          {preview ? (
            <>
              {preview.type === "image" ? (
                <img
                  className="archive-full-image"
                  src={url("file", entry.id, preview.relativePath)}
                  alt={preview.name}
                  onError={() => setMediaError(true)}
                />
              ) : pdfUrl ? (
                <div className="archive-pdf-preview">
                  {pdfState === "loading" && (
                    <p role="status">
                      <Loader size={16} /> Открываем PDF…
                    </p>
                  )}
                  {pdfState === "error" && (
                    <p role="alert" className="archive-browser-error">
                      {pdfError}{" "}
                      <button onClick={() => setPdfRetry((n) => n + 1)}>
                        Повторить просмотр
                      </button>
                    </p>
                  )}
                  {pdfState === "ready" && (
                    <iframe
                      key={pdfUrl}
                      className="archive-pdf-frame"
                      src={pdfUrl + "#toolbar=1&view=FitH"}
                      title={"Предпросмотр PDF: " + preview.name}
                    />
                  )}
                  <p className="archive-browser-note">
                    PDF открывается в просмотрщике браузера. Если документ не
                    отображается, откройте его в новой вкладке.
                  </p>
                  <a href={pdfUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink size={15} /> Открыть PDF в новой вкладке
                  </a>
                </div>
              ) : (
                <video
                  key={entry.id + preview.relativePath}
                  className="archive-player"
                  src={url("file", entry.id, preview.relativePath)}
                  controls
                  autoPlay
                  playsInline
                  preload="metadata"
                  onError={() => setMediaError(true)}
                />
              )}
              {mediaError && (
                <p role="alert" className="archive-browser-error">
                  Не удалось показать файл в браузере. Попробуйте скачать
                  оригинал на устройство.
                </p>
              )}
              {preview.type === "video" && (
                <p className="archive-browser-note">
                  Если исходное видео не воспроизводится в браузере, скачайте
                  оригинал. Просмотр не запускает подготовку видео.
                </p>
              )}
              <div className="archive-browser-toolbar">
                <a href={url("file", entry.id, preview.relativePath, true)}>
                  <Download size={16} />
                  Скачать оригинал
                </a>
                {entry.type === "video" && (
                  <button disabled={!canSend || busy} onClick={onSend}>
                    <Send size={16} />
                    {busy ? "Подготавливаем / отправляем…" : "В чат"}
                  </button>
                )}
              </div>
              {entry.type === "video" && (
                <p role="status" className="archive-browser-note">
                  {sendStatus ||
                    (canSend
                      ? "Отправка в: " + chatName
                      : "Сначала выберите диалог клиента, чтобы отправить видео.")}
                </p>
              )}
            </>
          ) : (
            <>
              <nav className="archive-breadcrumbs" aria-label="Путь в архиве">
                <button disabled={!folder} onClick={() => navigate("")}>
                  {entry.name}
                </button>
                {folder
                  .split("/")
                  .filter(Boolean)
                  .map((part, n, parts) => (
                    <button
                      key={n}
                      onClick={() => navigate(parts.slice(0, n + 1).join("/"))}
                    >
                      {part}
                    </button>
                  ))}
              </nav>
              {error && (
                <p role="alert" className="archive-browser-error">
                  {error}{" "}
                  <button onClick={() => setRetry((n) => n + 1)}>
                    Повторить
                  </button>
                </p>
              )}
              {loading && (
                <p role="status">
                  <Loader size={16} />
                  Загружаем содержимое…
                </p>
              )}
              {contents && (
                <>
                  <div className="archive-folder-list">
                    {contents.items
                      .filter((e) => e.type === "folder")
                      .map((e) => (
                        <button
                          key={e.relativePath}
                          onClick={() => navigate(e.relativePath)}
                        >
                          <Folder size={18} />
                          <span>{e.name}</span>
                        </button>
                      ))}
                  </div>
                  <div className="archive-image-grid">
                    {contents.items
                      .filter((e) => e.type === "image")
                      .map((e) => (
                        <button
                          key={e.relativePath}
                          onClick={() => {
                            setMedia(e);
                            setMediaError(false);
                          }}
                        >
                          <img
                            src={url("thumb", entry.id, e.relativePath)}
                            alt=""
                            loading="lazy"
                            decoding="async"
                          />
                          <span>{e.name}</span>
                        </button>
                      ))}
                  </div>
                  <div className="archive-file-list">
                    {contents.items
                      .filter((e) => e.type !== "image" && e.type !== "folder")
                      .map((e) => (
                        <article key={e.relativePath}>
                          <div>
                            <b>{e.name}</b>
                            <small>
                              {size(e.sizeBytes)} · {e.ext || "файл"}
                            </small>
                          </div>
                          <div className="archive-browser-toolbar">
                            {(e.type === "video" || e.ext === ".pdf") && (
                              <button
                                onClick={() => {
                                  setMedia(e);
                                  setMediaError(false);
                                }}
                              >
                                {e.ext === ".pdf" ? (
                                  <FileText size={15} />
                                ) : (
                                  <Video size={15} />
                                )}
                                Предпросмотр
                              </button>
                            )}
                            <a
                              href={url("file", entry.id, e.relativePath, true)}
                            >
                              <Download size={15} />
                              Скачать
                            </a>
                          </div>
                        </article>
                      ))}
                  </div>
                  {!contents.items.length && (
                    <p>В папке нет доступных файлов.</p>
                  )}
                  <p className="archive-browser-note">
                    Показано: {contents.items.length} из {contents.total}
                  </p>
                  {contents.nextOffset !== null && (
                    <button
                      disabled={loading}
                      onClick={() => setOffset(contents.nextOffset!)}
                    >
                      Показать ещё
                    </button>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}
