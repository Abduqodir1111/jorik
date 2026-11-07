import DayAccordion from "./DayAccordion";
import PreviewModal from "./PreviewModal";
import AdvancedExportModal from "./AdvancedExportModal";
import {
  generateDeliveryWorksheet,
  type DeliveryFilter,
  type DeliveryWorksheet,
} from "../shared/delivery-export";
import CompactOrderForm from "./CompactOrderForm";
import { customerOrderHistory } from "../shared/order-form";
import OrderCard from "./OrderCard";
import { coalesceAsync } from "./refresh-queue";
import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import {
  Plus,
  X,
  Download,
  Package,
  Eye,
  SlidersHorizontal,
} from "lucide-react";
import { localDate, type Order, type OrderInput } from "../shared/orders";
import type { Account, Conversation } from "../shared/types";
import { exportToExcel, downloadDelivery } from "./orders-export";
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
  closeRequest,
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
  closeRequest: number;
  onCloseRequest: () => void;
  onPanelChange: (open: boolean) => void;
}) {
  const [orders, setOrders] = useState<Order[]>([]),
    [form, setForm] = useState<OrderInput | null>(null),
    [editing, setEditing] = useState<Order | null>(null);
  const [formContext, setFormContext] = useState<OrderContext | undefined>();
  const [dayOpen, setDayOpen] = useState<Record<string, boolean>>({});
  const [preview, setPreview] = useState<{
    sheet: DeliveryWorksheet;
    filter: DeliveryFilter;
  } | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [exportDay, setExportDay] = useState<string | null>(null);
  const exportLock = useRef(false);
  const [ordersLoaded, setOrdersLoaded] = useState(false);
  const autoPhone = useRef(false);
  const [amount, setAmount] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [history, setHistory] = useState(false);
  const historyDialog = useRef<HTMLDialogElement>(null),
    currentRequest = useRef(0);
  const load = useCallback(async () => {
    try {
      const data = await request<Order[]>("");
      setOrders((old) =>
        JSON.stringify(old) === JSON.stringify(data) ? old : data,
      );
      setOrdersLoaded(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    if (!visible && !form) return;
    let active = true;
    const update = coalesceAsync(async () => {
      if (active) await load();
    });
    void update();
    const changed = () => void update();
    window.addEventListener("jorik:orders-changed", changed);
    return () => {
      active = false;
      window.removeEventListener("jorik:orders-changed", changed);
    };
  }, [visible, !!form, load]);
  const open = useCallback(
    (order?: Order, ctx?: OrderContext) => {
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
    },
    [!!form, conversations, accounts],
  );
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
  useEffect(() => {
    if (closeRequest) close();
  }, [closeRequest]);
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
  const phoneHistory = useMemo(
    () => customerOrderHistory(orders, form?.phone ?? "", editing?.id),
    [orders, form?.phone, editing?.id],
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
    (form.deliveryType !== "delivery" || !!form.district);
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
  const modify = useCallback(
    async (o: Order, kind: "delete" | "refuse") => {
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
    },
    [busy, load],
  );
  const refuseOrder = useCallback(
    (order: Order) => void modify(order, "refuse"),
    [modify],
  );
  const deleteOrder = useCallback(
    (order: Order) => void modify(order, "delete"),
    [modify],
  );
  const groups = useMemo(() => {
    const map = new Map<string, Order[]>();
    for (const order of orders) {
      const list = map.get(order.date) || [];
      list.push(order);
      map.set(order.date, list);
    }
    return [...map]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([day, items]) => ({
        day,
        items,
        sheet: generateDeliveryWorksheet(items),
      }));
  }, [orders]);
  async function exportDayFile(day: string) {
    if (exportLock.current) return;
    exportLock.current = true;
    setExportDay(day);
    try {
      await exportToExcel(orders, day);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка экспорта");
    } finally {
      exportLock.current = false;
      setExportDay(null);
    }
  }
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
              <p>Доставка, самовывоз и почта · Storebooks и Mangastore</p>
            </div>
            <div className="orders-heading-actions">
              <button onClick={() => setAdvanced(true)}>
                <SlidersHorizontal size={16} />
                Расширенный экспорт
              </button>
              <button className="primary" onClick={() => open()}>
                <Plus size={18} />
                Заказ
              </button>
            </div>
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
          {groups.map(({ day, items, sheet }, index) => (
            <DayAccordion
              key={day}
              title={groupTitle(day)}
              count={items.length}
              open={dayOpen[day] ?? index < 3}
              onToggle={() =>
                setDayOpen((old) => ({
                  ...old,
                  [day]: !(old[day] ?? index < 3),
                }))
              }
              actions={
                <>
                  <button
                    aria-label={`Предпросмотр доставок ${day}`}
                    disabled={!sheet.rows.length}
                    onClick={() =>
                      setPreview({
                        sheet,
                        filter: { startDate: day, endDate: day, source: "ALL" },
                      })
                    }
                  >
                    <Eye size={16} />
                    Предпросмотр
                  </button>
                  <button
                    aria-label={`Скачать Excel для курьера ${day}`}
                    disabled={!sheet.rows.length || exportDay !== null}
                    onClick={() => void exportDayFile(day)}
                  >
                    <Download size={16} />
                    {exportDay === day ? "Подготовка…" : "Excel"}
                  </button>
                </>
              }
            >
              <div
                className="orders-grid"
                role="list"
                aria-label={`Заказы на ${groupTitle(day)}`}
              >
                {items.map((o) => (
                  <OrderCard
                    key={o.id}
                    order={o}
                    busy={busy}
                    onEdit={open}
                    onRefuse={refuseOrder}
                    onDelete={deleteOrder}
                  />
                ))}
              </div>
            </DayAccordion>
          ))}
        </section>
      )}
      {advanced && (
        <AdvancedExportModal
          onClose={() => setAdvanced(false)}
          onResult={async (data, filter) => {
            const sheet = generateDeliveryWorksheet(data, filter);
            if (sheet.rows.length) await downloadDelivery(sheet, filter);
            setAdvanced(false);
            setPreview({ sheet, filter });
          }}
        />
      )}
      {preview && (
        <PreviewModal
          sheet={preview.sheet}
          filter={preview.filter}
          onClose={() => setPreview(null)}
        />
      )}
      {form && (
        <aside
          className={
            "order-drawer compact-order-drawer " +
            (form.deliveryType !== "delivery" ? "is-pickup" : "is-delivery")
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
              {o.deliveryType === "pickup"
                ? "Самовывоз"
                : o.deliveryType === "mail"
                  ? "Почта"
                  : o.district}
            </small>
          </article>
        ))}
      </dialog>
    </>
  );
}
