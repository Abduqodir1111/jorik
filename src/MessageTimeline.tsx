import VoicePlayer from "./VoicePlayer";
import LocationCard from "./LocationCard";
import StickerRenderer from "./StickerRenderer";
import MessageActions from "./MessageActions";
import React, {
  memo,
  useMemo,
  useState,
  useRef,
  useEffect,
  useCallback,
  type Dispatch,
  type SetStateAction,
} from "react";
import { AlertCircle, Clock, Check, CheckCheck, X } from "lucide-react";
import type { Account, Message } from "../shared/types";
import Photo from "./Photo";
import Video from "./Video";
import { date, time } from "./message-format";
const labels = {
  queued: "В очереди",
  sending: "Отправляется",
  sent: "Отправлено",
  error: "Ошибка",
  unknown: "Результат неизвестен",
};
export default memo(function MessageTimeline({
  messages,
  platform,
  dismissed,
  setDismissed,
  onReply,
  onEdit,
  onReact,
  onDelete,
}: {
  messages: Message[];
  platform: Account["platform"];
  dismissed: Record<string, boolean>;
  setDismissed: Dispatch<SetStateAction<Record<string, boolean>>>;
  onDelete: (message: Message) => Promise<void>;
  onReply: (message: Message) => void;
  onEdit: (message: Message) => void;
  onReact: (message: Message, emoji: string | null) => Promise<void>;
}) {
  const [context, setContext] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const closeContext = useCallback(() => setContext(null), []);
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const suppressClick = useRef(false);
  const cancelPress = () => {
    if (longPress.current) clearTimeout(longPress.current);
    longPress.current = null;
  };
  useEffect(() => () => cancelPress(), []);
  const activeMessage = context
    ? messages.find((m) => m.id === context.id)
    : undefined;
  useEffect(() => {
    setContext(null);
  }, [messages[0]?.conversationId]);
  const messagesById = useMemo(
    () => new Map(messages.map((m) => [m.id, m])),
    [messages],
  );
  const days = useMemo(
    () => messages.map((m) => date(m.createdAt)),
    [messages],
  );
  return (
    <>
      {messages.map((m, i) => (
        <React.Fragment key={m.id}>
          {(i === 0 || days[i - 1] !== days[i]) && (
            <div className="date-separator">
              <span>{days[i]}</span>
            </div>
          )}
          <div className={"message-row " + m.direction}>
            <div
              tabIndex={0}
              onPointerDown={(e) => {
                suppressClick.current = false;
                if (e.pointerType !== "touch") return;
                cancelPress();
                origin.current = { x: e.clientX, y: e.clientY };
                const { clientX: x, clientY: y } = e;
                longPress.current = setTimeout(() => {
                  suppressClick.current = true;
                  setContext({ id: m.id, x, y });
                }, 500);
              }}
              onPointerUp={cancelPress}
              onPointerCancel={cancelPress}
              onPointerMove={(e) => {
                if (
                  Math.hypot(
                    e.clientX - origin.current.x,
                    e.clientY - origin.current.y,
                  ) > 8
                )
                  cancelPress();
              }}
              onClickCapture={(e) => {
                if (suppressClick.current) {
                  e.preventDefault();
                  e.stopPropagation();
                  suppressClick.current = false;
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                cancelPress();
                setContext({ id: m.id, x: e.clientX, y: e.clientY });
              }}
              onKeyDown={(e) => {
                if (
                  e.key === "ContextMenu" ||
                  (e.shiftKey && e.key === "F10")
                ) {
                  e.preventDefault();
                  const r = e.currentTarget.getBoundingClientRect();
                  setContext({ id: m.id, x: r.left + 10, y: r.top + 10 });
                }
              }}
              className={
                "bubble " +
                (m.attachments.some((a) => a.kind === "sticker")
                  ? "sticker-bubble "
                  : "") +
                (m.attachments.length === 0 &&
                !m.error &&
                !m.text.startsWith("[Вложение Instagram")
                  ? "text-only "
                  : "") +
                (m.status === "error" || m.status === "unknown" ? "failed" : "")
              }
            >
              {(m.reply_to || m.replyToId) && (
                <blockquote
                  className="message-quote"
                  aria-label="Цитата сообщения"
                >
                  <strong>
                    {m.reply_to?.sender_name || "Ответ на сообщение"}
                  </strong>
                  <span
                    title={
                      m.reply_to?.text ||
                      (m.replyToId && messagesById.get(m.replyToId)?.text) ||
                      "Исходное сообщение недоступно"
                    }
                  >
                    {m.reply_to?.text ||
                      (m.replyToId && messagesById.get(m.replyToId)?.text) ||
                      "Исходное сообщение недоступно"}
                  </span>
                </blockquote>
              )}
              {platform === "instagram" &&
              m.text.startsWith("[Вложение Instagram") &&
              m.attachments.length === 0 ? (
                <div className="unavailable-instagram">
                  {dismissed[m.id] ? (
                    <button
                      onClick={() =>
                        setDismissed((old) => ({
                          ...old,
                          [m.id]: false,
                        }))
                      }
                    >
                      Вложение недоступно · Подробнее
                    </button>
                  ) : (
                    <>
                      <AlertCircle size={16} />
                      <span>Instagram не передал вложение.</span>
                      <a
                        href="https://www.instagram.com/direct/inbox/"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Открыть ↗
                      </a>
                      <button
                        aria-label="Скрыть уведомление о вложении"
                        onClick={() =>
                          setDismissed((old) => ({
                            ...old,
                            [m.id]: true,
                          }))
                        }
                      >
                        <X size={14} />
                      </button>
                    </>
                  )}
                </div>
              ) : (
                !m.attachments.some(
                  (a) =>
                    ["sticker", "voice", "location"].includes(a.kind) &&
                    a.name === m.text,
                ) && <p>{m.text}</p>
              )}
              {m.attachments.map((att, j) => (
                <div key={j}>
                  {att.kind === "sticker" ? (
                    <StickerRenderer attachment={att} />
                  ) : att.kind === "location" ? (
                    <LocationCard attachment={att} />
                  ) : att.kind === "image" ? (
                    <Photo attachment={att} />
                  ) : att.kind === "video" ? (
                    <Video attachment={att} />
                  ) : att.kind === "voice" ? (
                    <VoicePlayer attachment={att} />
                  ) : (
                    <div className="document-attachment">
                      <strong>
                        {att.mime === "application/pdf" ? "PDF" : "EPUB"} ·{" "}
                        {att.name}
                      </strong>
                      <span>{Math.max(1, Math.ceil(att.size / 1024))} КБ</span>
                      <div>
                        {att.mime === "application/pdf" && (
                          <a
                            href={att.url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Открыть PDF
                          </a>
                        )}
                        <a
                          href={`${att.url}${att.url.includes("?") ? "&" : "?"}download=1`}
                          download={att.name}
                        >
                          Скачать
                        </a>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {!!m.reactions?.length && (
                <div className="message-reactions">
                  {m.reactions.map((r) => (
                    <span key={r.emoji} className={r.chosen ? "chosen" : ""}>
                      {r.emoji} {r.count}
                    </span>
                  ))}
                </div>
              )}
              {m.error && <p className="message-error">{m.error}</p>}
              <span className="message-meta">
                {m.editedAt && <small>изменено</small>}
                <time>{time(m.createdAt)}</time>
                {m.direction === "out" && (
                  <>
                    {m.status !== "sent" &&
                      (m.status === "queued" || m.status === "sending" ? (
                        <Clock
                          size={13}
                          aria-label={labels[m.status]}
                          role="img"
                        />
                      ) : (
                        <AlertCircle
                          size={13}
                          aria-label={labels[m.status]}
                          role="img"
                        />
                      ))}
                    {m.status === "sent" &&
                      (m.readAt ? (
                        <CheckCheck
                          size={14}
                          className="read-check"
                          aria-label="Прочитано клиентом"
                          role="img"
                        />
                      ) : (
                        <Check size={14} aria-label="Отправлено" role="img" />
                      ))}
                  </>
                )}
              </span>
            </div>
          </div>
        </React.Fragment>
      ))}
      {context && activeMessage && (
        <MessageActions
          key={context.id}
          message={activeMessage}
          platform={platform}
          x={context.x}
          y={context.y}
          onClose={closeContext}
          onReply={onReply}
          onEdit={onEdit}
          onReact={onReact}
          onDelete={onDelete}
        />
      )}
    </>
  );
});
