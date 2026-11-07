import {
  generateDeliveryWorksheet,
  deliveryFilename,
  type DeliveryWorksheet,
  type DeliveryFilter,
} from "../shared/delivery-export";
import type { Order } from "../shared/orders";
export async function worksheetBuffer(model: DeliveryWorksheet) {
  const { default: ExcelJS } = await import("exceljs");
  const book = new ExcelJS.Workbook(),
    sheet = book.addWorksheet("Доставки");
  sheet.addRow(model.headers);
  for (const row of model.rows) sheet.addRow(row);
  sheet.columns.forEach((c, i) => {
    c.width = model.widths[i];
  });
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF2563EB" },
  };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = "A1:H1";
  sheet.eachRow((row) => {
    row.alignment = { vertical: "top", wrapText: true };
  });
  sheet.getColumn(3).numFmt = "@";
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
  a.download = deliveryFilename(filter);
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
