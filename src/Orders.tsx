import StoreBadge from "./StoreBadge";
import { coalesceAsync } from "./refresh-queue";
import { useEffect, useRef, useState } from "react";
import { Plus, Pencil, Trash2, Ban, X, Download, Package } from "lucide-react";
import {
  districts,
  manualSources,
  localDate,
  courierRows,
  type Order,
  type OrderInput,
} from "../shared/orders";
import type { Account, Conversation } from "../shared/types";
import { exportToExcel } from "./orders-export";
async function request<T>(
  route: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const r = await fetch("/api/orders" + route, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Не удалось сохранить заказ");
  return data;
}
export type OrderContext = { conversation: Conversation; account: Account };
function blank(context?: OrderContext): OrderInput {
  return {
    conversationId: context?.conversation.id ?? null,
    client: context
      ? context.conversation.username || context.conversation.name
      : "",
    source: context?.account.name ?? "Офлайн",
    date: localDate(),
    phone: "+998",
    deliveryType: "delivery",
    district: "",
    address: "",
    coordinates: "",
    amount: 0,
    isPaid: false,
    items: "",
  };
}
function groupTitle(value: string) {
  const d = new Date(value + "T12:00:00");
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const prefix =
    value === localDate()
      ? "Сегодня, "
      : value === localDate(tomorrow)
        ? "Завтра, "
        : "";
  return (
    prefix +
    d.toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "long",
      year: "numeric",
    })
  );
}
export default function Orders({
  visible,
  context,
  openRequest,
  onCloseRequest,
  onPanelChange,
}: {
  visible: boolean;
  context?: OrderContext;
  openRequest: number;
  onCloseRequest: () => void;
  onPanelChange: (open: boolean) => void;
}) {
  const [orders, setOrders] = useState<Order[]>([]),
    [form, setForm] = useState<OrderInput | null>(null),
    [editing, setEditing] = useState<Order | null>(null);
  const [amount, setAmount] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [history, setHistory] = useState(false);
  const historyDialog = useRef<HTMLDialogElement>(null),
    currentRequest = useRef(0);
  async function load() {
    try {
      setOrders(await request<Order[]>(""));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    if (!visible && !form) return;
    let active = true;
    const update = coalesceAsync(async () => {
      if (active) await load();
    });
    void update();
    const events = new EventSource("/api/events");
    events.onmessage = () => void update();
    return () => {
      active = false;
      events.close();
    };
  }, [visible, !!form]);
  function open(order?: Order, ctx?: OrderContext) {
    if (form) return;
    setEditing(order ?? null);
    setForm(order ? { ...order } : blank(ctx));
    setAmount(order ? String(order.amount) : "");
    setError("");
    setHistory(false);
  }
  useEffect(() => {
    if (openRequest && openRequest !== currentRequest.current) {
      currentRequest.current = openRequest;
      open(undefined, context);
    }
  }, [openRequest, context]);
  useEffect(() => {
    onPanelChange(!!form);
  }, [!!form, onPanelChange]);
  useEffect(() => {
    if (history) historyDialog.current?.showModal();
    else historyDialog.current?.close();
  }, [history]);
  function close() {
    setForm(null);
    setHistory(false);
    onCloseRequest();
  }
  function change<K extends keyof OrderInput>(key: K, value: OrderInput[K]) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }
  const phoneHistory =
    form && /^\+998\d{9}$/.test(form.phone)
      ? orders.filter((o) => o.phone === form.phone && o.id !== editing?.id)
      : [];
  const valid =
    !!form &&
    !!form.client.trim() &&
    /^\+998\d{9}$/.test(form.phone) &&
    !!form.date &&
    amount !== "" &&
    Number.isFinite(Number(amount)) &&
    Number(amount) >= 0 &&
    !!form.items.trim() &&
    (form.deliveryType === "pickup" || !!form.district);
  async function save() {
    if (!valid || !form || busy) return;
    setBusy(true);
    setError("");
    try {
      const {
        conversationId,
        client,
        source,
        date,
        phone,
        deliveryType,
        district,
        address,
        coordinates,
        isPaid,
        items,
      } = form;
      const body: OrderInput = {
        conversationId,
        client,
        source,
        date,
        phone,
        deliveryType,
        district,
        address,
        coordinates,
        isPaid,
        items,
        amount: Number(amount),
      };
      await request(
        editing ? "/" + editing.id : "",
        editing ? "PUT" : "POST",
        body,
      );
      await load();
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function modify(o: Order, kind: "delete" | "refuse") {
    if (busy) return;
    if (
      kind === "delete" &&
      !window.confirm(
        "Удалить заказ безвозвратно? Это действие нельзя отменить.",
      )
    )
      return;
    setBusy(true);
    try {
      await request(
        "/" + o.id + (kind === "refuse" ? "/refused" : ""),
        kind === "delete" ? "DELETE" : "PATCH",
        kind === "refuse" ? { refused: !o.refused } : undefined,
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const dates = [...new Set(orders.map((o) => o.date))].sort().reverse();
  return (
    <>
      {visible && (
        <section className="orders-page page-content">
          <header className="orders-heading">
            <div>
              <span className="eyebrow">МИНИ-CRM</span>
              <h1>
                Заказы <small>{orders.length}</small>
              </h1>
              <p>Доставка и самовывоз · Storebooks и Mangastore</p>
            </div>
            <button className="primary" onClick={() => open()}>
              <Plus size={18} />
              Заказ
            </button>
          </header>
          {error && !form && (
            <p role="alert" className="orders-error">
              {error}
            </p>
          )}
          {!orders.length && (
            <div className="orders-empty">
              <Package size={40} />
              <h2>Здесь будут ваши заказы</h2>
              <p>Оформите заказ из чата или добавьте его вручную.</p>
            </div>
          )}
          {dates.map((day) => (
            <section className="order-group" key={day}>
              <header>
                <h2>{groupTitle(day)}</h2>
                <button
                  aria-label="Скачать Excel для курьера"
                  title="Скачать Excel для курьера"
                  disabled={!courierRows(orders, day).length}
                  onClick={() =>
                    void exportToExcel(orders, day).catch((e) =>
                      setError(e.message),
                    )
                  }
                >
                  <Download size={16} />
                  Excel
                </button>
              </header>
              <div className="orders-table-wrap">
                <table className="orders-table">
                  <thead>
                    <tr>
                      {[
                        "Клиент / источник",
                        "Телефон",
                        "Получение",
                        "Сумма",
                        "Заказ",
                        "Действия",
                      ].map((h) => (
                        <th key={h}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {orders
                      .filter((o) => o.date === day)
                      .map((o) => (
                        <tr
                          key={o.id}
                          className={
                            o.refused
                              ? "order-refused"
                              : o.isPaid
                                ? "order-paid"
                                : ""
                          }
                        >
                          <td>
                            <strong>{o.client}</strong>
                            <StoreBadge name={o.source}/>
                            {o.refused && (
                              <span className="order-tag refused">Отказ</span>
                            )}
                          </td>
                          <td className="order-phone-text">{o.phone.replace(/^\+998(\d{2})(\d{3})(\d{2})(\d{2})$/, "+998 ($1) $2-$3-$4")}</td>
                          <td>
                            {o.deliveryType === "pickup" ? (
                              <span className="order-tag pickup">
                                САМОВЫВОЗ
                              </span>
                            ) : (
                              <>
                                <strong>{o.district}</strong>
                                <small>{o.address || "Адрес не указан"}</small>
                                {o.coordinates && (
                                  <small>{o.coordinates}</small>
                                )}
                              </>
                            )}
                          </td>
                          <td className="order-money">
                            {o.amount.toLocaleString("ru-RU")} сум
                            {o.isPaid && (
                              <span className="order-tag paid">Оплачено</span>
                            )}
                          </td>
                          <td className="order-items">{o.items}</td>
                          <td>
                            <div className="order-actions">
                              <button
                                title="Редактировать заказ"
                                aria-label="Редактировать заказ"
                                onClick={() => open(o)}
                              >
                                <Pencil size={17} />
                              </button>
                              <button
                                disabled={busy}
                                title={o.refused ? "Вернуть заказ" : "Отказ"}
                                aria-label={
                                  o.refused ? "Вернуть заказ" : "Отказ"
                                }
                                onClick={() => void modify(o, "refuse")}
                              >
                                <Ban size={17} />
                              </button>
                              <button
                                disabled={busy}
                                title="Удалить заказ"
                                aria-label="Удалить заказ"
                                onClick={() => void modify(o, "delete")}
                              >
                                <Trash2 size={17} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </section>
      )}
      {form && (
        <aside className="order-drawer" aria-label="Оформление заказа">
          {form && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <header>
                <div>
                  <span className="eyebrow">
                    {editing
                      ? "РЕДАКТИРОВАНИЕ"
                      : form.conversationId
                        ? "ИЗ ДИАЛОГА"
                        : "РУЧНОЙ ПРИЁМ"}
                  </span>
                  <h2>{editing ? "Редактировать заказ" : "Новый заказ"}</h2>
                </div>
                <button
                  type="button"
                  className="icon"
                  aria-label="Закрыть заказ"
                  disabled={busy}
                  onClick={close}
                >
                  <X size={21} />
                </button>
              </header>
              {error && (
                <p role="alert" className="orders-error">
                  {error}
                </p>
              )}
              <label>
                Дата
                <input
                  type="date"
                  required
                  value={form.date}
                  onChange={(e) => change("date", e.target.value)}
                />
              </label>
              <div className="order-fields">
                <label>
                  Клиент
                  <input
                    required
                    readOnly={!!form.conversationId}
                    maxLength={160}
                    value={form.client}
                    onChange={(e) => change("client", e.target.value)}
                    placeholder="Имя клиента"
                  />
                </label>
                <label>
                  Источник
                  {form.conversationId ? (
                    <input readOnly value={form.source} />
                  ) : (
                    <select
                      value={form.source}
                      onChange={(e) => change("source", e.target.value)}
                    >
                      {manualSources.map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  )}
                </label>
              </div>
              <label>
                Телефон <span className="required">*</span>
                <div
                  className={
                    "order-phone " +
                    (!/^\+998\d{9}$/.test(form.phone) ? "invalid" : "")
                  }
                >
                  <span>+998</span>
                  <input
                    aria-label="Телефон — 9 цифр"
                    inputMode="numeric"
                    autoComplete="tel-national"
                    placeholder="90 123 45 67"
                    value={form.phone.slice(4)}
                    onChange={(e) => {
                      let n = e.target.value.replace(/\D/g, "");
                      if (n.length === 12 && n.startsWith("998"))
                        n = n.slice(3);
                      change("phone", "+998" + n.slice(0, 9));
                    }}
                  />
                </div>
              </label>
              {!/^\+998\d{9}$/.test(form.phone) && (
                <small className="orders-error">
                  Введите ровно 9 цифр после +998
                </small>
              )}
              {!!phoneHistory.length && (
                <button
                  type="button"
                  className="history-button"
                  onClick={() => setHistory(true)}
                >
                  Показать историю · {phoneHistory.length}
                </button>
              )}
              <fieldset>
                <legend>Тип получения</legend>
                <div className="delivery-options">
                  {(["delivery", "pickup"] as const).map((t) => (
                    <label key={t}>
                      <input
                        type="radio"
                        name="deliveryType"
                        checked={form.deliveryType === t}
                        onChange={() => change("deliveryType", t)}
                      />
                      {t === "delivery" ? "Доставка" : "Самовывоз"}
                    </label>
                  ))}
                </div>
              </fieldset>
              {form.deliveryType === "delivery" && (
                <>
                  <label>
                    Район <span className="required">*</span>
                    <select
                      required
                      value={form.district}
                      onChange={(e) => change("district", e.target.value)}
                    >
                      <option value="">Выберите район</option>
                      {districts.map((d) => (
                        <option key={d}>{d}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Адрес
                    <input
                      maxLength={2000}
                      value={form.address}
                      onChange={(e) => change("address", e.target.value)}
                    />
                  </label>
                  <label>
                    Координаты / ссылка на геолокацию
                    <input
                      maxLength={2000}
                      value={form.coordinates}
                      onChange={(e) => change("coordinates", e.target.value)}
                    />
                  </label>
                </>
              )}
              <div className="order-fields">
                <label>
                  Сумма заказа, сум <span className="required">*</span>
                  <input
                    type="number"
                    min="0"
                    max="1000000000000"
                    step="0.01"
                    required
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </label>
                <label className="order-payment">
                  <input
                    type="checkbox"
                    checked={form.isPaid}
                    onChange={(e) => change("isPaid", e.target.checked)}
                  />
                  Оплачено
                </label>
              </div>
              <label>
                Заказ <span className="required">*</span>
                <textarea
                  required
                  maxLength={10000}
                  rows={5}
                  value={form.items}
                  onChange={(e) => change("items", e.target.value)}
                  placeholder="Книги, переплёт, количество…"
                />
              </label>
              <footer>
                <button type="button" disabled={busy} onClick={close}>
                  Отмена
                </button>
                <button className="primary" disabled={!valid || busy}>
                  {busy
                    ? "Сохраняем…"
                    : editing
                      ? "Обновить заказ"
                      : "Сохранить заказ"}
                </button>
              </footer>
            </form>
          )}
        </aside>
      )}
      <dialog
        ref={historyDialog}
        className="order-history"
        onCancel={() => setHistory(false)}
      >
        <header>
          <h2>История · {form?.phone}</h2>
          <button
            className="icon"
            aria-label="Закрыть историю"
            onClick={() => setHistory(false)}
          >
            <X />
          </button>
        </header>
        {phoneHistory.map((o) => (
          <article key={o.id}>
            <strong>
              {groupTitle(o.date)} · {o.source}
            </strong>
            <p>{o.items}</p>
            <small>
              {o.amount.toLocaleString("ru-RU")} сум ·{" "}
              {o.refused ? "Отказ" : o.isPaid ? "Оплачено" : "Не оплачено"} ·{" "}
              {o.deliveryType === "pickup" ? "Самовывоз" : o.district}
            </small>
          </article>
        ))}
      </dialog>
    </>
  );
}
