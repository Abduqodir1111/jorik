import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { createApp } from "../server/app.js";
import {
  generateDeliveryWorksheet,
  deliveryTSV,
  deliveryFilename,
} from "../shared/delivery-export.js";
import { courierRows, type Order } from "../shared/orders.js";
import { worksheetBuffer } from "../src/orders-export.js";
const order: Order = {
  id: "id",
  conversationId: null,
  client: "Client",
  source: "STOREBOOKS",
  date: "2026-11-07",
  phone: "+998901234567",
  deliveryType: "delivery",
  district: "Мирабад",
  address: "Address",
  coordinates: "41,69",
  amount: 100000,
  isPaid: false,
  items: "Книга 1\nКнига 2",
  refused: false,
  createdAt: "",
  updatedAt: "",
};
test("One delivery worksheet drives preview, day export, range/store filters, literal XLSX and quoted TSV", async () => {
  const data = [
    order,
    {
      ...order,
      id: "mail",
      source: "MANGASTORE",
      deliveryType: "mail" as const,
      isPaid: true,
    },
    { ...order, id: "pickup", deliveryType: "pickup" as const },
    { ...order, id: "refused", refused: true },
    { ...order, id: "old", date: "2026-10-01" },
  ];
  const filter = {
    startDate: "2026-11-07",
    endDate: "2026-11-07",
    source: "ALL" as const,
  };
  const sheet = generateDeliveryWorksheet(data, filter);
  assert.equal(sheet.rows.length, 2);
  assert.deepEqual(sheet.rows, courierRows(data, filter.startDate));
  assert.equal(sheet.rows[1][7], "Почта");
  assert.equal(sheet.rows[1][3], "Оплачено");
  assert.equal(
    generateDeliveryWorksheet(data, { ...filter, source: "MANGASTORE" }).rows
      .length,
    1,
  );
  assert.equal(
    generateDeliveryWorksheet(data, { ...filter, source: "STOREBOOKS" }).rows
      .length,
    1,
  );
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await worksheetBuffer(sheet));
  assert.equal(book.worksheets[0].rowCount, 3);
  assert.deepEqual(
    (book.worksheets[0].getRow(2).values as unknown[]).slice(1),
    sheet.rows[0],
  );
  const hostile = generateDeliveryWorksheet([
    { ...order, items: '=HYPERLINK("bad")\nsecond\tcolumn' },
  ]);
  const tsv = deliveryTSV(hostile);
  assert.ok(tsv.includes('"\'=HYPERLINK(""bad"")\nsecond\tcolumn"'));
  assert.equal(tsv.split("\r\n").length, 2);
  const literal = new ExcelJS.Workbook();
  await literal.xlsx.load(await worksheetBuffer(hostile));
  assert.equal(
    literal.worksheets[0].getCell("B2").type,
    ExcelJS.ValueType.String,
  );
  assert.equal(
    deliveryFilename(filter),
    "Доставки_Все_2026-11-07-2026-11-07.xlsx",
  );
});
test("Delivery API filters dates and shop in SQL; excludes pickup/refused, validates ranges and stays authenticated", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-delivery-"));
  const ctx = await createApp({
    dataDir: dir,
    mode: "demo",
    worker: false,
    localAccess: true,
  });
  try {
    for (const o of [
      order,
      { ...order, id: "mail", source: "MANGASTORE", deliveryType: "mail" },
      { ...order, id: "pickup", deliveryType: "pickup" },
      { ...order, id: "refused", refused: true },
      { ...order, id: "old", date: "2026-10-01" },
      { ...order, id: "next", date: "2026-11-08" },
    ])
      ctx.db
        .prepare(
          "INSERT INTO orders(id,date,phone,data,refused,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          o.id,
          o.date,
          o.phone,
          JSON.stringify(o),
          o.refused ? 1 : 0,
          "",
          "",
        );
    const query = "/api/orders/export?startDate=2026-11-07&endDate=2026-11-07";
    assert.deepEqual(
      (await ctx.app.inject(query + "&source=ALL"))
        .json()
        .map((o: Order) => o.id)
        .sort(),
      ["id", "mail"],
    );
    assert.deepEqual(
      (await ctx.app.inject(query + "&source=MANGASTORE"))
        .json()
        .map((o: Order) => o.id),
      ["mail"],
    );
    for (const q of [
      "startDate=2026-02-30&endDate=2026-11-07",
      "startDate=2026-11-08&endDate=2026-11-07",
      "startDate=2026-11-07&endDate=2026-11-07&source=bad",
    ])
      assert.equal(
        (await ctx.app.inject("/api/orders/export?" + q)).statusCode,
        400,
      );
    assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM orders").get()!.n, 6);
  } finally {
    await ctx.app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const secureDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "jorik-delivery-auth-"),
  );
  const secure = await createApp({
    dataDir: secureDir,
    mode: "demo",
    worker: false,
  });
  try {
    assert.equal(
      (
        await secure.app.inject(
          "/api/orders/export?startDate=2026-11-07&endDate=2026-11-07",
        )
      ).statusCode,
      401,
    );
  } finally {
    await secure.app.close();
    fs.rmSync(secureDir, { recursive: true, force: true });
  }
});
test("Order mutations notify only the orders stream, rather than forcing chat refreshes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-order-events-"));
  const ctx = await createApp({
    dataDir: dir,
    mode: "demo",
    worker: false,
    localAccess: true,
  });
  let changed = 0,
    ordersChanged = 0;
  ctx.store.changed = () => changed++;
  ctx.store.ordersChanged = () => ordersChanged++;
  try {
    const { id, refused, createdAt, updatedAt, ...input } = order;
    const cid = ctx.store.incoming("telegram-1", {
      externalConversationId: "peer",
      externalMessageId: "1",
      name: "C",
      username: "c",
      text: "Q",
    });
    const original = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/orders",
        payload: { ...input, conversationId: cid },
      })
    ).json();
    assert.equal(ordersChanged, 1);
    const baseline = changed;
    await ctx.app.inject({
      method: "PATCH",
      url: `/api/orders/${original.id}/refused`,
      payload: { refused: true },
    });
    await ctx.app.inject({
      method: "DELETE",
      url: `/api/orders/${original.id}`,
    });
    assert.equal(ordersChanged, 3);
    assert.equal(changed, baseline);
  } finally {
    await ctx.app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
