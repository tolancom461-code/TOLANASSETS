import { describe, expect, it } from "vitest";
import { transactionDatabase } from "./test-utils/transactionDatabase";
import { depreciationReport } from "./depreciationReports";
import { reportUnitMetadata } from "./depreciationReportMetadata";
import { calculateBatch, type FinancialBatch, type FinancialMovement } from "../shared/depreciation";
import { createDepreciationReportWorkbook, depreciationReportExcel } from "../shared/depreciationReportExcel";
import ExcelJS from "exceljs";

const allocation = { costCenter: "CC", location: "L", branch: "B", department: "D" };
const rule = { classificationId: 1, treatment: "DEPRECIABLE" as const, lifeMonths: 60, residualPercent: "0", expenseName: "مصروف", accumulatedName: "مجمع", costName: "أثاث" };
const policy = { organizationName: "مؤسسة الاختبار", currency: "SAR", fiscalStartMonth: 1, openingDate: "2026-01-01", capitalizationThreshold: "0", partialMonth: "ACTUAL_DAYS" as const, rules: [rule] };
const payload = { label: "أثاث", quantity: 2, unitCost: "6000.00", unitResidual: "100.00", openingAccumulated: "0.00", openingImpairment: "0.00", recognitionDate: "2026-01-01", availableForUseDate: "2026-01-16", balanceDate: "2026-01-01", lifeMonths: 80, documentReference: "INV", units: ["U1", "U2"], allocation, notes: "" };
const batch: FinancialBatch = { id: 1, entityType: "asset", entityId: 1, classificationId: 1, policyId: 1, payload, rule, partialMonth: "ACTUAL_DAYS", identity: { code: "A1", name: "أثاث", classification: "الأثاث", classificationCode: "F" } };
const makeDb = () => transactionDatabase({
  depreciation_policies: [{ id: 1, status: "APPROVED", effectiveDate: "2026-01-01", payload: policy }, { id: 2, status: "APPROVED", effectiveDate: "2026-07-01", payload: { ...policy, rules: [{ ...rule, lifeMonths: 120 }] } }],
  financial_classifications: [{ id: 1, name: "الأثاث", code: "F", active: true }],
  depreciation_batches: [{ ...batch, status: "APPROVED" }], depreciation_movements: [],
  assets: [{ id: 1, assetCode: "A1", assetName: "أثاث" }], custody_items: [],
  depreciation_journals: [{ id: 1, code: "J1", kind: "DEPRECIATION", effectiveDate: "2026-01-31", snapshot: { lines: [{ account: "مصروف", debit: "20.00" }], details: [{ batchId: 1, unit: "U1", debit: "20.00", classificationId: 1, classification: "الأثاث", entityType: "asset", allocation, code: "A1", name: "أثاث" }] } }],
  depreciation_periods: [{ id: 1, month: "2026-01", status: "APPROVED", snapshot: { total: "20.00", exceptions: [] } }],
});

describe("report rates and monetary preservation", () => {
  it("uses the approved classification rate, not a batch's different remaining life", async () => {
    const report = await depreciationReport(makeDb(), { from: "2026-01-01", to: "2026-01-31" });
    expect(report.rows[0]).toMatchObject({ lifeMonths: 80, depreciationRate: "20.0000", depreciationRateLabel: "20%" });
    expect(report.groups[0].depreciationRateLabel).toBe("20%");
    expect(report.total.charge).toBe("20.00");
    expect(report.reconciled).toBe(true);
  });
  it("uses policy effective at the reporting cutoff and ignores future policies", async () => {
    const db = makeDb();
    expect((await depreciationReport(db, { from: "2026-06-01", to: "2026-06-30" })).groups[0].depreciationRateLabel).toBe("20%");
    expect((await depreciationReport(db, { from: "2026-07-01", to: "2026-07-31" })).groups[0].depreciationRateLabel).toBe("10%");
  });
  it("keeps all financial values equal in the lean response while omitting unused snapshots", async () => {
    const db = makeDb();
    const range = { from: "2026-01-01", to: "2026-01-31" };
    const full = await depreciationReport(db, range);
    const lean = await depreciationReport(db, { ...range, includeJournalSnapshots: false });
    expect(full.journals).toHaveLength(1); expect(lean.journals).toEqual([]);
    const { journals: _full, ...a } = full, { journals: _lean, ...b } = lean;
    expect(b).toEqual(a);
  });
  it("does not represent a non-depreciable classification as zero percent", async () => {
    const db = makeDb(); db.rows().depreciation_policies[0].payload.rules[0].treatment = "NON_DEPRECIABLE";
    const report = await depreciationReport(db, { from: "2026-01-01", to: "2026-01-31" });
    expect(report.groups[0]).toMatchObject({ depreciationRate: null, depreciationRateLabel: "غير قابل للإهلاك" });
  });
});

