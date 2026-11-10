const ArchiveSearch = lazy(() => import("./ArchiveSearch"));
import { quickReplyHotkey, nextTemplateIndex } from "../shared/quick-replies";
const SettingsView = lazy(() => import("./SettingsView"));
import LogoutDialog from "./LogoutDialog";
import StoreBadge from "./StoreBadge";
import type { OrderContext } from "./Orders";
const Orders = lazy(() => import("./Orders"));
import { useNotificationSound } from "./NotificationSound";
import { useOperator } from "./OperatorContext";
import { ChatCache } from "./chat-cache";
import PlatformIcon from "./PlatformIcon";
import AccountName from "./AccountName";
import { recentConversations } from "../shared/inbox";
import { instagramReplyWindow } from "../shared/instagram-reply-window";
import TelegramConnect from "./TelegramConnect";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import Avatar from "./Avatar";
import ConversationRow from "./ConversationRow";
import MessageTimeline from "./MessageTimeline";
import { time, date } from "./message-format";
import { coalesceAsync } from "./refresh-queue";
import {
  Check,
  Package,
  MessageSquare,
  Send,
  Search,
  Settings,
  ArrowLeft,
  Info,
  Plus,
  Reply,
  Moon,
  Sun,
  Zap,
  Upload,
  AlertCircle,
  WifiOff,
  X,
  Paperclip,
  Mail,
  Eye,
  EyeOff,
} from "lucide-react";
import type { Account, Conversation, Message, Mode } from "../shared/types";
async function api<T = any>(
  url: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const r = await fetch("/api" + url, {
    method,
    signal,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? "Ошибка сервера");
  return data;
}
export default function App() {
  const { slots, hydrate, dark, toggleTheme } = useOperator();
  const [orderContext, setOrderContext] = useState<OrderContext | undefined>();
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [orderRequest, setOrderRequest] = useState(0);
  const [orderCloseRequest, setOrderCloseRequest] = useState(0);
  const [clockNow, setClockNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setClockNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);
  const [orderPanelOpen, setOrderPanelOpen] = useState(false);
  const [replyTargets, setReplyTargets] = useState<
    Record<string, Message | undefined>
  >({});
  const [uploads, setUploads] = useState<
    Record<string, { id: string; name: string } | undefined>
  >({});
  const [uploading, setUploading] = useState(false),
    [dragging, setDragging] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false),
    [templateIndex, setTemplateIndex] = useState(0);
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});
  const inputRef = useRef<HTMLTextAreaElement>(null),
    fileInput = useRef<HTMLInputElement>(null);
  const [composerFocused, setComposerFocused] = useState(false);
  const [composerViewport, setComposerViewport] = useState<{
    height: number;
    top: number;
  }>();
  useEffect(() => {
    if (!composerFocused) return;
    const viewport = window.visualViewport;
    const update = () =>
      setComposerViewport({
        height: viewport?.height ?? window.innerHeight,
        top: viewport?.offsetTop ?? 0,
      });
    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [composerFocused]);

  const [auth, setAuth] = useState(false),
    [configured, setConfigured] = useState(true),
    [mode, setMode] = useState<Mode>("demo"),
    [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showAllChats, setShowAllChats] = useState(false);
  const [rememberLogin, setRememberLogin] = useState(true);
  const [accountsExpanded, setAccountsExpanded] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const closeArchive = useCallback(() => setArchiveOpen(false), []);
  useEffect(() => {
    if (!auth) setArchiveOpen(false);
  }, [auth]);
  const [accounts, setAccounts] = useState<Account[]>([]),
    [conversations, setConversations] = useState<Conversation[]>([]),
    [messages, setMessages] = useState<Message[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [page, setPage] = useState("inbox");
  useEffect(() => {
    setComposerFocused(
      Boolean(
        auth &&
        page === "inbox" &&
        selected &&
        inputRef.current &&
        document.activeElement === inputRef.current,
      ),
    );
  }, [auth, page, selected]);
  const [filter, setFilter] = useState("all"),
    [q, setQ] = useState(""),
    [searchIds, setSearchIds] = useState<string[]>([]),
    [unread, setUnread] = useState(false),
    [info, setInfo] = useState(false),
    [online, setOnline] = useState(true),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [sending, setSending] = useState(false),
    [ownerName, setOwnerName] = useState("Владелец");
  const [visibleChats, setVisibleChats] = useState(100);
  useEffect(() => setVisibleChats(100), [q, filter, unread, showAllChats]);
  const [drafts, setDrafts] = useState<Record<string, string>>({}),
    [draftState, setDraftState] = useState(""),
    [historyLoading, setHistoryLoading] = useState(false);
  const draftChain = useRef(Promise.resolve()),
    sendLock = useRef(false),
    pending = useRef<{ id: string; text: string; key: string } | null>(null),
    selectedRef = useRef(selected),
    bottom = useRef<HTMLDivElement>(null);
  const chatCache = useRef<ChatCache | null>(null);
  const cacheMode = useRef<string | null>(null);
  const historyPages = useRef(new Map<string, number>());
  const [moreHistory, setMoreHistory] = useState<Record<string, boolean>>({});
  const [historyPaging, setHistoryPaging] = useState(false);
  const historyRequests = useRef(new Map<string, Promise<void>>());
  const syncRequests = useRef(new Map<string, Promise<void>>());
  const followLatest = useRef(true);
  const chatScrollTop = useRef(0);
  selectedRef.current = selected;
  const unsaved = useRef(new Map<string, { text: string; revision: number }>()),
    draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    revisionCounter = useRef(0);
  const report = useCallback(
    (e: unknown) =>
      setError(
        e instanceof Error ? e.message : "Не удалось выполнить действие",
      ),
    [],
  );
  const selectConversation = useCallback((id: string) => {
    setSelected(id);
    setTemplatesOpen(false);
  }, []);
  const [editing, setEditing] = useState<{
    message: Message;
    text: string;
  } | null>(null);
  const patchMessage = useCallback((message: Message) => {
    const cache = chatCache.current;
    const entry = cache?.get(message.conversationId);
    if (entry)
      cache?.put(
        message.conversationId,
        entry.messages.map((m) => (m.id === message.id ? message : m)),
      );
    if (selectedRef.current === message.conversationId)
      setMessages((old) => old.map((m) => (m.id === message.id ? message : m)));
    setConversations((old) =>
      old.map((c) =>
        c.id === message.conversationId
          ? {
              ...c,
              preview: cache?.get(c.id)?.messages.at(-1)?.text || c.preview,
            }
          : c,
      ),
    );
  }, []);
  const editMessage = useCallback((message: Message) => {
    setEditing({ message, text: message.text });
    setTemplatesOpen(false);
    inputRef.current?.focus();
  }, []);
  const reactMessage = useCallback(
    async (message: Message, emoji: string | null) => {
      try {
        patchMessage(
          await api<Message>(`/messages/${message.id}/reaction`, "PUT", {
            emoji,
          }),
        );
      } catch (e) {
        report(e);
      }
    },
    [patchMessage, report],
  );
  function removeMessage(deleted: {
    id: string;
    conversationId: string;
    preview?: string;
  }) {
    const cache = chatCache.current,
      entry = cache?.get(deleted.conversationId);
    if (entry)
      cache?.put(
        deleted.conversationId,
        entry.messages.filter((m) => m.id !== deleted.id),
      );
    if (selectedRef.current === deleted.conversationId)
      setMessages((old) => old.filter((m) => m.id !== deleted.id));
    setReplyTargets((old) => ({
      ...old,
      [deleted.conversationId]:
        old[deleted.conversationId]?.id === deleted.id
          ? undefined
          : old[deleted.conversationId],
    }));
    setEditing((old) => (old?.message.id === deleted.id ? null : old));
    setConversations((old) =>
      old.map((c) =>
        c.id === deleted.conversationId
          ? { ...c, preview: cache?.get(c.id)?.messages.at(-1)?.text || "" }
          : c,
      ),
    );
  }
  const deleteMessage = useCallback(async (message: Message) => {
    if (
      !window.confirm(
        "Удалить это сообщение у вас и у собеседника в Telegram? Это нельзя отменить.",
      )
    )
      return;
    const result = await api<{
      id: string;
      conversationId: string;
      preview?: string;
    }>(`/messages/${message.id}`, "DELETE");
    removeMessage(result);
  }, []);
  async function saveEdit() {
    if (!editing || sendLock.current || !editing.text.trim()) return;
    sendLock.current = true;
    setSending(true);
    const current = editing;
    try {
      patchMessage(
        await api<Message>(`/messages/${current.message.id}/text`, "PATCH", {
          text: current.text,
          expectedText: current.message.text,
        }),
      );
      setEditing(null);
    } catch (e) {
      report(e);
    } finally {
      sendLock.current = false;
      setSending(false);
    }
  }
  useEffect(() => setEditing(null), [selected]);
  const replyToMessage = useCallback((message: Message) => {
    setReplyTargets((old) => ({ ...old, [message.conversationId]: message }));
    inputRef.current?.focus();
  }, []);
  const [localAccess, setLocalAccess] = useState(false);
  const notificationSound = useNotificationSound();
  async function refresh() {
    const s = await api("/state");
    if (cacheMode.current !== s.mode) {
      let storage: Storage | undefined;
      try {
        storage = window.sessionStorage;
      } catch {}
      chatCache.current = new ChatCache(s.mode, storage);
      cacheMode.current = s.mode;
    }
    hydrate(s.settings.quickReplies);
    setAccounts(s.accounts);
    setConversations(s.conversations);
    setMode(s.mode);
    setLocalAccess(!!s.localAccess);
    setOwnerName(s.settings.ownerName ?? "Владелец");
    setDrafts((old) => {
      const next = { ...old };
      for (const c of s.conversations)
        if (!(c.id in next)) next[c.id] = c.draft;
      return next;
    });
    setAuth(true);
    setLoading(false);
  }
  async function history(id: string) {
    const existing = historyRequests.current.get(id);
    if (existing) return existing;
    const cache = chatCache.current;
    const task = (async () => {
      let ms: Message[] = [];
      const pages = historyPages.current.get(id) || 1;
      let before: string | undefined,
        more = false;
      for (let n = 0; n < pages; n++) {
        const batch = await api<Message[]>(
          `/conversations/${id}/messages?limit=40${before ? "&before=" + encodeURIComponent(before) : ""}`,
        );
        ms = [...batch, ...ms];
        more = batch.length === 40;
        if (!more) break;
        before = batch[0].id;
      }
      setMoreHistory((old) => ({ ...old, [id]: more }));
      if (cache !== chatCache.current) return;
      const entry = cache?.put(id, ms);
      if (selectedRef.current === id) {
        setMessages(entry?.messages ?? ms);
        setHistoryLoading(false);
      }
    })();
    historyRequests.current.set(id, task);
    try {
      await task;
    } finally {
      historyRequests.current.delete(id);
    }
  }
  useEffect(() => {
    if (!auth) return;
    const url = new URL(window.location.href);
    const id = url.searchParams.get("conversation");
    if (!id || !conversations.some((c) => c.id === id)) return;
    setPage("inbox");
    setShowAllChats(true);
    setFilter("all");
    setUnread(false);
    setQ("");
    selectConversation(id);
    url.searchParams.delete("conversation");
    window.history.replaceState(null, "", url);
  }, [auth, conversations, selectConversation]);
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const open = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.data?.type !== "OPEN_CONVERSATION" ||
        typeof event.data.conversationId !== "string"
      )
        return;
      const url = new URL(window.location.href);
      url.searchParams.set("conversation", event.data.conversationId);
      window.history.replaceState(null, "", url);
      if (auth) void refresh().catch(report);
    };
    navigator.serviceWorker.addEventListener("message", open);
    return () => navigator.serviceWorker.removeEventListener("message", open);
  }, [auth]);
  useEffect(() => {
    api("/auth-status")
      .then((s) => {
        setConfigured(s.configured);
        setMode(s.mode);
      })
      .catch(report);
    refresh().catch(() => {
      setAuth(false);
      setLoading(false);
    });
  }, []);
  useEffect(() => {
    if (!auth) return;
    const events = new EventSource("/api/events");
    events.addEventListener("message-update", (event) => {
      try {
        patchMessage(JSON.parse((event as MessageEvent).data));
      } catch {
        /* Ignore malformed stream events. */
      }
    });
    events.addEventListener("message-deleted", (event) => {
      try {
        removeMessage(JSON.parse((event as MessageEvent).data));
      } catch {}
    });
    events.addEventListener("incoming", () => notificationSound.play());
    events.addEventListener("orders-changed", () =>
      window.dispatchEvent(new Event("jorik:orders-changed")),
    );
    events.onopen = () => {
      setOnline(true);
      window.dispatchEvent(new Event("jorik:orders-changed"));
    };
    events.onerror = () => setOnline(false);
    let active = true;
    const update = coalesceAsync(async () => {
      if (!active) return;
      await refresh();
      if (active && selectedRef.current) await history(selectedRef.current);
    });
    events.onmessage = () => {
      setOnline(true);
      void update().catch(report);
    };
    return () => {
      active = false;
      events.close();
    };
  }, [auth]);
  useLayoutEffect(() => {
    const cached = selected ? chatCache.current?.get(selected) : undefined;
    setMessages(cached?.messages || []);
    setHistoryLoading(!!selected && !cached);
  }, [selected]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    history(selected)
      .then(async () => {
        const conv = conversations.find((c) => c.id === selected);
        const account = accounts.find((a) => a.id === conv?.accountId);
        if (
          mode === "real" &&
          (account?.adapter === "telegram-mtproto" ||
            account?.adapter === "instagram-graph") &&
          account.state === "connected" &&
          Date.now() - (chatCache.current?.get(selected)?.syncedAt || 0) >
            300_000
        ) {
          let task = syncRequests.current.get(selected);
          if (!task) {
            const cache = chatCache.current;
            task = (async () => {
              await api(`/${account.platform}/history/${selected}`, "POST", {});
              await history(selected);
              const entry = cache?.get(selected);
              if (entry && cache === chatCache.current)
                cache?.put(selected, entry.messages, Date.now());
            })();
            syncRequests.current.set(selected, task);
            void task
              .finally(() => syncRequests.current.delete(selected))
              .catch(() => {});
          }
          await task;
        }
      })
      .catch((e) => {
        if (active) report(e);
      })
      .finally(() => {
        if (active) setHistoryLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selected]);
  useEffect(() => {
    if (!selected || page !== "inbox" || historyLoading) return;
    const markVisibleRead = () => {
      if (document.visibilityState !== "visible") return;
      api(`/conversations/${selected}/read`, "POST", { unread: false }).catch(
        report,
      );
    };
    markVisibleRead();
    document.addEventListener("visibilitychange", markVisibleRead);
    return () =>
      document.removeEventListener("visibilitychange", markVisibleRead);
  }, [selected, page, historyLoading]);
  useLayoutEffect(() => {
    followLatest.current = true;
    chatScrollTop.current = 0;
  }, [selected]);
  useLayoutEffect(() => {
    const container = bottom.current?.parentElement?.parentElement;
    if (!container || page !== "inbox") return;
    container.scrollTop = followLatest.current
      ? container.scrollHeight
      : chatScrollTop.current;
  }, [messages, selected, historyLoading, page]);
  useLayoutEffect(() => {
    const content = bottom.current?.parentElement;
    const container = content?.parentElement;
    if (!content || !container || page !== "inbox") return;
    const observer = new ResizeObserver(() => {
      // Photos can resize after history is rendered. Keep the last message visible
      // only while the reader has not scrolled back into the conversation.
      if (followLatest.current) container.scrollTop = container.scrollHeight;
    });
    observer.observe(content);
    observer.observe(container);
    return () => observer.disconnect();
  }, [selected, page, auth]);
  useEffect(() => {
    let active = true;
    if (!q) {
      setSearchIds([]);
      return;
    }
    const controller = new AbortController();
    const t = setTimeout(
      () =>
        api(
          "/search?q=" + encodeURIComponent(q),
          "GET",
          undefined,
          controller.signal,
        )
          .then((s) => {
            if (active) setSearchIds(s.ids);
          })
          .catch((e) => {
            if (active) report(e);
          }),
      180,
    );
    return () => {
      active = false;
      controller.abort();
      clearTimeout(t);
    };
  }, [q]);
  const accountsById = useMemo(
    () => new Map(accounts.map((a) => [a.id, a])),
    [accounts],
  );
  const c = conversations.find((c) => c.id === selected),
    a = c ? accountsById.get(c.accountId) : undefined;
  const replyWindow = instagramReplyWindow(c, messages, clockNow);
  const instagramWindowClosed =
    a?.adapter === "instagram-graph" && replyWindow.closed;
  const filtered = useMemo(() => {
    const query = q.toLocaleLowerCase();
    const matches = new Set(searchIds);
    const source =
      showAllChats || q ? conversations : recentConversations(conversations);
    return source.filter((c) => {
      const a = accountsById.get(c.accountId);
      return (
        (filter === "all" || filter === a?.platform || filter === a?.id) &&
        (!unread || c.unread > 0) &&
        (!q ||
          `${c.name} ${c.username} ${c.preview} ${a?.name || ""}`
            .toLocaleLowerCase()
            .includes(query) ||
          matches.has(c.id))
      );
    });
  }, [conversations, accountsById, filter, unread, q, searchIds, showAllChats]);
  async function logout() {
    await flushDrafts();
    await api("/logout", "POST");
    chatCache.current?.clear();
    chatCache.current = null;
    cacheMode.current = null;
    setSelected(null);
    setMessages([]);
    setLogoutOpen(false);
    setAuth(false);
  }
  function flushDrafts() {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    for (const [id, value] of unsaved.current) {
      draftChain.current = draftChain.current
        .catch(() => {})
        .then(() => api(`/conversations/${id}/draft`, "PUT", value))
        .then(() => {
          if (unsaved.current.get(id)?.revision === value.revision)
            unsaved.current.delete(id);
          setDraftState("Черновик сохранён");
        })
        .catch((e) => {
          setDraftState("Черновик не сохранён");
          report(e);
        });
    }
    return draftChain.current;
  }
  useEffect(() => {
    const flush = () => {
      for (const [id, value] of unsaved.current)
        void fetch(`/api/conversations/${id}/draft`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(value),
          keepalive: true,
        });
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  function draft(text: string) {
    if (!selected) return;
    const id = selected;
    setDrafts((d) => ({ ...d, [id]: text }));
    unsaved.current.set(id, {
      text,
      revision: Date.now() * 1000 + (revisionCounter.current++ % 1000),
    });
    setDraftState("Сохранение…");
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => void flushDrafts(), 250);
  }
  const sentFocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!sending && sentFocus.current) {
      const id = sentFocus.current;
      sentFocus.current = null;
      if (selectedRef.current === id && page === "inbox")
        inputRef.current?.focus({ preventScroll: true });
    }
  }, [sending, page]);
  async function send(override?: string) {
    if (
      !c ||
      !a ||
      !online ||
      a.state !== "connected" ||
      !a.capabilities.text ||
      instagramWindowClosed ||
      uploading ||
      sendLock.current
    )
      return;
    const content = override ?? drafts[c.id] ?? "";
    const attachment = override === undefined ? uploads[c.id] : undefined;
    const replyTarget = override === undefined ? replyTargets[c.id] : undefined;
    if (!content.trim() && !attachment) return;
    if (attachment && a.platform === "instagram" && replyTarget) {
      setError(
        "В Instagram отправьте изображение отдельно от текстовой цитаты.",
      );
      return;
    }
    if (attachment && a.platform === "instagram" && content.trim()) {
      setError("В Instagram отправьте фото и текст отдельными сообщениями.");
      return;
    }
    inputRef.current?.focus({ preventScroll: true });
    sendLock.current = true;
    setSending(true);
    const id = c.id,
      text = content.trim();
    if (
      !pending.current ||
      pending.current.id !== id ||
      pending.current.text !==
        JSON.stringify([text, attachment?.id, replyTarget?.id])
    )
      pending.current = {
        id,
        text: JSON.stringify([text, attachment?.id, replyTarget?.id]),
        key: crypto.randomUUID(),
      };
    try {
      await flushDrafts();
      await api(`/conversations/${id}/messages`, "POST", {
        text,
        key: pending.current.key,
        uploadId: attachment?.id,
        replyToId: replyTarget?.id,
        preserveDraft: override !== undefined,
      });
      pending.current = null;
      sentFocus.current = id;
      if (override === undefined) {
        setDrafts((d) => ({ ...d, [id]: "" }));
        setUploads((old) => ({ ...old, [id]: undefined }));
        setReplyTargets((old) => ({ ...old, [id]: undefined }));
      }
      setDraftState("");
      await history(id);
      await refresh();
    } catch (e) {
      report(e);
    } finally {
      sendLock.current = false;
      setSending(false);
    }
  }
  async function markUnread(id: string) {
    await action(() =>
      api(`/conversations/${id}/read`, "POST", { unread: true }),
    );
  }
  async function action(fn: () => Promise<unknown>) {
    try {
      await fn();
      await refresh();
    } catch (e) {
      report(e);
    }
  }
  async function attach(file?: File) {
    if (!file || !c || uploading) return;
    if (
      !["image/jpeg", "image/png"].includes(file.type) ||
      file.size > 8 * 1024 * 1024
    ) {
      setError("Выберите изображение JPG или PNG размером до 8 МБ.");
      return;
    }
    const id = c.id;
    setUploading(true);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const saved = await api(`/conversations/${id}/uploads`, "POST", {
        name: file.name,
        data,
      });
      setUploads((old) => ({ ...old, [id]: saved }));
    } catch (e) {
      report(e);
    } finally {
      setUploading(false);
    }
  }
  useEffect(() => {
    setTemplateIndex((i) => Math.min(i, Math.max(0, slots.length - 1)));
  }, [slots]);
  function insertTemplate(index: number) {
    if (!slots[index]?.text || !selected || editing) return;
    draft(slots[index].text);
    setTemplatesOpen(false);
    inputRef.current?.focus();
  }
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        !auth ||
        page !== "inbox" ||
        event.isComposing ||
        event.repeat ||
        document.querySelector("dialog[open]")
      )
        return;
      if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        const index = filtered.findIndex((x) => x.id === selected);
        const next = Math.max(
          0,
          Math.min(
            filtered.length - 1,
            index + (event.key === "ArrowDown" ? 1 : -1),
          ),
        );
        if (filtered[next]) {
          setVisibleChats((n) => Math.max(n, next + 1));
          setSelected(filtered[next].id);
          setTemplatesOpen(false);
        }
      }
      if (
        !editing &&
        event.ctrlKey &&
        !event.altKey &&
        /^[1-9]$/.test(event.key)
      ) {
        const slot = slots[Number(event.key) - 1];
        if (slot?.text.trim()) {
          event.preventDefault();
          void send(slot.text);
        }
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });
  if (loading)
    return (
      <div className="login">
        <div className="brand">
          j<span>●</span>rik
        </div>
        <p>Открываем ваши диалоги…</p>
      </div>
    );
  if (!auth)
    return (
      <div className="login">
        <div className="login-card">
          <div className="brand">
            j<span>●</span>rik
          </div>
          <span className="eyebrow">ЕДИНОЕ ПРОСТРАНСТВО ОБЩЕНИЯ</span>
          <h1>
            Все диалоги.
            <br />
            Один спокойный день.
          </h1>
          <p>Войдите, чтобы продолжить общение с клиентами.</p>
          {mode === "demo" && (
            <div className="demo-label">◉ Демонстрационный режим</div>
          )}
          {!configured ? (
            <p className="setup">
              Создайте владельца в терминале проекта:
              <br />
              <code>npm run owner</code>
              <br />
              Затем обновите страницу.
            </p>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                action(async () => {
                  await api("/login", "POST", {
                    password,
                    remember: rememberLogin,
                  });
                  setPassword("");
                  setShowPassword(false);
                  await refresh();
                });
              }}
            >
              <input
                type="hidden"
                name="username"
                autoComplete="username"
                value="owner"
              />
              <label htmlFor="owner-password">Пароль владельца</label>
              <div className="login-password">
                <input
                  id="owner-password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  className="password-toggle"
                  aria-label={
                    showPassword ? "Скрыть пароль" : "Показать пароль"
                  }
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((shown) => !shown)}
                >
                  {showPassword ? <EyeOff size={19} /> : <Eye size={19} />}
                </button>
              </div>
              <label className="remember-login">
                <input
                  type="checkbox"
                  checked={rememberLogin}
                  onChange={(e) => setRememberLogin(e.target.checked)}
                />
                Оставаться в системе на этом устройстве
              </label>
              <button className="primary">
                Войти в рабочее пространство{" "}
                <ArrowLeft size={16} style={{ transform: "rotate(180deg)" }} />
              </button>
            </form>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <small>Закрытый доступ · Пароль можно сохранить в браузере</small>
        </div>
      </div>
    );
  return (
    <div
      className={`app ${orderPanelOpen ? "has-order-panel" : ""} ${page === "inbox" ? "inbox-page" : ""} ${composerFocused && page === "inbox" && selected ? "composer-focused" : ""}`}
      style={
        composerFocused && composerViewport
          ? ({
              "--chat-viewport-height": `${composerViewport.height}px`,
              "--chat-viewport-top": `${composerViewport.top}px`,
            } as CSSProperties)
          : undefined
      }
    >
      <aside
        className="sidebar bg-slate-900 dark:bg-black text-slate-400"
        aria-label="Основная навигация"
      >
        <div className="rail-logo" title="Jorik">
          j<span>•</span>
        </div>
        <button
          className={"rail-button " + (page === "inbox" ? "active" : "")}
          aria-label="Входящие"
          aria-current={page === "inbox" ? "page" : undefined}
          title="Входящие"
          onClick={() => setPage("inbox")}
        >
          <MessageSquare size={22} />
          <span className="rail-label">Чаты</span>
          {conversations.some((c) => c.unread > 0) && (
            <span className="rail-count">
              {conversations.reduce((n, c) => n + c.unread, 0)}
            </span>
          )}
        </button>
        <button
          className={"rail-button " + (page === "orders" ? "active" : "")}
          aria-label="Заказы"
          aria-current={page === "orders" ? "page" : undefined}
          title="Заказы"
          onClick={() => setPage("orders")}
        >
          <Package size={22} />
          <span className="rail-label">Заказы</span>
        </button>
        <button
          className={"rail-button archive-nav " + (archiveOpen ? "active" : "")}
          aria-label="Поиск по архиву"
          title="Поиск по архиву"
          aria-haspopup="dialog"
          aria-expanded={archiveOpen}
          aria-controls="archive-search-drawer"
          onClick={() => setArchiveOpen(true)}
        >
          <Search size={22} />
          <span className="rail-label">Поиск</span>
        </button>
        <div className="rail-bottom">
          <button
            className="rail-button theme-nav"
            aria-label={dark ? "Светлая тема" : "Тёмная тема"}
            title={dark ? "Светлая тема" : "Тёмная тема"}
            onClick={toggleTheme}
          >
            {dark ? <Sun size={22} /> : <Moon size={22} />}
            <span className="rail-label">{dark ? "День" : "Ночь"}</span>
          </button>
          <button
            className={"rail-button " + (page === "settings" ? "active" : "")}
            aria-label="Настройки"
            aria-current={page === "settings" ? "page" : undefined}
            title="Настройки"
            onClick={() => setPage("settings")}
          >
            <Settings size={22} />
            <span className="rail-label">Настройки</span>
          </button>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div>
            <span className="breadcrumb">Рабочее пространство</span>
            <span className="slash">/</span>
            <b>
              {page === "inbox"
                ? "Входящие"
                : page === "orders"
                  ? "Заказы"
                  : "Настройки"}
            </b>
          </div>
          <span className={mode === "demo" ? "demo-label" : "real-label"}>
            ◉ {mode === "demo" ? "Демонстрационный режим" : "Реальный режим"}
          </span>
        </header>
        {!online && (
          <div className="connection-alert">
            <WifiOff size={16} />
            Нет связи с сервером. Переподключаемся; при восстановлении обновим
            историю.
          </div>
        )}
        {error && (
          <div className="error-banner" role="alert">
            <AlertCircle size={17} />
            {error}
            <button aria-label="Закрыть ошибку" onClick={() => setError("")}>
              <X size={17} />
            </button>
          </div>
        )}
        <div
          className={"inbox " + (selected ? "has-selection" : "")}
          style={page === "inbox" ? undefined : { display: "none" }}
        >
          <section className="conversation-list bg-white dark:bg-slate-900 dark:text-slate-200">
            <div className="list-heading">
              <h1>
                Входящие <span>{filtered.length}</span>
              </h1>
              <span className={"list-online " + (online ? "is-online" : "")}>
                <i />
                {online ? "Онлайн" : "Нет связи"}
              </span>
            </div>
            <div className="inbox-filters" aria-label="Быстрые фильтры">
              <button
                aria-pressed={filter === "all" && !unread}
                onClick={() => {
                  setFilter("all");
                  setUnread(false);
                }}
              >
                Все
              </button>
              <button
                className="waiting-filter"
                aria-pressed={unread}
                onClick={() => {
                  setFilter("all");
                  setUnread(!unread);
                }}
              >
                <i className="waiting-dot" aria-hidden="true" />
                Ждут ответа
              </button>
              <button
                className="telegram-filter"
                aria-pressed={filter === "telegram" && !unread}
                onClick={() => {
                  setFilter("telegram");
                  setUnread(false);
                }}
              >
                Telegram
              </button>
              <button
                className="instagram-filter"
                aria-pressed={filter === "instagram" && !unread}
                onClick={() => {
                  setFilter("instagram");
                  setUnread(false);
                }}
              >
                Instagram
              </button>
            </div>
            <div className="search">
              <Search size={17} />
              <input
                aria-label="Поиск диалогов и сообщений"
                placeholder="Поиск диалогов и сообщений"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <button
              className="conversation-limit"
              onClick={() => setShowAllChats((value) => !value)}
            >
              {showAllChats
                ? "Все сохранённые · Показать 50 последних на аккаунт"
                : "50 последних на аккаунт · Показать все сохранённые"}
            </button>
            <div className="conversation-scroll">
              {filtered.slice(0, visibleChats).map((c, i) => {
                const account = accountsById.get(c.accountId);
                return account ? (
                  <ConversationRow
                    key={c.id}
                    conversation={c}
                    account={account}
                    index={i}
                    selected={selected === c.id}
                    draft={drafts[c.id] ?? ""}
                    onSelect={selectConversation}
                  />
                ) : null;
              })}
              {visibleChats < filtered.length && (
                <button
                  className="secondary"
                  onClick={() => setVisibleChats((n) => n + 100)}
                >
                  Показать ещё диалоги
                </button>
              )}
              {filtered.length === 0 && (
                <div className="empty">
                  <Search />
                  <h3>Диалогов пока нет</h3>
                  <p>
                    {q
                      ? "Попробуйте другой поисковый запрос"
                      : mode === "demo"
                        ? "Добавьте примеры командой npm run seed"
                        : "Для загрузки переписки откройте «Настройки» → «Аккаунты и подключения» и войдите в Telegram."}
                  </p>
                </div>
              )}
            </div>
            <footer className="list-footer">
              <i className={"dot " + (online ? "connected" : "offline")} />
              {online ? "Обновляется в реальном времени" : "Ожидаем соединения"}
            </footer>
          </section>
          <section
            className="chat bg-slate-50 dark:bg-slate-950"
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("Files")) {
                e.preventDefault();
                setDragging(true);
              }
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node))
                setDragging(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void attach(e.dataTransfer.files[0]);
            }}
          >
            {dragging && (
              <div className="drop-overlay absolute inset-0 bg-blue-500/20 backdrop-blur-sm">
                <Upload />
                <strong>Отпустите файл для отправки</strong>
                <small>Изображение появится в поле ответа</small>
              </div>
            )}
            {c && a ? (
              <>
                <header className="chat-header">
                  <button
                    className="back"
                    aria-label="Назад к списку"
                    onClick={() => setSelected(null)}
                  >
                    <ArrowLeft size={20} />
                  </button>
                  <span className={"workspace-platform " + a.platform}>
                    <PlatformIcon platform={a.platform} />
                  </span>
                  <div className="workspace-contact">
                    <div className="workspace-contact-title">
                      <h2>
                        {c.username
                          ? "@" + c.username.replace(/^@/, "")
                          : c.name}
                      </h2>
                      <StoreBadge name={a.name} color={a.color} />
                    </div>
                    <small>Диалог через {a.name}</small>
                    {a.adapter === "instagram-graph" && (
                      <span
                        className={
                          "meta-reply-window " +
                          (instagramWindowClosed ? "closed" : "")
                        }
                        title="Расчёт от последнего входящего сообщения; возможность ответа также зависит от разрешений Meta"
                      >
                        {instagramWindowClosed
                          ? "Окно ответа Meta закрыто"
                          : `Окно Meta: ещё ${replyWindow.remainingMinutes} мин`}
                      </span>
                    )}
                  </div>
                  <button
                    className="icon mark-unread"
                    title="Отметить непрочитанным"
                    aria-label="Отметить непрочитанным"
                    onClick={() => void markUnread(c.id)}
                  >
                    <Mail size={20} />
                  </button>
                  <button
                    className="icon create-order"
                    title="Создать заказ"
                    aria-label={
                      orderPanelOpen
                        ? "Свернуть панель заказа"
                        : "Создать заказ"
                    }
                    aria-pressed={orderPanelOpen}
                    onClick={() => {
                      if (orderPanelOpen) {
                        setOrderCloseRequest((x) => x + 1);
                        return;
                      }
                      setOrderContext({ conversation: c, account: a });
                      setOrderRequest((x) => x + 1);
                    }}
                  >
                    <Package size={17} />
                    <span>
                      {orderPanelOpen ? "Свернуть заказ" : "Создать заказ"}
                    </span>
                  </button>
                  <button
                    title="Информация о клиенте"
                    aria-label="Информация о клиенте"
                    className={info ? "icon active-icon" : "icon"}
                    onClick={() => setInfo(!info)}
                  >
                    <Info size={21} />
                  </button>
                </header>
                <div className="chat-context">
                  <select
                    className="stage-select"
                    aria-label="Статус диалога"
                    value={c.stage || ""}
                    onChange={(e) =>
                      void action(() =>
                        api(`/conversations/${c.id}/stage`, "PATCH", {
                          stage: e.target.value,
                        }),
                      )
                    }
                  >
                    <option value="">Без статуса</option>
                    <option value="new">Новый</option>
                    <option value="paid">Оплачен</option>
                    <option value="waiting">Ждёт</option>
                  </select>
                  <span className={"platform " + a.platform}>
                    <PlatformIcon platform={a.platform} />
                  </span>
                  Диалог через <b style={{ color: a.color }}>{a.name}</b>
                  <span className="context-right">
                    {a.state === "connected"
                      ? "Подключено"
                      : a.state === "offline"
                        ? "Нет подключения"
                        : "Не настроено"}
                  </span>
                </div>
                <div
                  className="messages"
                  onScroll={(e) => {
                    const el = e.currentTarget;
                    if (page !== "inbox") return;
                    chatScrollTop.current = el.scrollTop;
                    followLatest.current =
                      el.scrollHeight - el.clientHeight - el.scrollTop < 48;
                  }}
                >
                  <div className="messages-content">
                    {historyLoading && (
                      <p className="date-separator">Загружаем историю…</p>
                    )}
                    {selected && moreHistory[selected] && (
                      <button
                        className="secondary history-more"
                        disabled={historyPaging}
                        onClick={async () => {
                          if (historyPaging) return;
                          setHistoryPaging(true);
                          const id = selected;
                          const el = bottom.current?.closest(".messages");
                          const height = el?.scrollHeight || 0,
                            top = el?.scrollTop || 0;
                          historyPages.current.set(
                            id,
                            (historyPages.current.get(id) || 1) + 1,
                          );
                          followLatest.current = false;
                          try {
                            await history(id);
                            requestAnimationFrame(() => {
                              if (el && selectedRef.current === id)
                                el.scrollTop = top + el.scrollHeight - height;
                            });
                          } catch (e) {
                            report(e);
                          } finally {
                            setHistoryPaging(false);
                          }
                        }}
                      >
                        {historyPaging
                          ? "Загружаем…"
                          : "Загрузить предыдущие сообщения"}
                      </button>
                    )}
                    <MessageTimeline
                      messages={messages}
                      platform={a.platform}
                      dismissed={dismissed}
                      setDismissed={setDismissed}
                      onReply={replyToMessage}
                      onEdit={editMessage}
                      onReact={reactMessage}
                      onDelete={deleteMessage}
                    />
                    <div ref={bottom} />
                  </div>
                </div>
                <div className="composer-wrap">
                  <div className="reply-account">
                    <span className={"platform " + a.platform}>
                      <PlatformIcon platform={a.platform} />
                    </span>
                    Ответ от{" "}
                    <b style={{ color: a.color }}>
                      {a.platform === "telegram" ? "Telegram" : "Instagram"} ·{" "}
                      {a.name}
                    </b>
                    <span className="draft-status">{draftState}</span>
                  </div>
                  <div className="quick-replies flex gap-2 mb-2">
                    <span className="quick-replies-label">Шаблоны:</span>
                    {slots.map((slot, i) => (
                      <button
                        key={slot.id}
                        className="bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300"
                        title={slot.text || "Настройте этот слот в настройках"}
                        onClick={() =>
                          slot.text ? insertTemplate(i) : setPage("settings")
                        }
                      >
                        {slot.title || `+ Слот ${i + 1}`}
                      </button>
                    ))}
                    <button
                      className="ml-auto"
                      onClick={() => {
                        setTemplatesOpen((x) => !x);
                        setTemplateIndex(0);
                      }}
                    >
                      <Zap size={14} /> Шаблоны
                    </button>
                  </div>
                  {templatesOpen && (
                    <div
                      className="template-menu"
                      role="listbox"
                      aria-label="Шаблоны ответов"
                    >
                      {slots.map((slot, i) => (
                        <button
                          key={slot.id}
                          role="option"
                          aria-selected={templateIndex === i}
                          disabled={!slot.text}
                          className={templateIndex === i ? "selected" : ""}
                          onClick={() => insertTemplate(i)}
                        >
                          <b>{slot.title || `Слот ${i + 1}`}</b>
                          <span>{slot.text || "Не настроен"}</span>
                          {quickReplyHotkey(i) && (
                            <kbd>{quickReplyHotkey(i)}</kbd>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                  {replyTargets[c.id] && !editing && (
                    <div className="reply-strip border-l-4 border-blue-500">
                      <Reply size={16} />
                      <div>
                        <b>
                          Ответ на сообщение
                          {a.platform === "instagram"
                            ? " · текстовая цитата"
                            : ""}
                        </b>
                        <span>{replyTargets[c.id]?.text}</span>
                      </div>
                      <button
                        aria-label="Отменить ответ"
                        onClick={() =>
                          setReplyTargets((old) => ({
                            ...old,
                            [c.id]: undefined,
                          }))
                        }
                      >
                        <X size={16} />
                      </button>
                    </div>
                  )}
                  {uploads[c.id] && !editing && (
                    <div className="reply-strip">
                      <img
                        src={"/api/uploads/" + uploads[c.id]?.id}
                        alt="Изображение для отправки"
                      />
                      <span>{uploads[c.id]?.name}</span>
                      <button
                        aria-label="Убрать изображение"
                        onClick={() =>
                          setUploads((old) => ({ ...old, [c.id]: undefined }))
                        }
                      >
                        <X size={16} />
                      </button>
                    </div>
                  )}
                  {editing && (
                    <div className="reply-strip">
                      <span>Редактирование сообщения</span>
                      <button
                        aria-label="Отменить редактирование"
                        onClick={() => setEditing(null)}
                      >
                        <X size={16} />
                      </button>
                    </div>
                  )}
                  <div className="composer">
                    <textarea
                      ref={inputRef}
                      aria-label="Текст ответа"
                      placeholder="Напишите сообщение…"
                      value={editing?.text ?? drafts[c.id] ?? ""}
                      readOnly={sending}
                      onFocus={() => setComposerFocused(true)}
                      onBlur={() => setComposerFocused(false)}
                      onChange={(e) => {
                        if (editing) {
                          setEditing({ ...editing, text: e.target.value });
                          return;
                        }
                        draft(e.target.value);
                        if (e.target.value === "/") {
                          setTemplatesOpen(true);
                          setTemplateIndex(0);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (
                          templatesOpen &&
                          ["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(
                            e.key,
                          )
                        ) {
                          e.preventDefault();
                          if (e.key === "Escape") setTemplatesOpen(false);
                          else if (e.key === "Enter")
                            insertTemplate(templateIndex);
                          else
                            setTemplateIndex((i) =>
                              nextTemplateIndex(
                                i,
                                e.key === "ArrowDown" ? 1 : -1,
                                slots.length,
                              ),
                            );
                          return;
                        }
                        if (
                          e.key === "Enter" &&
                          !e.shiftKey &&
                          !e.nativeEvent.isComposing
                        ) {
                          e.preventDefault();
                          if (editing) void saveEdit();
                          else void send();
                        }
                      }}
                    />
                    <div className="composer-toolbar">
                      <input
                        ref={fileInput}
                        type="file"
                        accept="image/jpeg,image/png"
                        hidden
                        onChange={(e) => {
                          void attach(e.target.files?.[0]);
                          e.target.value = "";
                        }}
                      />
                      <button
                        className="attachment-note"
                        aria-label="Прикрепить изображение"
                        disabled={uploading || sending || !!editing}
                        onClick={() => fileInput.current?.click()}
                      >
                        <Paperclip size={18} />
                        {uploading ? "Загрузка…" : "Фото"}
                      </button>
                      <button
                        className="send"
                        onPointerDown={(e) => e.preventDefault()}
                        disabled={
                          sending ||
                          !online ||
                          (!(editing?.text ?? drafts[c.id])?.trim() &&
                            !uploads[c.id]) ||
                          uploading ||
                          instagramWindowClosed ||
                          !a.capabilities.text ||
                          a.state !== "connected"
                        }
                        onClick={() =>
                          editing ? void saveEdit() : void send()
                        }
                      >
                        {sending
                          ? "Подождите…"
                          : editing
                            ? "Сохранить"
                            : "Отправить"}
                        {editing ? <Check size={16} /> : <Send size={16} />}
                      </button>
                    </div>
                  </div>
                  {instagramWindowClosed && (
                    <p className="instagram-window-note">
                      Для ответа через Jorik нужно новое сообщение клиента:
                      стандартное окно Instagram — 24 часа. Сейчас можно
                      ответить в приложении Instagram.
                    </p>
                  )}
                  <div className="composer-bottom">
                    <span>
                      Enter — отправить · / — шаблоны · Alt + ↑↓ — чаты · Ctrl +
                      1–9 — отправить шаблон
                    </span>
                    {mode === "demo" && (
                      <button
                        onClick={() =>
                          action(() =>
                            api("/demo/incoming", "POST", {
                              conversationId: c.id,
                            }),
                          )
                        }
                      >
                        <Plus size={13} />
                        Тестовое входящее
                      </button>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div className="empty chat-empty">
                <div className="empty-icon">
                  <MessageSquare size={32} />
                </div>
                {mode === "real" && conversations.length === 0 ? (
                  <>
                    <h2>Подключите ваш Telegram</h2>
                    <p>
                      Вы уже вошли в Jorik. Теперь войдите в Telegram по номеру
                      телефона, чтобы загрузить ваши диалоги.
                    </p>
                    <button
                      className="primary"
                      style={{ marginTop: 20 }}
                      onClick={() => {
                        setAccountsExpanded(true);
                        setPage("settings");
                      }}
                    >
                      Подключить Telegram 1
                    </button>
                  </>
                ) : (
                  <>
                    <h2>Хороший разговор начинается здесь</h2>
                    <p>
                      Выберите диалог слева, чтобы ответить клиенту.
                      <br />
                      Все обращения — в одном пространстве.
                    </p>
                  </>
                )}
                <span className="keyboard-hint">Telegram + Instagram</span>
              </div>
            )}
          </section>
          {info && c && a && (
            <aside className="info-panel">
              <button
                className="icon"
                aria-label="Закрыть информацию"
                onClick={() => setInfo(false)}
              >
                <X size={19} />
              </button>
              <Avatar name={c.name} conversationId={c.id} />
              <h2>{c.name}</h2>
              <p>@{c.username}</p>
              <dl>
                <dt>Источник</dt>
                <dd style={{ color: a.color }}>{a.name}</dd>
                <dt>История</dt>
                <dd>{messages.length} сообщений</dd>
                <dt>Прочтение</dt>
                <dd>Синхронизация с мессенджером</dd>
              </dl>
              <button
                className="secondary"
                onClick={() => void markUnread(c.id)}
              >
                Отметить непрочитанным
              </button>
              <small>
                Прочтение и ответы синхронизируются с подключёнными аккаунтами;
                возможности Instagram зависят от событий Meta.
              </small>
            </aside>
          )}
        </div>
        <Suspense fallback={null}>
          <Orders
            accounts={accounts}
            conversations={conversations}
            visible={page === "orders"}
            context={orderContext}
            openRequest={orderRequest}
            closeRequest={orderCloseRequest}
            onCloseRequest={() => setOrderContext(undefined)}
            onPanelChange={setOrderPanelOpen}
          />
        </Suspense>
        <Suspense fallback={null}>
          <ArchiveSearch
            open={archiveOpen}
            onClose={closeArchive}
            conversationId={c?.id}
            chatName={
              c ? `${c.username || c.name} · ${a?.name || ""}` : undefined
            }
          />
        </Suspense>
        {page === "settings" && (
          <Suspense
            fallback={<p className="page-content">Загружаем настройки…</p>}
          >
            <SettingsView
              accountsExpanded={accountsExpanded}
              onToggleAccounts={() => setAccountsExpanded((value) => !value)}
              accountsContent={
                <>
                  <div className="account-grid">
                    {accounts.map((a) => (
                      <article className="account-card" key={a.id}>
                        <div className="account-card-top">
                          <span className={"platform large " + a.platform}>
                            <PlatformIcon platform={a.platform} />
                          </span>
                          <span className={"state-pill " + a.state}>
                            {a.state === "connected"
                              ? "Подключено"
                              : a.state === "offline"
                                ? "Нет связи"
                                : "Не настроено"}
                          </span>
                        </div>
                        <h2 className="account-display-name">
                          <StoreBadge name={a.name} color={a.color} />
                        </h2>
                        <p className="account-platform-label">
                          {a.platform === "telegram" ? "Telegram" : "Instagram"}{" "}
                          ·{" "}
                          {a.state === "connected"
                            ? "Готов к работе"
                            : "Требует внимания"}
                        </p>
                        <details className="account-details">
                          <summary>Настройка подключения</summary>
                          <AccountName account={a} onSaved={refresh} />
                          <p>
                            {a.platform === "telegram"
                              ? "Telegram"
                              : "Instagram"}{" "}
                            ·{" "}
                            {a.mode === "demo"
                              ? "Демонстрация"
                              : "Реальное подключение"}
                          </p>
                          <dl>
                            <dt>Адаптер</dt>
                            <dd>
                              {a.adapter === "demo"
                                ? "Демонстрационный"
                                : a.adapter === "telegram-mtproto"
                                  ? "Telegram MTProto"
                                  : a.adapter === "instagram-graph"
                                    ? "Instagram · Meta API"
                                    : "Не выбран"}
                            </dd>
                            <dt>Синхронизация</dt>
                            <dd>
                              {a.lastSync
                                ? `${date(a.lastSync)}, ${time(a.lastSync)}`
                                : "Ещё не выполнялась"}
                            </dd>
                            <dt>Возможности</dt>
                            <dd>
                              {a.capabilities.text
                                ? a.capabilities.images
                                  ? "Текст, фото, сохранённая история"
                                  : "Текст, сохранённая история"
                                : "Ожидают выбора API"}
                            </dd>
                          </dl>
                          {a.error && <p className="error">{a.error}</p>}
                          {mode === "real" && a.platform === "telegram" && (
                            <TelegramConnect
                              accountId={a.id}
                              active={page === "settings" && accountsExpanded}
                              onChange={() => void refresh().catch(report)}
                            />
                          )}
                          {mode === "real" && a.platform === "instagram" && (
                            <div className="instagram-connect">
                              <p>
                                {a.receiveMode === "webhook"
                                  ? a.webhookConfigured
                                    ? "Приём через вебхуки Meta. Фоновая загрузка списка чатов отключена. История выбранного диалога — до 10 сообщений по запросу."
                                    : "Фоновая загрузка отключена. Для новых сообщений нужно завершить настройку вебхуков Meta. Сохранённые чаты доступны."
                                  : "Проверка новых сообщений каждые 5 секунд: до 50 диалогов и 30 сообщений при открытии."}{" "}
                                Текстовые ответы — в течение 24 часов после
                                сообщения клиента. Фото и видео открываются в
                                чате; недоступные вложения — в Instagram.
                              </p>
                              <button
                                className="secondary"
                                onClick={() =>
                                  action(() =>
                                    api("/instagram/sync", "POST", {
                                      accountId: a.id,
                                    }),
                                  )
                                }
                              >
                                {a.receiveMode === "webhook"
                                  ? "Проверить подключение"
                                  : "Обновить Instagram"}
                              </button>
                              <button
                                className="secondary"
                                disabled={a.recentImport?.state === "running"}
                                onClick={() =>
                                  action(() =>
                                    api("/instagram/import-recent", "POST", {
                                      accountId: a.id,
                                    }),
                                  )
                                }
                              >
                                {a.recentImport?.state === "running"
                                  ? `Загружаем: ${a.recentImport.imported} из 50…`
                                  : "Загрузить 50 последних чатов"}
                              </button>
                              {a.recentImport?.error && (
                                <p className="error">{a.recentImport.error}</p>
                              )}
                            </div>
                          )}
                          {mode === "demo" && (
                            <button
                              className="secondary"
                              onClick={() =>
                                action(() =>
                                  api(
                                    `/demo/accounts/${a.id}/toggle`,
                                    "POST",
                                    {},
                                  ),
                                )
                              }
                            >
                              {a.state === "connected"
                                ? "Симулировать потерю связи"
                                : "Восстановить подключение"}
                            </button>
                          )}
                        </details>
                      </article>
                    ))}
                  </div>
                  <div className="note">
                    <Info size={20} />
                    <p>
                      {mode === "demo"
                        ? "Демонстрационный адаптер работает только локально. Сообщения не уходят во внешние сервисы."
                        : "Подключите каждый Telegram-аккаунт отдельно. Диалоги и ответы привязаны к выбранному аккаунту. Instagram принимает сообщения через вебхуки Meta."}
                    </p>
                  </div>
                </>
              }
              ownerName={ownerName}
              online={online}
              mode={mode}
              sound={notificationSound}
              onSaveOwner={async (name) => {
                await api("/settings", "PUT", { ownerName: name });
                setOwnerName(name);
              }}
              onLogout={localAccess ? undefined : () => setLogoutOpen(true)}
            />
          </Suspense>
        )}
      </main>
      {logoutOpen && (
        <LogoutDialog
          onCancel={() => setLogoutOpen(false)}
          onConfirm={logout}
        />
      )}
    </div>
  );
}
