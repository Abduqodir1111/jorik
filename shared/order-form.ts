import type { Order } from "./orders.js";

/** Accept a national number or a pasted full Uzbek number; persist digits only. */
export function uzPhoneDigits(value: string) {
  let digits = value.replace(/\D/g, "");
  if (digits.length > 9 && digits.startsWith("998")) digits = digits.slice(3);
  return digits.slice(0, 9);
}
export function nationalPhoneMask(value: string) {
  const d = uzPhoneDigits(value);
  if (!d) return "";
  let result = "(" + d.slice(0, 2);
  if (d.length >= 2) result += ")";
  if (d.length > 2) result += " " + d.slice(2, 5);
  if (d.length > 5) result += "-" + d.slice(5, 7);
  if (d.length > 7) result += "-" + d.slice(7, 9);
  return result;
}
export function phoneCaret(mask: string, digitsBeforeCaret: number) {
  if (digitsBeforeCaret <= 0) return mask ? 1 : 0;
  let seen = 0;
  for (let i = 0; i < mask.length; i++)
    if (/\d/.test(mask[i]) && ++seen === digitsBeforeCaret) return i + 1;
  return mask.length;
}
export function customerOrderHistory(
  orders: Order[],
  phone: string,
  excludeId?: string,
) {
  if (!/^\+998\d{9}$/.test(phone)) return [];
  return orders
    .filter((o) => o.phone === phone && o.id !== excludeId && !o.refused)
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt),
    );
}
export function recentDeliveryAddress(orders: Order[]) {
  return orders.find(
    (o) =>
      !o.refused &&
      o.deliveryType === "delivery" &&
      o.district &&
      (o.address || o.coordinates),
  );
}
