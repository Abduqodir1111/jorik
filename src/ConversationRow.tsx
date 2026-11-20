import StoreBadge from "./StoreBadge";
import { memo } from "react";
import type { Account, Conversation } from "../shared/types";
import Avatar from "./Avatar";
import PlatformIcon from "./PlatformIcon";
import { time } from "./message-format";
import { useChatLongPress } from "./use-chat-long-press";
export default memo(function ConversationRow({
  conversation: c,
  account: a,
  index,
  selected,
  draft,
  onSelect,
  onOpenMenu,
}: {
  conversation: Conversation;
  account: Account;
  index: number;
  selected: boolean;
  draft: string;
  onSelect: (id: string) => void;
  onOpenMenu: (conversation: Conversation) => void;
}) {
  const { consumeClick, ...hold } = useChatLongPress(() => onOpenMenu(c));
  return (
    <button
      {...hold}
      className={
        "conversation " +
        (selected ? "selected " : "") +
        (c.unread > 0 ? "is-unread" : "")
      }
      key={c.id}
      onClick={(e) => {
        if (consumeClick()) {
          e.preventDefault();
          return;
        }
        onSelect(c.id);
      }}
    >
      <div className="conversation-avatar">
        <Avatar name={c.name} index={index} conversationId={c.id} />
        <span className={"avatar-platform " + a.platform}>
          <PlatformIcon platform={a.platform} />
        </span>
      </div>
      <div className="conversation-text">
        <div className="conversation-title">
          <div className="contact-line">
            <StoreBadge name={a.name} color={a.color} />
            <b>{c.username ? "@" + c.username.replace(/^@/, "") : c.name}</b>
          </div>
          <time>{time(c.updatedAt)}</time>
        </div>
        {c.stage && (
          <span className={"stage-badge stage-" + c.stage}>
            {{ new: "Новый", paid: "Оплачен", waiting: "Ждёт" }[c.stage]}
          </span>
        )}
        <div className="preview">
          <span>
            {draft ? (
              <>
                <em>Черновик: </em>
                {draft}
              </>
            ) : (
              c.preview
            )}
          </span>
          {c.unread > 0 && <b className="unread">{c.unread}</b>}
        </div>
      </div>
    </button>
  );
});
