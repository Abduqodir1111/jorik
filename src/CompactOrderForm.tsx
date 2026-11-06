import { useLayoutEffect, useRef, useState } from "react";
import {
  Check,
  ClipboardPaste,
  ExternalLink,
  MapPin,
  Package,
  Sparkles,
  X,
  Zap,
} from "lucide-react";
import {
  districts,
  manualSources,
  type Order,
  type OrderInput,
} from "../shared/orders";
import { recentDeliveryAddress } from "../shared/order-form";
import type { OrderContext } from "./Orders";
import PlatformIcon from "./PlatformIcon";
import StoreBadge from "./StoreBadge";
import OrderPhone from "./OrderPhone";

type Props = {
  value: OrderInput;
  context?: OrderContext;
  amount: string;
  onAmount: (v: string) => void;
  onChange: (patch: Partial<OrderInput>) => void;
  history: Order[];
  onHistory: () => void;
  editing: boolean;
  busy: boolean;
  valid: boolean;
  error: string;
  onSave: () => void;
  onCancel: () => void;
};
export default function CompactOrderForm({
  value: f,
  context,
  amount,
  onAmount,
  onChange,
  history,
  onHistory,
  editing,
  busy,
  valid,
  error,
  onSave,
  onCancel,
}: Props) {
  const [phoneTouched, setPhoneTouched] = useState(false),
    [pasteError, setPasteError] = useState("");
  const items = useRef<HTMLTextAreaElement>(null);
  const resize = () => {
    const el = items.current;
    if (el) {
      el.style.height = "0px";
      el.style.height = Math.min(124, Math.max(50, el.scrollHeight + 2)) + "px";
    }
  };
  useLayoutEffect(resize, [f.items]);
  const address = recentDeliveryAddress(history);
  const platform = context?.account.platform;
  const username = context?.conversation.username?.replace(/^@/, "");
  const href =
    username && /^[A-Za-z0-9_.]+$/.test(username) && platform
      ? (platform === "telegram"
          ? "https://t.me/"
          : "https://www.instagram.com/") + encodeURIComponent(username)
      : undefined;
  const phoneInvalid = phoneTouched && !/^\+998\d{9}$/.test(f.phone);
  const total =
    Number(amount) > 0 ? Number(amount).toLocaleString("ru-RU") : "";
  return (
    <form
      className="compact-order-form"
      onSubmit={(e) => {
        e.preventDefault();
        setPhoneTouched(true);
        onSave();
      }}
    >
      <div className="sheet-handle" aria-hidden="true" />
      <header>
        <div>
          <span className="eyebrow">
            {editing
              ? "РЕДАКТИРОВАНИЕ"
              : f.conversationId
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
          onClick={onCancel}
        >
          <X size={19} />
        </button>
      </header>
      {error && (
        <p role="alert" className="orders-error">
          {error}
        </p>
      )}
      {f.conversationId ? (
        <div className="order-identity">
          <span className={"identity-platform " + (platform ?? "offline")}>
            {platform ? (
              <PlatformIcon platform={platform} />
            ) : (
              <Package size={15} />
            )}
          </span>
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              title={
                platform === "telegram"
                  ? "Открыть чат в Telegram"
                  : "Открыть профиль в Instagram"
              }
            >
              @{username}
              <ExternalLink size={12} />
            </a>
          ) : (
            <span className="identity-unknown">
              {username ? "@" + username : "Никнейм недоступен"}
            </span>
          )}
          <StoreBadge name={f.source} color={context?.account.color} />
        </div>
      ) : (
        <div className="compact-grid manual-identity">
          <label>
            Клиент
            <input
              required
              maxLength={160}
              value={f.client}
              onChange={(e) => onChange({ client: e.target.value })}
              placeholder="Имя или никнейм"
            />
          </label>
          <label>
            Источник
            <select
              value={f.source}
              onChange={(e) => onChange({ source: e.target.value })}
            >
              {manualSources.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
        </div>
      )}
      <div className="compact-grid order-date-type">
        <label>
          Дата
          <input
            type="date"
            required
            value={f.date}
            onChange={(e) => onChange({ date: e.target.value })}
          />
        </label>
        <div className="compact-field">
          <span id="delivery-type-label">Тип получения</span>
          <div
            className="type-segments"
            role="group"
            aria-labelledby="delivery-type-label"
          >
            {(["delivery", "pickup", "mail"] as const).map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={f.deliveryType === t}
                onClick={() => onChange({ deliveryType: t })}
              >
                {t === "delivery" ? "Доставка" : t === "mail" ? "Почта" : "Самовывоз"}
              </button>
            ))}
          </div>
        </div>
      </div>
      <label className="compact-phone-label">
        Телефон <span className="required">*</span>
        <OrderPhone
          value={f.phone}
          onChange={(phone) => onChange({ phone })}
          invalid={phoneInvalid}
          onBlur={() => setPhoneTouched(true)}
        />
      </label>
      {phoneInvalid && (
        <small className="orders-error" id="order-phone-error">
          Введите 9 цифр после +998
        </small>
      )}
      {history.length > 0 && (
        <section className="repeat-customer" aria-label="История клиента">
          <div className="repeat-heading">
            <span>
              <Sparkles size={13} />
              Постоянный клиент · {history.length}
            </span>
            {address && f.deliveryType === "delivery" && (
              <button
                type="button"
                title="Подставить район, адрес и геолокацию из последней доставки"
                onClick={() =>
                  onChange({
                    district: address.district,
                    address: address.address,
                    coordinates: address.coordinates,
                  })
                }
              >
                <Zap size={12} />
                Подставить адрес
              </button>
            )}
          </div>
          <div className="repeat-last">
            <span>
              {history[0].date.split("-").reverse().join(".")} ·{" "}
              {history[0].items}
            </span>
            <b>{history[0].amount.toLocaleString("ru-RU")} сум</b>
          </div>
          <button
            type="button"
            className="all-order-history"
            onClick={onHistory}
          >
            Вся история заказов
          </button>
        </section>
      )}
      {f.deliveryType === "delivery" && (
        <div className="compact-delivery">
          <div className="compact-grid address-grid">
            <label>
              Район <span className="required">*</span>
              <select
                required
                value={f.district}
                onChange={(e) => onChange({ district: e.target.value })}
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
                placeholder="Улица, дом, кв."
                value={f.address}
                onChange={(e) => onChange({ address: e.target.value })}
              />
            </label>
          </div>
          <label>
            Геолокация
            <div className="location-input">
              <MapPin size={14} />
              <input
                aria-label="Геолокация"
                maxLength={2000}
                placeholder="Ссылка на карту или координаты"
                value={f.coordinates}
                onChange={(e) => {
                  setPasteError("");
                  onChange({ coordinates: e.target.value });
                }}
              />
              <button
                type="button"
                aria-label="Вставить геолокацию из буфера"
                title="Вставить из буфера"
                onClick={async () => {
                  try {
                    const text = await navigator.clipboard.readText();
                    if (text.length > 2000) throw Error();
                    onChange({ coordinates: text.trim() });
                    setPasteError("");
                  } catch {
                    setPasteError(
                      "Вставьте ссылку вручную: Ctrl+V или удерживайте поле.",
                    );
                  }
                }}
              >
                <ClipboardPaste size={16} />
              </button>
            </div>
          </label>
          {pasteError && (
            <small role="status" className="clipboard-notice">
              {pasteError}
            </small>
          )}
        </div>
      )}
      <div className="compact-money-row">
        <label>
          Сумма заказа <span className="required">*</span>
          <div className="compact-amount">
            <input
              aria-label="Сумма заказа"
              type="number"
              inputMode="decimal"
              min="0.01"
              max="1000000000000"
              step="0.01"
              required
              placeholder="0"
              value={amount}
              onChange={(e) => onAmount(e.target.value)}
            />
            <span>сум</span>
          </div>
        </label>
        <button
          type="button"
          className={"payment-toggle " + (f.isPaid ? "paid" : "")}
          aria-pressed={f.isPaid}
          onClick={() => onChange({ isPaid: !f.isPaid })}
        >
          {f.isPaid && <Check size={14} aria-hidden="true" />}
          Оплачено
        </button>
      </div>
      <label className="order-items-field">
        Состав заказа <span className="required">*</span>
        <textarea
          ref={items}
          required
          rows={2}
          maxLength={10000}
          value={f.items}
          onChange={(e) => onChange({ items: e.target.value })}
          placeholder="Книги, переплёт, количество…"
        />
      </label>
      <footer>
        <button type="button" disabled={busy} onClick={onCancel}>
          Отмена
        </button>
        <button className="primary" disabled={!valid || busy}>
          {busy ? "Сохраняем…" : editing ? "Обновить заказ" : "Создать заказ"}
          {total && !busy && <span>({total} сум)</span>}
        </button>
      </footer>
    </form>
  );
}
