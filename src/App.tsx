import LogoutDialog from "./LogoutDialog";
import StoreBadge from "./StoreBadge";
import Orders, { type OrderContext } from "./Orders";
import { useNotificationSound } from "./NotificationSound";
import { QuickReplySettings, useOperator } from "./OperatorContext";
import { ChatCache } from "./chat-cache";
import PlatformIcon from "./PlatformIcon";
import AccountName from "./AccountName";
import { recentConversations } from "../shared/inbox";
import TelegramConnect from "./TelegramConnect";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Avatar from "./Avatar";
import ConversationRow from "./ConversationRow";
import MessageTimeline from "./MessageTimeline";
import { time, date } from "./message-format";
import { coalesceAsync } from "./refresh-queue";
import {
  Package,
  MessageSquare,
  Send,
  Search,
  Settings,
  Users,
  ArrowLeft,
  Info,
  LogOut,
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
  Maximize2,
  Minimize2,
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
  const { slots, hydrate, dark, toggleTheme, fontSize, setFontSize } =
    useOperator();
  const [orderContext, setOrderContext] = useState<OrderContext | undefined>();
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [orderRequest, setOrderRequest] = useState(0);
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

  const [auth, setAuth] = useState(false),
    [configured, setConfigured] = useState(true),
    [mode, setMode] = useState<Mode>("demo"),
    [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showAllChats, setShowAllChats] = useState(false);
  const [rememberLogin, setRememberLogin] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]),
    [conversations, setConversations] = useState<Conversation[]>([]),
    [messages, setMessages] = useState<Message[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [page, setPage] = useState("inbox");
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
  const historyRequests = useRef(new Map<string, Promise<void>>());
  const syncRequests = useRef(new Map<string, Promise<void>>());
  const followLatest = useRef(true);
  const chatScrollTop = useRef(0);
  selectedRef.current = selected;
  const unsaved = useRef(new Map<string, { text: string; revision: number }>()),
    draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    revisionCounter = useRef(0);
  const report = (e: unknown) =>
    setError(e instanceof Error ? e.message : "Не удалось выполнить действие");
  const selectConversation = useCallback((id: string) => {
    setSelected(id);
    setTemplatesOpen(false);
  }, []);
  const replyToMessage = useCallback((message: Message) => {
    setReplyTargets((old) => ({ ...old, [message.conversationId]: message }));
    inputRef.current?.focus();
  }, []);
  const [chatExpanded, setChatExpanded] = useState(false);
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
      const ms = await api<Message[]>(`/conversations/${id}/messages`);
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
    events.addEventListener("incoming", () => notificationSound.play());
    events.onopen = () => setOnline(true);
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
  const lastInstagramIncoming =
    a?.adapter === "instagram-graph"
      ? messages.filter((m) => m.direction === "in").at(-1)
      : undefined;
  const instagramWindowClosed =
    a?.adapter === "instagram-graph" &&
    (!lastInstagramIncoming ||
      Date.now() - Date.parse(lastInstagramIncoming.createdAt) >= 86400000);
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
  function insertTemplate(index: number) {
    if (!slots[index]?.text || !selected) return;
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
          setSelected(filtered[next].id);
          setTemplatesOpen(false);
        }
      }
      if (event.ctrlKey && !event.altKey && /^[1-4]$/.test(event.key)) {
        event.preventDefault();
        const slot = slots[Number(event.key) - 1];
        if (slot.text.trim()) void send(slot.text);
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
      className={`app ${orderPanelOpen ? "has-order-panel" : ""} ${page === "inbox" ? "inbox-page" : ""} ${page === "inbox" && selected && chatExpanded ? "chat-expanded" : ""}`}
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
          <MessageSquare size={22} /><span className="rail-label">Чаты</span>
          {conversations.some((c) => c.unread > 0) && (
            <span className="rail-count">
              {conversations.reduce((n, c) => n + c.unread, 0)}
            </span>
          )}
        </button>
        <button
          className={"rail-button " + (page === "accounts" ? "active" : "")}
          aria-label="Аккаунты"
          aria-current={page === "accounts" ? "page" : undefined}
          title="Аккаунты"
          onClick={() => setPage("accounts")}
        >
          <Users size={22} /><span className="rail-label">Каналы</span>
        </button>
        <button
          className={"rail-button " + (page === "orders" ? "active" : "")}
          aria-label="Заказы"
          aria-current={page === "orders" ? "page" : undefined}
          title="Заказы"
          onClick={() => setPage("orders")}
        >
          <Package size={22} /><span className="rail-label">Заказы</span>
        </button>
        <div className="rail-bottom">
          <button
            className={"rail-button " + (page === "settings" ? "active" : "")}
            aria-label="Настройки"
          aria-current={page === "settings" ? "page" : undefined}
            title="Настройки"
            onClick={() => setPage("settings")}
          >
            <Settings size={22} /><span className="rail-label">Настройки</span>
          </button>
          <button
            className="rail-button"
            aria-label={dark ? "Светлая тема" : "Тёмная тема"}
            title={dark ? "Светлая тема" : "Тёмная тема"}
            onClick={toggleTheme}
          >
            {dark ? <Sun size={22} /> : <Moon size={22} />}<span className="rail-label">{dark ? "День" : "Ночь"}</span>
          </button>
          {!localAccess && (
            <button
              className="rail-button logout-button"
              aria-label="Выйти"
              title="Выйти"
              onClick={() => setLogoutOpen(true)}
            >
              <LogOut size={20} />
            </button>
          )}
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
                  : page === "accounts"
                    ? "Аккаунты"
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
              <span className={"list-online " + (online ? "is-online" : "")}><i />{online ? "Онлайн" : "Нет связи"}</span>
            </div>
            <div className="inbox-filters" aria-label="Быстрые фильтры">
              <button aria-pressed={filter === "all" && !unread} onClick={() => {setFilter("all");setUnread(false);}}>Все</button>
              <button className="waiting-filter" aria-pressed={unread} onClick={() => {setFilter("all");setUnread(!unread);}}><i className="waiting-dot" aria-hidden="true"/>Ждут ответа</button>
              <button className="telegram-filter" aria-pressed={filter === "telegram" && !unread} onClick={() => {setFilter("telegram");setUnread(false);}}>Telegram</button>
              <button className="instagram-filter" aria-pressed={filter === "instagram" && !unread} onClick={() => {setFilter("instagram");setUnread(false);}}>Instagram</button>
            </div>
            <div className="search">
              <Search size={17} />
              <input
                aria-label="Поиск диалогов и сообщений"
                placeholder="Поиск диалогов и сообщений"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <button
                role="switch"
                aria-checked={unread}
                aria-label="Только непрочитанные"
                title="Только непрочитанные"
                className={"unread-switch " + (unread ? "on" : "")}
                onClick={() => setUnread((x) => !x)}
              >
                <span />
              </button>
            </div>
            <div className="source-filter">
              <select
                aria-label="Источник сообщений"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="all">Все источники</option>
                <option value="telegram">Telegram</option>
                <option value="instagram">Instagram</option>
                <option value="uzum" disabled>
                  Uzum · не подключён
                </option>
                <optgroup label="Аккаунты">
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </optgroup>
              </select>
              <span>
                {unread ? "Непрочитанные" : filtered.length + " диалогов"}
              </span>
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
              {filtered.map((c, i) => {
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
              {filtered.length === 0 && (
                <div className="empty">
                  <Search />
                  <h3>Диалогов пока нет</h3>
                  <p>
                    {q
                      ? "Попробуйте другой поисковый запрос"
                      : mode === "demo"
                        ? "Добавьте примеры командой npm run seed"
                        : "Для загрузки переписки войдите в Telegram в разделе «Аккаунты»."}
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
                  <Avatar name={c.name} conversationId={c.id} />
                  <div>
                    <h2>{c.name}</h2>
                    <small>
                      <span className={a.platform}>
                        {a.platform === "telegram" ? "Telegram" : "Instagram"}
                      </span>{" "}
                      <span className="middle-dot">·</span>{" "}
                      <StoreBadge name={a.name} color={a.color}/>
                    </small>
                  </div>
                  <button
                    className="icon expand-chat"
                    title={
                      chatExpanded
                        ? "Вернуть список диалогов"
                        : "Развернуть чат"
                    }
                    aria-label={
                      chatExpanded
                        ? "Вернуть список диалогов"
                        : "Развернуть чат"
                    }
                    aria-pressed={chatExpanded}
                    onClick={() => setChatExpanded(!chatExpanded)}
                  >
                    {chatExpanded ? (
                      <Minimize2 size={20} />
                    ) : (
                      <Maximize2 size={20} />
                    )}
                  </button>
                  <button
                    className="icon create-order"
                    title="Создать заказ"
                    aria-label="Создать заказ"
                    onClick={() => {
                      setOrderContext({ conversation: c, account: a });
                      setOrderRequest((x) => x + 1);
                    }}
                  >
                    <Package size={17} /><span>Заказ</span>
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
                    <MessageTimeline
                      messages={messages}
                      platform={a.platform}
                      dismissed={dismissed}
                      setDismissed={setDismissed}
                      onReply={replyToMessage}
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
                    {slots.map((slot, i) => (
                      <button
                        key={i}
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
                          key={i}
                          role="option"
                          aria-selected={templateIndex === i}
                          disabled={!slot.text}
                          className={templateIndex === i ? "selected" : ""}
                          onClick={() => insertTemplate(i)}
                        >
                          <b>{slot.title || `Слот ${i + 1}`}</b>
                          <span>{slot.text || "Не настроен"}</span>
                          <kbd>Ctrl + {i + 1}</kbd>
                        </button>
                      ))}
                    </div>
                  )}
                  {replyTargets[c.id] && (
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
                  {uploads[c.id] && (
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
                  <div className="composer">
                    <textarea
                      ref={inputRef}
                      aria-label="Текст ответа"
                      placeholder="Напишите сообщение…"
                      value={drafts[c.id] ?? ""}
                      disabled={sending}
                      onChange={(e) => {
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
                            setTemplateIndex(
                              (i) => (i + (e.key === "ArrowDown" ? 1 : 3)) % 4,
                            );
                          return;
                        }
                        if (
                          e.key === "Enter" &&
                          !e.shiftKey &&
                          !e.nativeEvent.isComposing
                        ) {
                          e.preventDefault();
                          void send();
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
                        disabled={uploading || sending}
                        onClick={() => fileInput.current?.click()}
                      >
                        <Paperclip size={18} />
                        {uploading ? "Загрузка…" : "Фото"}
                      </button>
                      <button
                        className="send"
                        disabled={
                          sending ||
                          !online ||
                          (!drafts[c.id]?.trim() && !uploads[c.id]) ||
                          uploading ||
                          instagramWindowClosed ||
                          !a.capabilities.text ||
                          a.state !== "connected"
                        }
                        onClick={() => void send()}
                      >
                        {sending ? "В очереди…" : "Отправить"}
                        <Send size={16} />
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
                      1–4 — отправить шаблон
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
                      onClick={() => setPage("accounts")}
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
                onClick={() =>
                  action(() =>
                    api(`/conversations/${c.id}/read`, "POST", {
                      unread: true,
                    }),
                  )
                }
              >
                Отметить непрочитанным
              </button>
              <small>
                Прочтение и ответы синхронизируются с подключёнными аккаунтами; возможности Instagram зависят от событий Meta.
              </small>
            </aside>
          )}
        </div>
        {page === "accounts" && <section className="accounts-page">
          <div className="page-content">
            <>
              <span className="eyebrow">КАНАЛЫ ОБЩЕНИЯ</span>
              <h1>Ваши аккаунты</h1>
              <p className="page-description">
                Каждый ответ отправляется через тот аккаунт, в который написал
                клиент.
              </p>
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
                    <h2 className="account-display-name"><StoreBadge name={a.name} color={a.color}/></h2>
                    <p className="account-platform-label">{a.platform === "telegram" ? "Telegram" : "Instagram"} · {a.state === "connected" ? "Готов к работе" : "Требует внимания"}</p>
                    <details className="account-details"><summary>Настройка подключения</summary>
                    <AccountName account={a} onSaved={refresh} />
                    <p>
                      {a.platform === "telegram" ? "Telegram" : "Instagram"} ·{" "}
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
                        active={page === "accounts"}
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
                          Текстовые ответы — в течение 24 часов после сообщения
                          клиента. Фото и видео открываются в чате; недоступные
                          вложения — в Instagram.
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
                            api(`/demo/accounts/${a.id}/toggle`, "POST", {}),
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
          </div>
        </section>}
        <Orders
          accounts={accounts}
          conversations={conversations}
          visible={page === "orders"}
          context={orderContext}
          openRequest={orderRequest}
          onCloseRequest={() => setOrderContext(undefined)}
          onPanelChange={setOrderPanelOpen}
        />
        {page === "settings" && (
          <div className="page-content settings-page">
            <>
              <span className="eyebrow">ВАШЕ ПРОСТРАНСТВО</span>
              <h1>Настройки</h1>
              <p className="page-description">
                Простой и безопасный рабочий процесс.
              </p>
              <section className="settings-card">
                <h2>Размер текста сообщений</h2>
                <p>Применяется к сообщениям и превью в списке чатов.</p>
                <div className="font-options">
                  {([14, 16, 18] as const).map((size, i) => (
                    <button
                      key={size}
                      aria-pressed={fontSize === size}
                      className={fontSize === size ? "active" : ""}
                      onClick={() => setFontSize(size)}
                    >
                      {["Маленький", "Средний", "Крупный"][i]}
                    </button>
                  ))}
                </div>
              </section>
              {notificationSound.settings}
              <QuickReplySettings />
              <section className="settings-card">
                <h2>Профиль владельца</h2>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    action(() =>
                      api("/settings", "PUT", { ownerName: f.get("name") }),
                    );
                  }}
                >
                  <label>
                    Отображаемое имя
                    <input
                      name="name"
                      defaultValue={ownerName}
                      required
                      maxLength={80}
                    />
                  </label>
                  <button className="primary">Сохранить</button>
                </form>
              </section>
              <section className="settings-card appearance-settings">
                <h2>Оформление</h2><p>Светлая и тёмная тема сохраняются на этом устройстве.</p>
                <button type="button" className="secondary" onClick={toggleTheme}>{dark ? <Sun size={16}/> : <Moon size={16}/>} {dark ? "Светлая тема" : "Тёмная тема"}</button>
                {!localAccess && <button type="button" className="secondary" onClick={() => setLogoutOpen(true)}><LogOut size={16}/> Выйти из Jorik</button>}
              </section>
              <section className="settings-card">
                <h2>Хранение и безопасность</h2>
                <p>
                  История, заказы и черновики сохраняются на сервере Jorik. Режим:{" "}
                  <b>{mode === "demo" ? "демонстрационный" : "реальный"}</b>.
                </p>
                <p>Быстрые ответы доступны на всех устройствах. Тема, размер текста и звук сохраняются в этом браузере.</p>
                <small>
                  Приём сообщений работает на сервере независимо от этого устройства.
                </small>
              </section>
              {mode === "demo" && (
                <section className="settings-card">
                  <h2>Проверка демонстрации</h2>
                  <p>
                    Нажмите «Тестовое входящее» в диалоге. Для ошибки отправьте{" "}
                    <code>[ошибка]</code>, для неоднозначного результата —{" "}
                    <code>[неизвестно]</code>. Потеря связи моделируется в
                    разделе «Аккаунты».
                  </p>
                </section>
              )}
            </>
          </div>
        )}
      </main>
      {logoutOpen && <LogoutDialog onCancel={() => setLogoutOpen(false)} onConfirm={logout}/>}
    </div>
  );
}
