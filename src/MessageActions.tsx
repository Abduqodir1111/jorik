import { useState, useRef } from "react";
import { Pencil, Smile } from "lucide-react";
import type { Message } from "../shared/types";
export default function MessageActions({
  message: m,
  onEdit,
  onReact,
}: {
  message: Message;
  onEdit: (m: Message) => void;
  onReact: (m: Message, emoji: string | null) => Promise<void>;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const locked = useRef(false);
  async function react(emoji: string) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      await onReact(
        m,
        m.reactions?.some((r) => r.emoji === emoji && r.chosen) ? null : emoji,
      );
      setOpen(false);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="message-actions">
      {m.direction === "out" &&
        m.status === "sent" &&
        !m.attachments.length && (
          <button
            title="Редактировать"
            aria-label="Редактировать сообщение"
            onClick={() => onEdit(m)}
          >
            <Pencil size={15} />
          </button>
        )}
      <button
        title="Реакция"
        aria-label="Выбрать реакцию"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Smile size={16} />
      </button>
      {open && (
        <div className="reaction-picker" role="group" aria-label="Реакции">
          {["👍", "❤️", "🔥", "👏"].map((e) => (
            <button
              disabled={busy}
              key={e}
              aria-label={`Реакция ${e}`}
              aria-pressed={
                m.reactions?.some((r) => r.emoji === e && r.chosen) || false
              }
              onClick={() => void react(e)}
            >
              {e}
            </button>
          ))}
          <button onClick={() => setOpen(false)} aria-label="Закрыть реакции">
            ×
          </button>
        </div>
      )}
    </div>
  );
}
