import { memo } from "react";
import {
  Ban,
  Mail,
  MapPin,
  Package,
  Pencil,
  Phone,
  Trash2,
  Truck,
} from "lucide-react";
import type { Order } from "../shared/orders";
import StoreBadge from "./StoreBadge";

type Props = {
  order: Order;
  busy: boolean;
  onEdit: (order: Order) => void;
  onRefuse: (order: Order) => void;
  onDelete: (order: Order) => void;
};
export default memo(function OrderCard({
  order,
  busy,
  onEdit,
  onRefuse,
  onDelete,
}: Props) {
  const phone = order.phone.replace(
    /^\+998(\d{2})(\d{3})(\d{2})(\d{2})$/,
    "+998 ($1) $2-$3-$4",
  );
  const type =
    order.deliveryType === "mail"
      ? "Почта"
      : order.deliveryType === "pickup"
        ? "Самовывоз"
        : "Доставка";
  const Icon =
    order.deliveryType === "mail"
      ? Mail
      : order.deliveryType === "pickup"
        ? Package
        : Truck;
  return (
    <article
      role="listitem"
      className={`order-card ${order.refused ? "order-refused" : order.isPaid ? "order-paid" : ""}`}
      aria-labelledby={`order-client-${order.id}`}
    >
      <header className="order-card-header">
        <div className="order-card-client">
          <h3 id={`order-client-${order.id}`}>{order.client}</h3>
          <StoreBadge name={order.source} />
          {order.refused && <span className="order-tag refused">Отказ</span>}
        </div>
        <div
          className="order-actions"
          role="group"
          aria-label={`Действия с заказом ${order.client}`}
        >
          <button
            title="Редактировать заказ"
            aria-label="Редактировать заказ"
            onClick={() => onEdit(order)}
          >
            <Pencil size={16} />
          </button>
          <button
            disabled={busy}
            title={order.refused ? "Вернуть заказ" : "Отказ"}
            aria-label={order.refused ? "Вернуть заказ" : "Отказ"}
            onClick={() => onRefuse(order)}
          >
            <Ban size={16} />
          </button>
          <button
            disabled={busy}
            title="Удалить заказ"
            aria-label="Удалить заказ"
            onClick={() => onDelete(order)}
          >
            <Trash2 size={16} />
          </button>
        </div>
      </header>
      <div className="order-card-contact">
        <a href={`tel:${order.phone}`}>
          <Phone size={14} aria-hidden="true" />
          {phone}
        </a>
        <div className="order-card-logistics">
          <span className="order-card-type">
            <Icon size={14} aria-hidden="true" />
            {type}
          </span>
          {order.deliveryType === "delivery" && (
            <>
              <p>
                {[order.district, order.address].filter(Boolean).join(", ") ||
                  "Адрес не указан"}
              </p>
              {order.coordinates && (
                <small>
                  <MapPin size={13} aria-hidden="true" />
                  {order.coordinates}
                </small>
              )}
            </>
          )}
        </div>
      </div>
      <div className="order-card-items">
        <span>Состав заказа</span>
        <p className="order-items">{order.items}</p>
      </div>
      <footer className="order-card-footer">
        <strong className="order-money">
          {order.amount.toLocaleString("ru-RU")} <small>сум</small>
        </strong>
        <span className={`order-tag ${order.isPaid ? "paid" : "unpaid"}`}>
          {order.isPaid ? "Оплачено" : "Не оплачено"}
        </span>
      </footer>
    </article>
  );
});
