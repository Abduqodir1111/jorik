import { generateDeliveryWorksheet } from "./delivery-export.js";
export const districts = [
  "Юнусабад",
  "Мирзо Улугбек",
  "Яшнабад",
  "Яккасарай",
  "Мирабад",
  "Учтепа",
  "Алмазар",
  "Чиланзар",
  "Сергили",
  "Шайхотахур",
  "Бектимир",
  "Янгихаёт",
] as const;
export const manualSources = [
  "Офлайн",
  "Telegram",
  "Instagram",
  "Uzum Market",
] as const;
export interface OrderInput {
  conversationId: string | null;
  client: string;
  source: string;
  date: string;
  phone: string;
  deliveryType: "delivery" | "pickup" | "mail";
  district: string;
  address: string;
  coordinates: string;
  amount: number;
  isPaid: boolean;
  items: string;
}
export interface Order extends OrderInput {
  id: string;
  refused: boolean;
  createdAt: string;
  updatedAt: string;
}
export function localDate(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
export { courierHeaders } from "./delivery-export.js";
export function courierRows(orders: Order[], date: string) {
  return generateDeliveryWorksheet(orders, {
    startDate: date,
    endDate: date,
    source: "ALL",
  }).rows;
}
