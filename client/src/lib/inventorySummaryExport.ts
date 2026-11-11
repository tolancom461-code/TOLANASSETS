import { escapeHtml as escape } from "@shared/html";
import { financialExcelCell } from "@shared/depreciation";
import {
  formatSummaryMoney,
  summaryBasis,
  summaryColumns,
  summaryTitle,
  type InventorySummary,
  type SummaryRow,
  type SummaryColumn,
} from "@shared/inventorySummary";

const display = (row: SummaryRow, col: SummaryColumn) =>
  col.key === "groupName"
    ? `${row.groupName}${row.groupCode ? ` (${row.groupCode})` : ""}`
    : col.money
      ? formatSummaryMoney(String(row[col.key]))
      : Number(row[col.key]).toLocaleString("en-US");
const totalRow = (report: InventorySummary): SummaryRow => ({
  ...report.total,
  groupId: null,
  groupName: "الإجمالي العام",
  groupCode: null,
});
export function inventorySummaryPrint(report: InventorySummary, scope: string) {
  const cols = summaryColumns(report);
  const cells = (row: SummaryRow, tag: "td" | "th" = "td") =>
    cols.map(col => `<${tag}>${escape(display(row, col))}</${tag}>`).join("");
  return `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${escape(summaryTitle(report))}</title><style>
    @page{size:A4 landscape;margin:12mm}body{font:12px Tahoma,Arial;color:#203b3b;margin:0}h1{font-size:21px;color:#087f75;margin-bottom:12px}p{line-height:1.8}table{width:100%;border-collapse:collapse;margin-top:18px}th,td{padding:10px;border:1px solid #dce6e4;text-align:center;overflow-wrap:anywhere}th{background:#edf5f3}td:first-child,th:first-child{text-align:right}tbody tr:nth-child(even){background:#f8faf9}tfoot{font-weight:bold;background:#e8f5ef}thead{display:table-header-group}tr{break-inside:avoid}button{padding:9px 20px;margin:16px 0}@media print{button{display:none}}
    </style></head><body><h1>${escape(summaryTitle(report))}</h1><p>${escape(scope)}<br>تاريخ التقرير: ${escape(new Date(report.generatedAt).toLocaleString("ar-SA"))}</p><p>${escape(summaryBasis)}</p><table><thead><tr>${cols.map(col => `<th>${escape(col.key === "groupName" || col.section === "الإجمالي" ? col.label : `${col.label} — ${col.section}`)}</th>`).join("")}</tr></thead><tbody>${report.rows.map(row => `<tr>${cells(row)}</tr>`).join("")}</tbody><tfoot><tr>${cells(totalRow(report))}</tr></tfoot></table><button onclick="window.print()">طباعة التقرير</button></body></html>`;
}

export async function createInventorySummaryWorkbook(
  report: InventorySummary,
  scope: string
) {
  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  wb.creator = "Tolan";
  wb.created = new Date(report.generatedAt);
  const ws = wb.addWorksheet("إجماليات الأصول والعهد", {
    views: [
      {
        state: "frozen",
        ySplit: 6,
        xSplit: 1,
        rightToLeft: true,
        showGridLines: false,
      },
    ],
    pageSetup: {
      paperSize: 9,
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    },
  });
  const cols = summaryColumns(report);
  ws.columns = cols.map(col => ({
    width: col.key === "groupName" ? 38 : col.money ? 23 : 17,
  }));
  for (const [n, text] of [
    [1, summaryTitle(report)],
    [2, scope],
    [
      3,
      `${summaryBasis} تاريخ التقرير: ${new Date(report.generatedAt).toLocaleString("ar-SA")}`,
    ],
  ] as const) {
    ws.mergeCells(n, 1, n, cols.length);
    const cell = ws.getCell(n, 1);
    cell.value = text;
    cell.font = {
      name: "Arial",
      size: n === 1 ? 16 : 11,
      bold: n === 1,
      color: { argb: "FF20544F" },
    };
    cell.alignment = {
      horizontal: "right",
      vertical: "middle",
      wrapText: true,
      readingOrder: "rtl",
    };
    ws.getRow(n).height = n === 1 ? 34 : 38;
  }
  for (let start = 0; start < cols.length;) {
    let end = start;
    while (
      end + 1 < cols.length &&
      cols[end + 1].section === cols[start].section
    )
      end++;
    if (end > start) ws.mergeCells(5, start + 1, 5, end + 1);
    ws.getCell(5, start + 1).value = cols[start].section;
    start = end + 1;
  }
  ws.getRow(6).values = cols.map(col => col.label);
  for (const n of [5, 6]) {
    ws.getRow(n).height = 28;
    for (let c = 1; c <= cols.length; c++) {
      const cell = ws.getCell(n, c);
      cell.font = {
        name: "Arial",
        size: 11,
        bold: true,
        color: { argb: "FFFFFFFF" },
      };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF087F75" },
      };
      cell.alignment = {
        horizontal: "center",
        vertical: "middle",
        wrapText: true,
      };
    }
  }
  [...report.rows, totalRow(report)].forEach((record, i) => {
    const row = ws.getRow(7 + i),
      total = i === report.rows.length;
    row.height = 30;
    cols.forEach((col, j) => {
      const cell = row.getCell(j + 1);
      // Literal text cells cannot become spreadsheet formulas.
      cell.value =
        col.key === "groupName"
          ? display(record, col)
          : col.money
            ? financialExcelCell(String(record[col.key]))
            : Number(record[col.key]);
      cell.numFmt =
        col.key === "groupName" || typeof cell.value === "string"
          ? "@"
          : col.money
            ? "#,##0.00"
            : "#,##0";
      cell.font = {
        name: "Arial",
        size: 11,
        bold: total,
        color: { argb: "FF203B3B" },
      };
      cell.alignment = {
        horizontal: col.key === "groupName" ? "right" : "center",
        vertical: "middle",
        wrapText: true,
      };
      cell.border = { bottom: { style: "thin", color: { argb: "FFDCE6E4" } } };
      if (total || i % 2)
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: total ? "FFE8F5EF" : "FFF4F8F7" },
        };
    });
  });
  ws.autoFilter = {
    from: { row: 6, column: 1 },
    to: { row: 6 + report.rows.length, column: cols.length },
  };
  ws.pageSetup.printTitlesRow = "5:6";
  ws.pageSetup.printArea = `A1:${ws.getCell(7 + report.rows.length, cols.length).address}`;
  ws.headerFooter.oddFooter = "&Rصفحة &P من &N&Lإجماليات الأصول والعهد";
  return wb;
}

export async function downloadInventorySummary(
  report: InventorySummary,
  scope: string
) {
  const wb = await createInventorySummaryWorkbook(report, scope);
  const bytes = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(
    new Blob([new Uint8Array(bytes)], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    })
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `inventory-summary-${report.groupBy}-${report.generatedAt.slice(0, 10)}.xlsx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
