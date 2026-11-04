import CompactOrderForm from "./CompactOrderForm";
import { customerOrderHistory } from "../shared/order-form";
import StoreBadge from "./StoreBadge";
import { coalesceAsync } from "./refresh-queue";
import { useEffect, useRef, useState } from "react";
import { Plus, Pencil, Trash2, Ban, X, Download, Package } from "lucide-react";
import {
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
  accounts,
  conversations,
}: {
  visible: boolean;
  accounts: Account[];
  conversations: Conversation[];
  context?: OrderContext;
  openRequest: number;
  onCloseRequest: () => void;
  onPanelChange: (open: boolean) => void;
}) {
  const [orders, setOrders] = useState<Order[]>([]),
    [form, setForm] = useState<OrderInput | null>(null),
    [editing, setEditing] = useState<Order | null>(null);
  const [formContext, setFormContext] = useState<OrderContext | undefined>();
  const [ordersLoaded, setOrdersLoaded] = useState(false);
  const autoPhone = useRef(false);
  const [amount, setAmount] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [history, setHistory] = useState(false);
  const historyDialog = useRef<HTMLDialogElement>(null),
    currentRequest = useRef(0);
  async function load() {
    try {
      setOrders(await request<Order[]>(""));
      setOrdersLoaded(true);
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
    autoPhone.current = false;
    const linked = order?.conversationId
      ? conversations.find((c) => c.id === order.conversationId)
      : undefined;
    const account = linked
      ? accounts.find((a) => a.id === linked.accountId)
      : undefined;
    setFormContext(
      ctx ??
        (linked && account ? { conversation: linked, account } : undefined),
    );
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
  useEffect(() => {
    if (!form?.conversationId || editing || !ordersLoaded || autoPhone.current)
      return;
    autoPhone.current = true;
    const previous = orders.find(
      (o) => !o.refused && o.conversationId === form.conversationId,
    );
    if (previous)
      setForm((f) =>
        f && f.conversationId === previous.conversationId && f.phone === "+998"
          ? { ...f, phone: previous.phone }
          : f,
      );
  }, [form?.conversationId, editing, ordersLoaded, orders]);
  const phoneHistory = customerOrderHistory(
    orders,
    form?.phone ?? "",
    editing?.id,
  );
  const valid =
    !!form &&
    !!form.client.trim() &&
    /^\+998\d{9}$/.test(form.phone) &&
    !!form.date &&
    amount !== "" &&
    Number.isFinite(Number(amount)) &&
    Number(amount) > 0 &&
    Number(amount) <= 1e12 &&
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
                            <StoreBadge name={o.source} />
                            {o.refused && (
                              <span className="order-tag refused">Отказ</span>
                            )}
                          </td>
                          <td className="order-phone-text">
                            {o.phone.replace(
                              /^\+998(\d{2})(\d{3})(\d{2})(\d{2})$/,
                              "+998 ($1) $2-$3-$4",
                            )}
                          </td>
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
        <aside
          className={
            "order-drawer compact-order-drawer " +
            (form.deliveryType === "pickup" ? "is-pickup" : "is-delivery")
          }
          aria-label="Оформление заказа"
        >
          <CompactOrderForm
            value={form}
            context={formContext}
            amount={amount}
            onAmount={setAmount}
            onChange={(patch) => setForm((f) => (f ? { ...f, ...patch } : f))}
            history={phoneHistory}
            onHistory={() => setHistory(true)}
            editing={!!editing}
            busy={busy}
            valid={valid}
            error={error}
            onSave={() => void save()}
            onCancel={close}
          />
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
