import { z } from "zod";
import { amount, money } from "./depreciation";

export const summaryGroups = {
  department: "الأقسام",
  location: "المواقع",
  branch: "الفروع",
  employee: "الموظفين",
  classification: "التصنيفات",
} as const;
export const summaryTypes = {
  all: "الأصول والعهد",
  assets: "الأصول فقط",
  custody: "العهد فقط",
} as const;
export const inventorySummaryInput = z.object({
  groupBy: z
    .enum(["department", "location", "branch", "employee", "classification"])
    .default("department"),
  type: z.enum(["all", "assets", "custody"]).default("all"),
  locationId: z.number().int().positive().optional(),
  branchId: z.number().int().positive().optional(),
  departmentId: z.number().int().positive().optional(),
  employeeId: z.number().int().positive().optional(),
  classificationId: z.number().int().positive().optional(),
});
export type InventorySummaryInput = z.infer<typeof inventorySummaryInput>;
export type SummaryTotals = {
  assetRecords: number;
  assetQuantity: number;
  assetValue: string;
  custodyRecords: number;
  custodyQuantity: number;
  custodyValue: string;
  totalValue: string;
};
export type SummaryRow = SummaryTotals & {
  groupId: number | null;
  groupName: string;
  groupCode: string | null;
};
export type InventorySummary = {
  groupBy: InventorySummaryInput["groupBy"];
  type: InventorySummaryInput["type"];
  rows: SummaryRow[];
  total: SummaryTotals;
  generatedAt: string;
};
export type SummaryAggregate = {
  groupId: number | null;
  groupName: string | null;
  groupCode: string | null;
  records: number | string;
  quantity: number | string;
  value: string;
};
const empty = (): SummaryTotals => ({
  assetRecords: 0,
  assetQuantity: 0,
  assetValue: "0.00",
  custodyRecords: 0,
  custodyQuantity: 0,
  custodyValue: "0.00",
  totalValue: "0.00",
});

// Keep SQL DECIMAL amounts exact when combining the two record types.
export function mergeSummaryGroups(
  assets: SummaryAggregate[],
  custody: SummaryAggregate[]
) {
  const groups = new Map<number | null, SummaryRow>();
  for (const [kind, rows] of [
    ["asset", assets],
    ["custody", custody],
  ] as const) {
    for (const source of rows) {
      const row = groups.get(source.groupId) ?? {
        ...empty(),
        groupId: source.groupId,
        groupName: source.groupName || "غير محدد",
        groupCode: source.groupCode,
      };
      row[`${kind}Records`] += Number(source.records);
      row[`${kind}Quantity`] += Number(source.quantity);
      row[`${kind}Value`] = amount(
        money(row[`${kind}Value`]) + money(source.value)
      );
      row.totalValue = amount(money(row.assetValue) + money(row.custodyValue));
      groups.set(source.groupId, row);
    }
  }
  const rows = [...groups.values()].sort(
    (a, b) =>
      a.groupName.localeCompare(b.groupName, "ar") ||
      (a.groupId ?? 0) - (b.groupId ?? 0)
  );
  const total = empty();
  for (const row of rows) {
    total.assetRecords += row.assetRecords;
    total.assetQuantity += row.assetQuantity;
    total.custodyRecords += row.custodyRecords;
    total.custodyQuantity += row.custodyQuantity;
    total.assetValue = amount(money(total.assetValue) + money(row.assetValue));
    total.custodyValue = amount(
      money(total.custodyValue) + money(row.custodyValue)
    );
  }
  total.totalValue = amount(
    money(total.assetValue) + money(total.custodyValue)
  );
  return { rows, total };
}

export const summaryBasis =
  "السجلات المعتمدة؛ الكمية المتبقية بعد الاستبعاد واستبدال الضمان × قيمة الوحدة المسجلة. القيم بالريال السعودي.";
export const summaryTitle = (
  report: Pick<InventorySummary, "type" | "groupBy">
) =>
  `إجمالي ${summaryTypes[report.type].replace(" فقط", "")} حسب ${summaryGroups[report.groupBy]}`;
export const formatSummaryMoney = (value: string) => {
  const [whole, fraction = "00"] = value.split(".");
  return `${BigInt(whole).toLocaleString("en-US")}.${fraction.padEnd(2, "0")}`;
};
export type SummaryColumn = {
  key: "groupName" | keyof SummaryTotals;
  label: string;
  section: string;
  money?: boolean;
};
export function summaryColumns(
  report: Pick<InventorySummary, "type" | "groupBy">
): SummaryColumn[] {
  const columns: SummaryColumn[] = [
    {
      key: "groupName",
      label: summaryGroups[report.groupBy],
      section: "التجميع",
    },
  ];
  if (report.type !== "custody")
    columns.push(
      { key: "assetRecords", label: "عدد السجلات", section: "الأصول" },
      { key: "assetQuantity", label: "الكمية", section: "الأصول" },
      { key: "assetValue", label: "القيمة", section: "الأصول", money: true }
    );
  if (report.type !== "assets")
    columns.push(
      { key: "custodyRecords", label: "عدد السجلات", section: "العهد" },
      { key: "custodyQuantity", label: "الكمية", section: "العهد" },
      { key: "custodyValue", label: "القيمة", section: "العهد", money: true }
    );
  if (report.type === "all")
    columns.push({
      key: "totalValue",
      label: "القيمة الإجمالية",
      section: "الإجمالي",
      money: true,
    });
  return columns;
}
