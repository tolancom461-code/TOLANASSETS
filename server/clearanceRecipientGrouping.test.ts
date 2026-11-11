import { describe, expect, it } from "vitest";
import { generateClearanceReport } from "../client/src/lib/clearanceReport";

const input = {
  employeeName: "موظف اختبار", fingerprintId: 1, idNumber: "123", reason: "إجازة داخلية",
  lastWorkDay: "2026-10-31", dayName: "السبت", statements: [], signatures: [], clearanceCode: "CLR-TEST",
  assets: [{ department: "حواسيب", items: [{ id: 1, name: "حاسوب", code: "A-1", quantity: 2 }] },
    { department: "أثاث", items: [{ id: 2, name: "مكتب", code: "A-2", quantity: 12 }] }],
  custody: [{ department: "حواسيب", items: [{ id: 3, name: "شاحن", code: "C-1", quantity: 21 }] }],
  departmentAlternates: { حواسيب: "مستلم موحد", أثاث: "مستلم موحد" } as Record<string, string>,
};

describe("clearance recipient grouping", () => {
  it("prints the common recipient once and retains the original departmental tables and quantities", () => {
    const html = generateClearanceReport(input);
    expect(html.match(/class="recipient-heading"/g)).toHaveLength(1);
    expect(html.match(/مستلم موحد/g)).toHaveLength(1);
    expect(html.match(/class="dept-section"/g)).toHaveLength(2);
    expect(html.match(/class="items-table"/g)).toHaveLength(3);
    for (const text of ["A-1", "A-2", "C-1", "حاسوب", "مكتب", "شاحن", '>12</td>', '>21</td>']) expect(html).toContain(text);
  });
  it("places each classification and its items below its own recipient", () => {
    const html = generateClearanceReport({ ...input, departmentAlternates: { حواسيب: "أحمد", أثاث: "زيد" } });
    const groups = html.split('<div class="recipient-heading">').slice(1);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toContain("أحمد");
    expect(groups[0]).toContain("A-1");
    expect(groups[0]).toContain("C-1");
    expect(groups[0]).not.toContain("A-2");
    expect(groups[1]).toContain("زيد");
    expect(groups[1]).toContain("A-2");
  });
  it("retains all items from repeated department groups and groups unspecified recipients safely", () => {
    const html = generateClearanceReport({ ...input, assets: [...input.assets, { department: "حواسيب", items: [{ id: 4, code: "A-4", name: "حاسوب آخر", quantity: 3 }] }], departmentAlternates: {} });
    expect(html.match(/class="recipient-heading"/g)).toHaveLength(1);
    expect(html).toContain("غير محدد");
    expect(html).toContain("A-4");
  });
});
