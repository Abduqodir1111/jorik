import type { Order } from "./orders.js";
export const courierHeaders = [
  "Клиент",
  "Книга",
  "Телефон",
  "Оплата",
  "Район",
  "Адрес",
  "Кординаты",
  "Статус",
];
export type DeliverySource = "ALL" | "STOREBOOKS" | "MANGASTORE";
export type DeliveryFilter = {
  startDate: string;
  endDate: string;
  source: DeliverySource;
};
export type DeliveryWorksheet = {
  headers: string[];
  rows: (string | number)[][];
  widths: number[];
};
/** One column mapping for XLSX, preview and TSV; strings remain literal cells. */
export function generateDeliveryWorksheet(
  orders: Order[],
  filter?: DeliveryFilter,
): DeliveryWorksheet {
  const selected = orders.filter(
    (o) =>
      !o.refused &&
      (o.deliveryType === "delivery" || o.deliveryType === "mail") &&
      (!filter ||
        (o.date >= filter.startDate &&
          o.date <= filter.endDate &&
          (filter.source === "ALL" ||
            o.source.trim().toUpperCase() === filter.source))),
  );
  return {
    headers: [...courierHeaders],
    widths: [20, 48, 22, 18, 22, 45, 40, 18],
    rows: selected.map((o) => [
      o.source,
      o.items,
      [o.phone, o.additionalPhone].filter(Boolean).join(", "),
      o.isPaid ? "Оплачено" : o.amount,
      o.district,
      o.address,
      o.coordinates,
      o.deliveryType === "mail" ? "Почта" : "",
    ]),
  };
}
export function deliveryTSV(sheet: DeliveryWorksheet) {
  // Quote multiline/tab-containing cells so one order stays one logical TSV row.
  const cell = (value: string | number) => {
    let text = String(value);
    if (/^[=+@-]/.test(text) && !/^\+998\d{9}$/.test(text)) text = "'" + text;
    return /[\t\r\n"]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  };
  return [sheet.headers, ...sheet.rows]
    .map((row) => row.map(cell).join("\t"))
    .join("\r\n");
}
export function deliveryFilename(filter: DeliveryFilter) {
  return `Доставки_${filter.source === "ALL" ? "Все" : filter.source}_${filter.startDate}-${filter.endDate}.xlsx`;
}
