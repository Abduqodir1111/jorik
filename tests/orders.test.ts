import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/app.js";
import {
  courierRows,
  courierHeaders,
  type OrderInput,
  type Order,
} from "../shared/orders.js";
import { courierWorkbook } from "../src/orders-export.js";
import ExcelJS from "exceljs";
const base: OrderInput = {
  conversationId: null,
  client: "Покупатель",
  source: "Офлайн",
  date: "2026-11-02",
  phone: "+998901234567",
  deliveryType: "delivery",
  district: "Мирабад",
  address: "Адрес 1",
  coordinates: "41.3,69.2",
  amount: 150000,
  isPaid: false,
  items: "Книга 1\nКнига 2",
};
test("Orders: validation, immutable chat source, update by ID, phone history, refusal, persistence, deletion", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-orders-"));
  let ctx = await createApp({
    dataDir: dir,
    mode: "demo",
    localAccess: true,
    worker: false,
  });
  try {
    for (const invalid of [
      { phone: "+99890" },
      { district: "Другой район" },
      { items: " " },
      { amount: -1 },
      { amount: 0 },
      { date: "2026-02-30" },
      { source: "Неизвестный" },
    ])
      assert.equal(
        (
          await ctx.app.inject({
            method: "POST",
            url: "/api/orders",
            payload: { ...base, ...invalid },
          })
        ).statusCode,
        400,
      );
    const c = ctx.store.incoming("telegram-1", {
      externalConversationId: "1",
      externalMessageId: "1",
      name: "Клиент",
      username: "client",
      text: "test",
    });
    const result = await ctx.app.inject({
      method: "POST",
      url: "/api/orders",
      payload: {
        ...base,
        conversationId: c,
        client: "Подмена",
        source: "Подмена",
      },
    });
    assert.equal(result.statusCode, 201);
    const original: Order = result.json();
    assert.equal(original.source, "Telegram 1");
    assert.equal(original.client, "client");
    const { id, refused, createdAt, updatedAt, ...input } = original;
    assert.equal(
      (
        await ctx.app.inject({
          method: "PUT",
          url: "/api/orders/" + id,
          payload: { ...input, source: "Подмена" },
        })
      ).statusCode,
      400,
    );
    const changed = await ctx.app.inject({
      method: "PUT",
      url: "/api/orders/" + id,
      payload: { ...input, amount: 120000, isPaid: true },
    });
    assert.equal(changed.json().id, id);
    assert.equal(
      (
        await ctx.app.inject({ url: "/api/orders?phone=%2B998901234567" })
      ).json().length,
      1,
    );
    await ctx.app.inject({
      method: "PATCH",
      url: "/api/orders/" + id + "/refused",
      payload: { refused: true },
    });
    const pickup = await ctx.app.inject({
      method: "POST",
      url: "/api/orders",
      payload: {
        ...base,
        deliveryType: "pickup",
        district: "",
        address: "Старый адрес",
      },
    });
    assert.equal(pickup.json().address, "");
    await ctx.app.close();
    ctx = await createApp({
      dataDir: dir,
      mode: "demo",
      localAccess: true,
      worker: false,
    });
    const saved = (
      await ctx.app.inject({ url: "/api/orders" })
    ).json() as Order[];
    assert.equal(saved.length, 2);
    assert.equal(saved.find((o) => o.id === id)?.refused, true);
    assert.equal(saved.find((o) => o.id === id)?.amount, 120000);
    assert.equal(courierRows(saved, base.date).length, 0);
    assert.equal(
      (await ctx.app.inject({ method: "DELETE", url: "/api/orders/" + id }))
        .statusCode,
      200,
    );
    assert.equal(
      (await ctx.app.inject({ url: "/api/orders" })).json().length,
      1,
    );
  } finally {
    await ctx.app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("Courier XLSX: exact columns, shop instead of buyer, paid amount, exclusions and literal text", async () => {
  const order: Order = {
    ...base,
    source: "MANGASTORE",
    id: "1",
    refused: false,
    createdAt: "",
    updatedAt: "",
  };
  const orders = [
    order,
    { ...order, id: "2", isPaid: true, items: '=HYPERLINK("bad")' },
    { ...order, id: "3", deliveryType: "pickup" as const },
    { ...order, id: "4", refused: true },
    { ...order, id: "5", date: "2026-11-03" },
  ];
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await courierWorkbook(orders, base.date));
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.rowCount, 3);
  assert.deepEqual(
    (sheet.getRow(1).values as unknown[]).slice(1),
    courierHeaders,
  );
  assert.equal(sheet.getCell("A2").value, "MANGASTORE");
  assert.equal(sheet.getCell("D2").value, 150000);
  assert.equal(sheet.getCell("D3").value, "Оплачено");
  assert.equal(sheet.getCell("B3").type, ExcelJS.ValueType.String);
  assert.equal(sheet.getCell("C2").value, base.phone);
  assert.equal(sheet.getCell("H2").value, "");
});
