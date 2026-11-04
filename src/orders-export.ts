import { courierHeaders, courierRows, type Order } from "../shared/orders";
export async function courierWorkbook(orders: Order[], date: string) {
  const { default: ExcelJS } = await import("exceljs");
  const book = new ExcelJS.Workbook(),
    sheet = book.addWorksheet("Доставки");
  sheet.addRow(courierHeaders);
  for (const row of courierRows(orders, date)) sheet.addRow(row);
  sheet.columns.forEach((c, i) => {
    c.width = [20, 48, 22, 18, 22, 45, 40, 18][i];
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
export async function exportToExcel(orders: Order[], date: string) {
  const buffer = await courierWorkbook(orders, date);
  const url = URL.createObjectURL(
    new Blob([new Uint8Array(buffer)], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `Доставки_Storebooks_${date}.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
