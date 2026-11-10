import type { Order } from "./orders.js";
import {
  reportPhone,
  type DeliveryFilter,
  type DeliveryWorksheet,
} from "./delivery-export.js";
export interface OrderReport extends DeliveryWorksheet {
  kind: "orders";
  summary: DeliveryWorksheet;
}
export function isOrderReport(sheet: DeliveryWorksheet): sheet is OrderReport {
  return "kind" in sheet && sheet.kind === "orders";
}
const types = { delivery: "Доставка", pickup: "Самовывоз", mail: "Почта" };
export function generateOrderReport(
  orders: Order[],
  filter: DeliveryFilter,
): OrderReport {
  const selected = orders
    .filter(
      (o) =>
        o.date >= filter.startDate &&
        o.date <= filter.endDate &&
        (filter.source === "ALL" ||
          o.source.trim().toUpperCase() === filter.source),
    )
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) ||
        b.createdAt.localeCompare(a.createdAt) ||
        a.id.localeCompare(b.id),
    );
  const groups = new Map<
    string,
    { source: string; type: string; values: number[] }
  >();
  const total = [0, 0, 0, 0, 0, 0];
  for (const o of selected) {
    const source = o.source.trim().toUpperCase(),
      type = types[o.deliveryType];
    const key = JSON.stringify([source, type]);
    const group = groups.get(key) || {
      source,
      type,
      values: [0, 0, 0, 0, 0, 0],
    };
    const amount = Math.round(o.amount * 100);
    const delta = [
      1,
      o.refused ? 0 : 1,
      o.refused ? 1 : 0,
      o.refused ? 0 : amount,
      !o.refused && o.isPaid ? amount : 0,
      !o.refused && !o.isPaid ? amount : 0,
    ];
    delta.forEach((n, i) => {
      group.values[i] += n;
      total[i] += n;
      if (
        !Number.isSafeInteger(total[i]) ||
        !Number.isSafeInteger(group.values[i])
      )
        throw Error(
          "Сумма отчёта слишком большая для точного расчёта. Выберите меньший период.",
        );
    });
    groups.set(key, group);
  }
  const money = (values: number[]) =>
    values.map((v, i) => (i < 3 ? v : v / 100));
  return {
    kind: "orders",
    headers: [
      "ID заказа",
      "Дата заказа",
      "Магазин",
      "Тип получения",
      "Статус заказа",
      "Клиент",
      "Телефон",
      "Дополнительный телефон",
      "Состав заказа",
      "Сумма заказа, сум",
      "Оплата",
      "Учтено в итогах, сум",
      "Отмечено оплаченными, сум",
      "К оплате, сум",
      "Район",
      "Адрес",
      "Геолокация",
      "Создан",
      "Обновлён",
    ],
    widths: [
      38, 15, 18, 16, 18, 24, 18, 22, 50, 20, 18, 22, 27, 20, 22, 40, 35, 26,
      26,
    ],
    rows: selected.map((o) => [
      o.id,
      o.date,
      o.source,
      types[o.deliveryType],
      o.refused ? "Отменён" : "Действующий",
      o.client,
      reportPhone(o.phone),
      reportPhone(o.additionalPhone),
      o.items,
      o.amount,
      o.isPaid ? "Оплачено" : "Не оплачено",
      o.refused ? 0 : o.amount,
      !o.refused && o.isPaid ? o.amount : 0,
      !o.refused && !o.isPaid ? o.amount : 0,
      o.district,
      o.address,
      o.coordinates,
      o.createdAt,
      o.updatedAt,
    ]),
    summary: {
      headers: [
        "Магазин",
        "Тип получения",
        "Всего заказов",
        "Действующие",
        "Отменено",
        "Сумма действующих, сум",
        "Отмечено оплаченными, сум",
        "К оплате, сум",
      ],
      widths: [22, 20, 18, 18, 16, 27, 30, 24],
      rows: [
        ...Array.from(groups.values())
          .sort(
            (a, b) =>
              a.source.localeCompare(b.source) || a.type.localeCompare(b.type),
          )
          .map((g) => [g.source, g.type, ...money(g.values)]),
        ["ИТОГО", "Все типы", ...money(total)],
      ],
    },
  };
}
export function orderReportFilename(filter: DeliveryFilter) {
  return `Заказы_${filter.source === "ALL" ? "Все" : filter.source}_${filter.startDate}-${filter.endDate}.xlsx`;
}
