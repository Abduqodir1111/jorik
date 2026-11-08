import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pencil, Reply, Trash2, Copy } from "lucide-react";
import type { Account, Message } from "../shared/types";
export default function MessageActions({
  message: m,
  platform,
  x,
  y,
  onClose,
  onReply,
  onEdit,
  onReact,
  onDelete,
}: {
  message: Message;
  platform: Account["platform"];
  x: number;
  y: number;
  onClose: () => void;
  onReply: (m: Message) => void;
  onEdit: (m: Message) => void;
  onReact: (m: Message, emoji: string | null) => Promise<void>;
  onDelete: (m: Message) => Promise<void>;
}) {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const menu = useRef<HTMLDivElement>(null),
    lock = useRef(false);
  const [position, setPosition] = useState({ x, y }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const canAct =
    platform === "telegram" && !!m.externalId && m.status === "sent";
  const canOwn = canAct && m.direction === "out";
  useLayoutEffect(() => {
    const r = menu.current!.getBoundingClientRect();
    setPosition({
      x: Math.max(8, Math.min(x, innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(y, innerHeight - r.height - 8)),
    });
    if (matchMedia("(pointer:fine)").matches)
      menu.current?.focus({ preventScroll: true });
  }, [x, y]);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node)) onClose();
    };
    const close = () => onClose();
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [onClose]);
  async function perform(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
      if (mounted.current) onClose();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Не удалось выполнить действие",
      );
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return createPortal(
    <div
      ref={menu}
      className="message-context-menu"
      style={{ left: position.x, top: position.y }}
      role="menu"
      aria-label="Действия с сообщением"
      tabIndex={-1}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === "Escape" || e.key === "Tab") {
          if (e.key === "Escape") e.preventDefault();
          onClose();
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const buttons = [
            ...menu.current!.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)",
            ),
          ];
          const index = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          buttons[
            (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) %
              buttons.length
          ]?.focus();
        }
      }}
    >
      {canAct && (
        <div
          className="message-context-reactions"
          role="group"
          aria-label="Реакции"
        >
          {["👍", "❤️", "🔥", "😂", "👏"].map((emoji) => (
            <button
              key={emoji}
              disabled={busy}
              aria-label={`Реакция ${emoji}`}
              aria-pressed={
                m.reactions?.some((r) => r.emoji === emoji && r.chosen) || false
              }
              onClick={() =>
                void perform(() =>
                  onReact(
                    m,
                    m.reactions?.some((r) => r.emoji === emoji && r.chosen)
                      ? null
                      : emoji,
                  ),
                )
              }
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
      {m.externalId && (
        <button
          role="menuitem"
          disabled={busy}
          onClick={() => {
            onClose();
            onReply(m);
          }}
        >
          <Reply size={16} />
          Ответить
        </button>
      )}
      {m.text && (
        <button
          role="menuitem"
          disabled={busy}
          onClick={() =>
            void perform(() => navigator.clipboard.writeText(m.text))
          }
        >
          <Copy size={16} />
          Скопировать текст
        </button>
      )}
      {canOwn && !m.attachments.length && (
        <button
          role="menuitem"
          disabled={busy}
          onClick={() => {
            onClose();
            onEdit(m);
          }}
        >
          <Pencil size={16} />
          Редактировать
        </button>
      )}
      {canOwn && (
        <button
          role="menuitem"
          className="destructive"
          disabled={busy}
          onClick={() => void perform(() => onDelete(m))}
        >
          <Trash2 size={16} />
          Удалить у всех
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </div>,
    document.body,
  );
}
