import { useModalFocus } from "./use-modal-focus";
import { useEffect, useRef, useState } from "react";
import { Trash2, X, RotateCcw } from "lucide-react";
import type { Conversation } from "../shared/types";
import "./conversation-trash.css";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch("/api/conversations" + path, init);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Не удалось изменить диалог");
  return data;
}
export function ConversationActions({
  conversation,
  onClose,
  onDelete,
}: {
  conversation: Conversation;
  onClose: () => void;
  onDelete: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useModalFocus(dialog);
  return (
    <dialog
      ref={dialog}
      className="conversation-trash-dialog conversation-actions"
      aria-label="Действия с диалогом"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2>
        {conversation.username
          ? "@" + conversation.username.replace(/^@/, "")
          : conversation.name}
      </h2>
      <p>Действия с диалогом</p>
      <button
        type="button"
        className="conversation-delete"
        disabled={busy}
        onClick={async () => {
          if (lock.current) return;
          lock.current = true;
          setBusy(true);
          setError("");
          try {
            await onDelete();
          } catch {
            setError("Не удалось сохранить черновики. Повторите попытку.");
          } finally {
            lock.current = false;
            setBusy(false);
          }
        }}
      >
        <Trash2 size={18} /> Удалить диалог
      </button>
      {error && <p role="alert">{error}</p>}
      <button type="button" disabled={busy} onClick={onClose}>
        Отмена
      </button>
    </dialog>
  );
}
export function DeleteConversationDialog({
  conversation,
  onClose,
  onDeleted,
}: {
  conversation: Conversation;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    lock = useRef(false);
  const [preview, setPreview] = useState<{
    version: string;
    pending: boolean;
    hasDraft: boolean;
  }>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useModalFocus(dialog);
  useEffect(() => {
    const controller = new AbortController();
    request<typeof preview>(`/${conversation.id}/deletion-preview`, {
      signal: controller.signal,
    })
      .then(setPreview)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [conversation.id]);
  async function remove() {
    if (!preview || preview.pending || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await request(`/${conversation.id}`, {
        method: "DELETE",
        headers: { "If-Match": JSON.stringify(preview.version) },
      });
      onDeleted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="conversation-trash-dialog"
      aria-labelledby="delete-conversation-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header>
        <h2 id="delete-conversation-title">Удалить диалог из Jorik?</h2>
        <button
          type="button"
          aria-label="Закрыть удаление диалога"
          disabled={busy}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </header>
      <p>
        <strong>
          {conversation.username
            ? "@" + conversation.username.replace(/^@/, "")
            : conversation.name}
        </strong>{" "}
        исчезнет из списка на всех устройствах Jorik.
      </p>
      <p>
        Переписка в Telegram и Instagram, история сообщений и заказы сохранятся.
        Восстановить диалог можно в настройках. Новое входящее сообщение вернёт
        его в список.
      </p>
      {preview?.hasDraft && (
        <p>Черновик также сохранится для восстановления.</p>
      )}
      {preview?.pending && (
        <p role="alert">
          Сейчас идёт отправка сообщения или подготовка видео. Дождитесь её
          завершения и откройте подтверждение заново.
        </p>
      )}
      {!preview && !error && <p role="status">Проверяем диалог…</p>}
      {error && <p role="alert">{error}</p>}
      <footer>
        <button type="button" autoFocus disabled={busy} onClick={onClose}>
          Отмена
        </button>
        <button
          type="button"
          className="conversation-delete"
          disabled={!preview || preview.pending || busy}
          onClick={() => void remove()}
        >
          {busy ? "Удаляем…" : "Удалить из Jorik"}
        </button>
      </footer>
    </dialog>
  );
}
type DeletedConversation = {
  id: string;
  name: string;
  username: string;
  accountName: string;
  deletedAt: string;
};
type Page = { conversations: DeletedConversation[]; nextCursor: string | null };
export default function ConversationTrash() {
  const [open, setOpen] = useState(false),
    [items, setItems] = useState<DeletedConversation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null),
    lock = useRef(false),
    sequence = useRef(0);
  async function load(next?: string) {
    const run = ++sequence.current;
    setBusy(true);
    setError("");
    try {
      const page = await request<Page>(
        "/deleted" + (next ? "?cursor=" + encodeURIComponent(next) : ""),
      );
      if (run !== sequence.current) return;
      setItems((old) =>
        next
          ? [
              ...old,
              ...page.conversations.filter(
                (c) => !old.some((o) => o.id === c.id),
              ),
            ]
          : page.conversations,
      );
      setCursor(page.nextCursor);
    } catch (e) {
      if (run === sequence.current) setError((e as Error).message);
    } finally {
      if (run === sequence.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (open) {
      dialog.current?.showModal();
      void load();
    }
    return () => {
      sequence.current++;
    };
  }, [open]);
  async function restore(id: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await request(`/${id}/restore`, { method: "POST" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="settings-card">
      <h2>Удалённые диалоги</h2>
      <p>Восстановление диалогов, удалённых только из списка Jorik.</p>
      <button
        type="button"
        className="secondary conversation-trash-open"
        onClick={() => setOpen(true)}
      >
        <Trash2 size={16} /> Удалённые диалоги
      </button>
      {open && (
        <dialog
          ref={dialog}
          className="conversation-trash-dialog"
          aria-label="Удалённые диалоги"
          onCancel={(e) => {
            e.preventDefault();
            if (!busy) setOpen(false);
          }}
        >
          <header>
            <h2>Удалённые диалоги</h2>
            <button
              type="button"
              aria-label="Закрыть удалённые диалоги"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              <X size={20} />
            </button>
          </header>
          <p>
            Сообщения и заказы сохранены. Новое входящее сообщение автоматически
            восстановит диалог.
          </p>
          <div className="conversation-trash-list">
            {items.map((c) => (
              <article key={c.id}>
                <div>
                  <strong>
                    {c.username ? "@" + c.username.replace(/^@/, "") : c.name}
                  </strong>
                  <small>
                    {c.accountName} ·{" "}
                    {new Date(c.deletedAt).toLocaleDateString("ru-RU")}
                  </small>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void restore(c.id)}
                  aria-label={`Восстановить диалог ${c.username || c.name}`}
                >
                  <RotateCcw size={16} /> Восстановить
                </button>
              </article>
            ))}
            {!items.length && !busy && !error && <p>Удалённых диалогов нет.</p>}
          </div>
          {error && <p role="alert">{error}</p>}
          {busy && <p role="status">Загрузка…</p>}
          <footer>
            <button type="button" disabled={busy} onClick={() => void load()}>
              Обновить список
            </button>
            {cursor && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void load(cursor)}
              >
                Показать ещё
              </button>
            )}
          </footer>
        </dialog>
      )}
    </section>
  );
}
