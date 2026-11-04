import { test } from "node:test";
import assert from "node:assert/strict";
import {
  customerOrderHistory,
  nationalPhoneMask,
  phoneCaret,
  recentDeliveryAddress,
  uzPhoneDigits,
} from "../shared/order-form.js";
import type { Order } from "../shared/orders.js";
test("Uzbek phone paste normalizes full, national and formatted values without duplicating country code", () => {
  for (const value of [
    "901234567",
    "+998901234567",
    "998 90 123 45 67",
    "+998 (90) 123-45-67",
  ]) {
    assert.equal(uzPhoneDigits(value), "901234567");
    assert.equal(nationalPhoneMask(value), "(90) 123-45-67");
  }
  assert.equal(uzPhoneDigits("998123456"), "998123456"); // National operator 99, not a country prefix.
  assert.equal(nationalPhoneMask("9"), "(9");
  assert.equal(nationalPhoneMask("90"), "(90)");
  assert.equal(nationalPhoneMask("90123"), "(90) 123");
  assert.equal(nationalPhoneMask(""), "");
});
test("Phone caret maps digit positions through brackets, spaces and hyphens", () => {
  const value = nationalPhoneMask("901234567");
  assert.equal(phoneCaret(value, 0), 1);
  assert.equal(phoneCaret(value, 2), 3);
  assert.equal(phoneCaret(value, 5), 8);
  assert.equal(phoneCaret(value, 9), 14);
});
const order = (id: string, patch: Partial<Order> = {}): Order => ({
  id,
  conversationId: null,
  client: "test",
  source: "shop",
  date: "2026-11-03",
  phone: "+998901234567",
  deliveryType: "delivery",
  district: "Юнусабад",
  address: "Тестовая улица, 1",
  coordinates: "41.3,69.2",
  amount: 130000,
  isPaid: false,
  items: "Blue Lock 1–2",
  createdAt: "2026-11-03T12:00:00.000Z",
  updatedAt: "2026-11-03T12:00:00.000Z",
  refused: false,
  ...patch,
});
test("Customer history uses an exact normalized phone, excludes current/refused orders, sorts without mutation", () => {
  const records = [
    order("old"),
    order("new", { date: "2026-11-04" }),
    order("other", { phone: "+998991234567" }),
    order("refused", { refused: true }),
    order("editing"),
  ];
  assert.deepEqual(
    customerOrderHistory(records, "+998901234567", "editing").map((o) => o.id),
    ["new", "old"],
  );
  assert.equal(customerOrderHistory(records, "+99890").length, 0);
  assert.deepEqual(
    records.map((o) => o.id),
    ["old", "new", "other", "refused", "editing"],
  );
});
test("Address suggestion skips pickup/refused/incomplete entries and preserves all unrelated order fields", () => {
  const previous = customerOrderHistory(
    [
      order("delivery"),
      order("pickup", {
        date: "2026-11-04",
        deliveryType: "pickup",
        district: "",
        address: "",
        coordinates: "",
      }),
      order("bad", { date: "2026-11-05", refused: true }),
    ],
    "+998901234567",
  );
  assert.equal(recentDeliveryAddress(previous)?.id, "delivery");
  assert.equal(
    recentDeliveryAddress([order("empty", { address: "", coordinates: "" })]),
    undefined,
  );
});