const movements: FinancialMovement[] = [
  { id: 1, batchId: 1, kind: "TRANSFER", effectiveDate: "2026-02-10", payload: { units: ["U1"], reason: "نقل", documentReference: "M1", proceeds: "0", allocation: { ...allocation, location: "NEW" } } },
  { id: 2, batchId: 1, kind: "ESTIMATE", effectiveDate: "2026-03-01", payload: { units: ["U1", "U2"], reason: "تقدير", documentReference: "M2", proceeds: "0", unitResidual: "200", remainingLifeMonths: 40 } },
  { id: 3, batchId: 1, kind: "CORRECTION", effectiveDate: "2026-04-05", payload: { units: ["U2"], reason: "تصحيح", documentReference: "M3", proceeds: "0", unitResidual: "300", remainingLifeMonths: 50, unitCost: "6500", unitAccumulated: "100", unitImpairment: "20", correctionAccount: "تصحيح" } },
  { id: 4, batchId: 1, kind: "DISPOSAL", effectiveDate: "2026-05-16", payload: { units: ["U1"], reason: "استبعاد", documentReference: "M4", proceeds: "0" } },
  { id: 5, batchId: 1, kind: "WARRANTY", effectiveDate: "2026-06-01", payload: { units: ["U2"], reason: "ضمان", documentReference: "M5", proceeds: "0" } },
  { id: 6, batchId: 1, kind: "TRANSFER", effectiveDate: "2026-06-02", payload: { units: ["U1"], reason: "لاحق", documentReference: "M6", proceeds: "0", allocation } },
];

it.each(["2026-01-31", "2026-02-09", "2026-02-10", "2026-03-01", "2026-04-05", "2026-05-15", "2026-05-16", "2026-06-01", "2030-12-31"])("end-state metadata matches the established engine at %s", date => {
  const expected = calculateBatch(batch, movements, batch.payload.balanceDate, date).units.map(({ allocation, residual, disposed }) => ({ allocation, residual, disposed }));
  expect(reportUnitMetadata(batch, movements, date)).toEqual(expected);
});

describe("formatted financial report export", () => {
  it("puts a real percent between classification and opening cost, with panes, filters, totals and print setup", async () => {
    const report = await depreciationReport(makeDb(), { from: "2026-01-01", to: "2026-01-31", includeJournalSnapshots: false });
    const bytes = await depreciationReportExcel(report);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(bytes as any);
    expect(wb.worksheets.map(s => s.name)).toEqual(["الإجمالي حسب التصنيف", "السجل المالي", "مصروف حسب التخصيص"]);
    const ws = wb.worksheets[0];
    expect(ws.getRow(8).values).toEqual(expect.arrayContaining(["التصنيف", "نسبة الإهلاك", "التكلفة أول الفترة"]));
    expect(ws.getCell("A8").value).toBe("التصنيف"); expect(ws.getCell("B8").value).toBe("نسبة الإهلاك"); expect(ws.getCell("C8").value).toBe("التكلفة أول الفترة");
    expect(ws.getCell("B9").value).toBe(.2); expect(ws.getCell("B9").numFmt).toBe("0.00%");
    expect(ws.getCell("A8").font.bold).toBe(true); expect(ws.getCell("A8").fill).toMatchObject({ fgColor: { argb: "FF243B5A" } });
    expect(ws.views[0]).toMatchObject({ rightToLeft: true, state: "frozen", ySplit: 8 });
    expect(ws.autoFilter).toBeTruthy(); expect(ws.pageSetup.orientation).toBe("landscape");
    const charge = 10;
    expect(ws.getCell(10, charge).value).toBe(Number(report.total.charge));
    expect(ws.getCell(10, 2).value).toBe(""); // percentages are not summed
  });
  it("preserves exact huge amounts and treats a formula-like asset name as text", async () => {
    const report = await depreciationReport(makeDb(), { from: "2026-01-01", to: "2026-01-31" });
    report.groups[0].openingCost = "1234567890123456.78";
    report.rows[0].name = '=HYPERLINK("https://example.invalid")';
    const wb = await createDepreciationReportWorkbook(report);
    expect(wb.worksheets[0].getCell("C9").value).toBe("1234567890123456.78");
    expect(wb.worksheets[1].getCell("B9").value).toBe(report.rows[0].name);
    expect(wb.worksheets[1].getCell("B9").type).toBe(ExcelJS.ValueType.String);
  });
});
