import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { createApp } from "../server/app.js";
import {
  generateOrderReport,
  orderReportFilename,
} from "../shared/order-report.js";
import {
  reportPhone,
  generateDeliveryWorksheet,
  deliveryTSV,
} from "../shared/delivery-export.js";
import { worksheetBuffer } from "../src/orders-export.js";
import type { Order } from "../shared/orders.js";
const filter = {
  startDate: "2026-11-01",
  endDate: "2026-11-30",
  source: "ALL" as const,
};
const base: Order = {
  id: "delivery",
  conversationId: null,
  client: "Client",
  source: "STOREBOOKS",
  date: "2026-11-01",
  phone: "+998001234567",
  additionalPhone: "+998991234567",
  deliveryType: "delivery",
  district: "Мирабад",
  address: "A",
  coordinates: "41,69",
  amount: 100000,
  isPaid: false,
  items: '=HYPERLINK("bad")',
  refused: false,
  createdAt: "2026-11-01T10:00:00Z",
  updatedAt: "2026-11-01T10:00:00Z",
};
const data: Order[] = [
  base,
  {
    ...base,
    id: "pickup",
    date: "2026-11-30",
    source: "MANGASTORE",
    deliveryType: "pickup",
    isPaid: true,
    amount: 200000,
  },
  { ...base, id: "mail", deliveryType: "mail", isPaid: true, amount: 300000 },
  {
    ...base,
    id: "cancelled",
    deliveryType: "pickup",
    refused: true,
    isPaid: true,
    amount: 900000,
  },
  { ...base, id: "before", date: "2026-10-31" },
  { ...base, id: "after", date: "2026-12-01" },
];
test("Monthly workbook includes all receipt types, cancellation audit and numeric totals without country codes", async () => {
  const report = generateOrderReport(data, filter);
  assert.equal(report.rows.length, 4);
  assert.deepEqual(
    new Set(report.rows.map((r) => r[3])),
    new Set(["Доставка", "Самовывоз", "Почта"]),
  );
  assert.deepEqual(report.summary.rows.at(-1), [
    "ИТОГО",
    "Все типы",
    4,
    3,
    1,
    600000,
    500000,
    100000,
  ]);
  const cancelled = report.rows.find((r) => r[0] === "cancelled")!;
  assert.equal(cancelled[4], "Отменён");
  assert.deepEqual(cancelled.slice(11, 14), [0, 0, 0]);
  const row = report.rows.find((r) => r[0] === "delivery")!;
  assert.equal(row[6], "001234567");
  assert.equal(row[7], "991234567");
  assert.equal(
    generateOrderReport(data, { ...filter, source: "MANGASTORE" }).rows.length,
    1,
  );
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await worksheetBuffer(report));
  assert.deepEqual(
    book.worksheets.map((s) => s.name),
    ["Заказы", "Итоги"],
  );
  assert.equal(book.worksheets[0].rowCount, 5);
  const cells = book.worksheets[0].getRow(report.rows.indexOf(row) + 2);
  assert.equal(cells.getCell(7).value, "001234567");
  assert.equal(cells.getCell(7).numFmt, "@");
  assert.equal(cells.getCell(7).type, ExcelJS.ValueType.String);
  assert.equal(cells.getCell(9).type, ExcelJS.ValueType.String);
  assert.equal(cells.getCell(10).type, ExcelJS.ValueType.Number);
  assert.equal(book.worksheets[0].columnCount, 19);
  assert.deepEqual(
    (book.worksheets[1].lastRow!.values as unknown[]).slice(1),
    report.summary.rows.at(-1),
  );
  assert.equal(
    orderReportFilename(filter),
    "Заказы_Все_2026-11-01-2026-11-30.xlsx",
  );
  const courier = generateDeliveryWorksheet([base]);
  assert.equal(courier.rows[0][2], "001234567, 991234567");
  assert.ok(!deliveryTSV(courier).includes("+998"));
  assert.equal(reportPhone("+998 (90) 123-45-67"), "901234567");
  assert.equal(reportPhone("998123456"), "998123456");
  assert.equal(reportPhone(), "");
  assert.deepEqual(generateOrderReport([], filter).summary.rows.at(-1), [
    "ИТОГО",
    "Все типы",
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
  assert.deepEqual(
    generateOrderReport(
      [
        { ...base, amount: 0.1 },
        { ...base, id: "second", amount: 0.2 },
      ],
      filter,
    )
      .summary.rows.at(-1)!
      .slice(5),
    [0.3, 0, 0.3],
  );
});
test("All-order API scope includes pickup and cancelled orders with exact dates/store, courier scope stays compatible", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-monthly-"));
  const ctx = await createApp({
    dataDir: dir,
    mode: "demo",
    worker: false,
    localAccess: true,
  });
  try {
    for (const o of data)
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
          o.createdAt,
          o.updatedAt,
        );
    const q = "/api/orders/export?" + new URLSearchParams(filter);
    const all = await ctx.app.inject(q + "&scope=all");
    assert.equal(all.statusCode, 200);
    assert.deepEqual(
      all
        .json()
        .map((o: Order) => o.id)
        .sort(),
      ["cancelled", "delivery", "mail", "pickup"],
    );
    const shop = await ctx.app.inject(
      q.replace("source=ALL", "source=MANGASTORE") + "&scope=all",
    );
    assert.deepEqual(
      shop.json().map((o: Order) => o.id),
      ["pickup"],
    );
    const courier = await ctx.app.inject(q);
    assert.deepEqual(
      courier
        .json()
        .map((o: Order) => o.id)
        .sort(),
      ["delivery", "mail"],
    );
    assert.equal((await ctx.app.inject(q + "&scope=bad")).statusCode, 400);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM orders").get()!.n, 6);
  } finally {
    await ctx.app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const secureDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "jorik-monthly-auth-"),
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
          "/api/orders/export?" + new URLSearchParams(filter) + "&scope=all",
        )
      ).statusCode,
      401,
    );
  } finally {
    await secure.app.close();
    fs.rmSync(secureDir, { recursive: true, force: true });
  }
});
