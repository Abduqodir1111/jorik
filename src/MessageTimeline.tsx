import React, {
  memo,
  useMemo,
  type Dispatch,
  type SetStateAction,
} from "react";
import { AlertCircle, Check, CheckCheck, Reply, X } from "lucide-react";
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
}: {
  messages: Message[];
  platform: Account["platform"];
  dismissed: Record<string, boolean>;
  setDismissed: Dispatch<SetStateAction<Record<string, boolean>>>;
  onReply: (message: Message) => void;
}) {
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
              className={
                "bubble " +
                (m.status === "error" || m.status === "unknown" ? "failed" : "")
              }
            >
              {m.replyToId && (
                <blockquote className="message-quote">
                  {messagesById.get(m.replyToId)?.text || "Ответ на сообщение"}
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
                <p>{m.text}</p>
              )}
              {m.attachments.map((att, j) => (
                <div key={j}>
                  {att.kind === "image" ? (
                    <Photo attachment={att} />
                  ) : att.kind === "video" ? (
                    <Video attachment={att} />
                  ) : att.kind === "voice" ? (
                    <audio controls preload="none" src={att.url} />
                  ) : (
                    <a href={att.url} download>
                      {att.name} · {Math.max(1, Math.ceil(att.size / 1024))} КБ
                    </a>
                  )}
                </div>
              ))}
              <div className="message-meta">
                <time>{time(m.createdAt)}</time>
                {m.direction === "out" && (
                  <>
                    <span>{m.readAt ? "Прочитано" : labels[m.status]}</span>
                    {m.status === "sent" &&
                      (m.readAt ? (
                        <CheckCheck
                          size={14}
                          className="read-check"
                          aria-label="Прочитано клиентом"
                        />
                      ) : (
                        <Check size={14} aria-label="Отправлено" />
                      ))}
                  </>
                )}
              </div>
              {m.externalId && (
                <button
                  className="reply-action"
                  aria-label="Ответить на сообщение"
                  title="Ответить"
                  onClick={() => {
                    onReply(m);
                  }}
                >
                  <Reply size={16} />
                </button>
              )}
              {m.error && <p className="message-error">{m.error}</p>}
            </div>
          </div>
        </React.Fragment>
      ))}
    </>
  );
});
