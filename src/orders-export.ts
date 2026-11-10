import { isOrderReport, orderReportFilename } from "../shared/order-report";
import {
  generateDeliveryWorksheet,
  deliveryFilename,
  type DeliveryWorksheet,
  type DeliveryFilter,
} from "../shared/delivery-export";
import type { Order } from "../shared/orders";
export async function worksheetBuffer(model: DeliveryWorksheet) {
  const { default: ExcelJS } = await import("exceljs");
  const book = new ExcelJS.Workbook();
  function addSheet(
    name: string,
    data: DeliveryWorksheet,
    textColumns: number[],
    moneyColumns: number[] = [],
  ) {
    const sheet = book.addWorksheet(name);
    sheet.addRow(data.headers);
    for (const row of data.rows) sheet.addRow(row);
    sheet.columns.forEach((column, index) => {
      column.width = data.widths[index];
    });
    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF2563EB" },
    };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: {
        row: Math.max(1, data.rows.length + 1),
        column: data.headers.length,
      },
    };
    sheet.eachRow((row) => {
      row.alignment = { vertical: "top", wrapText: true };
    });
    for (const n of textColumns) sheet.getColumn(n).numFmt = "@";
    for (const n of moneyColumns) sheet.getColumn(n).numFmt = "#,##0.00";
    return sheet;
  }
  if (isOrderReport(model)) {
    addSheet("Заказы", model, [1, 7, 8], [10, 12, 13, 14]);
    const summary = addSheet("Итоги", model.summary, [], [6, 7, 8]);
    summary.getRow(summary.rowCount).font = { bold: true };
  } else addSheet("Доставки", model, [3]);
  return book.xlsx.writeBuffer();
}
export async function courierWorkbook(orders: Order[], date: string) {
  return worksheetBuffer(
    generateDeliveryWorksheet(orders, {
      startDate: date,
      endDate: date,
      source: "ALL",
    }),
  );
}
export async function downloadDelivery(
  model: DeliveryWorksheet,
  filter: DeliveryFilter,
) {
  const buffer = await worksheetBuffer(model);
  const url = URL.createObjectURL(
    new Blob([new Uint8Array(buffer)], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = isOrderReport(model)
    ? orderReportFilename(filter)
    : deliveryFilename(filter);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function exportToExcel(orders: Order[], date: string) {
  const filter: DeliveryFilter = {
    startDate: date,
    endDate: date,
    source: "ALL",
  };
  await downloadDelivery(generateDeliveryWorksheet(orders, filter), filter);
}
