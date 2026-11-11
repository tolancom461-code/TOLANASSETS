import ExcelJS from "exceljs";
import { amount, money, financialExcelCell } from "./depreciation";
import { depreciationReportColumns, depreciationComparisonColumns } from "./depreciationReportColumns";

const moneyFormat = '#,##0.00;[Red](#,##0.00);"-"';
const textKeys = new Set(["classification", "code", "name", "unit", "costCenter", "location", "branch", "department", "depreciationRateLabel"]);
const costKeys = new Set(["openingCost", "additions", "costAdjustments", "removedCost", "closingCost"]);
const accumKeys = new Set(["openingAccum", "carriedAccum", "charge", "accumAdjustments", "removedAccum", "closingAccum"]);
const signed = (value: string) => value.startsWith("-") ? -money(value.slice(1)) : money(value);
type ExportComparison = { title: string; rows: any[] };

// Loaded only when the user exports. Server-calculated amounts remain the source
// of truth; large amounts stay exact text rather than losing Excel precision.
export async function createDepreciationReportWorkbook(report: any, comparison?: ExportComparison) {
  const wb = new ExcelJS.Workbook();
  wb.creator = report.organizationName || "إدارة العهد والأصول";
  wb.created = new Date();
  const sheets: Array<{ name: string; rows: any[]; columns: string[][]; total?: Record<string, unknown>; title?: string }> = [
    { name: "الإجمالي حسب التصنيف", rows: report.groups, columns: depreciationReportColumns, total: report.total },
    { name: "السجل المالي", rows: report.rows, columns: [["code", "الرمز"], ["name", "الاسم"], ["unit", "الوحدة"], ...depreciationReportColumns], total: report.total },
    { name: "مصروف حسب التخصيص", rows: report.expenses, columns: [["classification", "التصنيف"], ["costCenter", "مركز التكلفة"], ["location", "الموقع"], ["branch", "الفرع"], ["department", "القسم"], ["value", "مصروف الإهلاك"]] },
  ];
  if (comparison) sheets.push({ name: "مقارنة الفترات", rows: comparison.rows, columns: depreciationComparisonColumns, title: comparison.title });

  for (const { name, rows, columns, total, title } of sheets) {
    const ws = wb.addWorksheet(name, {
      properties: { defaultRowHeight: 24, tabColor: { argb: "FF243B5A" } },
      pageSetup: { paperSize: 8 as ExcelJS.PaperSize, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: .25, right: .25, top: .4, bottom: .4, header: .15, footer: .15 } },
    });
    const identifierColumns = columns[0][0] === "code" ? 3 : 1;
    ws.views = [{ state: "frozen", ySplit: 8, xSplit: identifierColumns, rightToLeft: true, showGridLines: false, activeCell: ws.getCell(9, identifierColumns + 1).address }];
    ws.columns = columns.map(([key]) => ({ width: key === "name" ? 36 : key === "classification" ? 28 : key === "depreciationRateLabel" ? 17 : textKeys.has(key) ? 23 : 22 }));
    const end = columns.length;
    const titleRow = (r: number, text: string, font: Partial<ExcelJS.Font>, height: number) => {
      ws.mergeCells(r, 1, r, end);
      const cell = ws.getCell(r, 1);
      cell.value = text;
      cell.font = { name: "Arial", size: 10, color: { argb: "FF243B5A" }, ...font };
      cell.alignment = { horizontal: "right", vertical: "middle", wrapText: true, readingOrder: "rtl" };
      ws.getRow(r).height = height;
    };
    ws.getRow(1).height = 8;
    titleRow(2, title || report.title, { size: 16, bold: true }, 31);
    titleRow(3, `${report.organizationName || ""}   العملة: ${report.currency || ""}`, {}, 24);
    titleRow(4, report.basis || "", { italic: true, color: { argb: "FF566779" } }, 25);
    const rateBasis = report.rateBasis || "نسبة الإهلاك من سياسة التصنيف المعتمدة السارية في نهاية الفترة.";
    const pending = report.pendingMonths?.length ? `فترات لم تعتمد: ${report.pendingMonths.join("، ")}. ` : "";
    titleRow(5, pending + rateBasis, { color: { argb: pending ? "FF985600" : "FF566779" } }, 30);
    ws.getRow(6).height = 9;

    const groupOf = (key: string) => costKeys.has(key) ? "حركة التكلفة" : accumKeys.has(key) ? "حركة مجمع الإهلاك" : ["closingImpairment", "net"].includes(key) ? "القيمة الدفترية" : "بيانات التقرير";
    for (let start = 0; start < columns.length;) {
      const group = groupOf(columns[start][0]);
      let finish = start;
      while (finish + 1 < columns.length && groupOf(columns[finish + 1][0]) === group) finish++;
      if (finish > start) ws.mergeCells(7, start + 1, 7, finish + 1);
      const cell = ws.getCell(7, start + 1);
      cell.value = group;
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE9EFF6" } };
      cell.font = { name: "Arial", size: 10, bold: true, color: { argb: "FF243B5A" } };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      start = finish + 1;
    }
    ws.getRow(7).height = 25;
    const header = ws.getRow(8);
    header.values = columns.map(c => c[1]);
    header.height = 48;
    header.eachCell(cell => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF243B5A" } };
      cell.font = { name: "Arial", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true, readingOrder: "rtl" };
      cell.border = { left: { style: "thin", color: { argb: "FFFFFFFF" } } };
    });
    const setValue = (cell: ExcelJS.Cell, key: string, row: any) => {
      if (key === "depreciationRateLabel") {
        cell.value = row.depreciationRate != null ? Number(row.depreciationRate) / 100 : row.depreciationRateLabel ?? "";
        cell.numFmt = typeof cell.value === "number" ? "0.00%" : "@";
      } else if (textKeys.has(key)) {
        // Assign literal strings, never interpreted formulas or links.
        cell.value = String(row[key] ?? "");
        cell.numFmt = "@";
      } else {
        const value = row[key];
        cell.value = typeof value === "string" ? financialExcelCell(value) : value ?? null;
        cell.numFmt = typeof cell.value === "number" ? moneyFormat : "@";
      }
      cell.alignment = { horizontal: key === "depreciationRateLabel" ? "center" : "right", vertical: "middle", wrapText: textKeys.has(key), readingOrder: textKeys.has(key) ? "rtl" : "ltr" };
    };
    rows.forEach((record, i) => {
      const row = ws.getRow(i + 9);
      let height = 25;
      columns.forEach(([key], j) => {
        const cell = row.getCell(j + 1);
        setValue(cell, key, record);
        cell.font = { name: "Arial", size: 11, color: { argb: "FF243B5A" } };
        if (i % 2) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF4F7FB" } };
        if (textKeys.has(key)) height = Math.max(height, 16 * Math.ceil(String(record[key] ?? "").length / ((ws.getColumn(j + 1).width || 22) * .8)) + 8);
      });
      row.height = Math.max(25, height);
    });
    const endData = 8 + rows.length;
    ws.autoFilter = { from: { row: 8, column: 1 }, to: { row: Math.max(8, endData), column: end } };
    if (rows.length) {
      const totals: Record<string, unknown> = total ?? Object.fromEntries(columns.filter(([key]) => !textKeys.has(key)).map(([key]) => [key, amount(rows.reduce((sum: bigint, row: any) => sum + signed(String(row[key] ?? "0.00")), 0n))]));
      const row = ws.getRow(endData + 1);
      row.height = 30;
      columns.forEach(([key], j) => {
        const cell = row.getCell(j + 1);
        setValue(cell, key, j === 0 ? { [key]: "الإجمالي" } : totals);
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE9EFF6" } };
        cell.font = { name: "Arial", size: 11, bold: true, color: { argb: "FF243B5A" } };
        cell.border = { top: { style: "double", color: { argb: "FF849BB5" } } };
      });
    }
    ws.pageSetup.printTitlesRow = "7:8";
    ws.pageSetup.printArea = `A1:${ws.getCell(ws.rowCount, end).address}`;
    ws.headerFooter.oddFooter = "&Rصفحة &P من &N&Lتقرير الإهلاك";
  }
  return wb;
}

export async function depreciationReportExcel(report: any, comparison?: ExportComparison) {
  return new Uint8Array(await (await createDepreciationReportWorkbook(report, comparison)).xlsx.writeBuffer());
}
