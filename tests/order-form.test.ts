import { test } from "node:test";
import assert from "node:assert/strict";
import {
  customerOrderHistory,
  nextDeliveryDate,
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

test("New order delivery dates use the local weekday calendar, including Sunday -> Tuesday", () => {
  const previousTZ = process.env.TZ;
  try {
    for (const tz of [
      "Asia/Tashkent",
      "America/Los_Angeles",
      "Pacific/Kiritimati",
    ]) {
      process.env.TZ = tz;
      for (const [today, expected] of [
        ["2026-11-09", "2026-11-10"],
        ["2026-11-10", "2026-11-11"],
        ["2026-11-11", "2026-11-12"],
        ["2026-11-12", "2026-11-13"],
        ["2026-11-13", "2026-11-14"],
        ["2026-11-14", "2026-11-16"],
        ["2026-11-15", "2026-11-17"],
        ["2026-02-28", "2026-03-02"],
        ["2026-12-31", "2027-01-01"],
        ["2028-02-28", "2028-02-29"],
      ]) {
        for (const time of ["00:05:00", "23:55:00"]) {
          const now = new Date(today + "T" + time);
          const original = now.getTime();
          assert.equal(
            nextDeliveryDate(now),
            expected,
            `${tz} ${today} ${time}`,
          );
          assert.equal(
            now.getTime(),
            original,
            "Caller date must not be mutated",
          );
        }
      }
    }
    for (const [tz, today, expected] of [
      ["America/Los_Angeles", "2026-03-07T23:55:00", "2026-03-09"],
      ["America/Los_Angeles", "2026-11-01T00:05:00", "2026-11-03"],
      ["Australia/Sydney", "2026-10-03T23:55:00", "2026-10-05"],
    ]) {
      process.env.TZ = tz;
      assert.equal(
        nextDeliveryDate(new Date(today)),
        expected,
        "DST keeps the local calendar date",
      );
    }
  } finally {
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});
