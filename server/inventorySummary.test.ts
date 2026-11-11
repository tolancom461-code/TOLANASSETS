import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/mysql2";
import ExcelJS from "exceljs";
import {
  getInventorySummary,
  getInventorySummaryOptions,
} from "./inventorySummary";
import {
  inventorySummaryInput,
  mergeSummaryGroups,
  summaryColumns,
} from "../shared/inventorySummary";
import {
  createInventorySummaryWorkbook,
  inventorySummaryPrint,
} from "../client/src/lib/inventorySummaryExport";
import type { TrpcContext } from "./_core/context";

const state = vi.hoisted(() => ({ db: null as any }));
vi.mock("./db", () => ({ getDb: async () => state.db }));
import { recordsRouter } from "./routers/records";

// Execute the generated SELECT/JOIN/GROUP BY/filter SQL on isolated in-memory
// tables. The adapter supplies MySQL's GREATEST and DECIMAL(2) result encoding;
// exact large DECIMAL addition is tested separately without SQLite floats.
function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.function("GREATEST", { varargs: true }, (...values) =>
    Math.max(...values.map(Number))
  );
  sqlite.exec(`
    CREATE TABLE locations (id INTEGER PRIMARY KEY, name TEXT, code TEXT);
    CREATE TABLE branches (id INTEGER PRIMARY KEY, name TEXT, code TEXT, locationId INTEGER);
    CREATE TABLE departments (id INTEGER PRIMARY KEY, name TEXT, code TEXT, branchId INTEGER);
    CREATE TABLE employees (id INTEGER PRIMARY KEY, fullName TEXT, code TEXT);
    CREATE TABLE financial_classifications (id INTEGER PRIMARY KEY, name TEXT, code TEXT);
    INSERT INTO locations VALUES (1,'الملقا','L1'),(2,'الروضة','L2');
    INSERT INTO branches VALUES (1,'الرئيسي','B1',1),(2,'الرئيسي','B2',2);
    INSERT INTO departments VALUES (1,'الإدارة','D1',1),(2,'الإدارة','D2',2);
    INSERT INTO employees VALUES (11,'أحمد','E11'),(12,'أحمد','E12');
    INSERT INTO financial_classifications VALUES (1,'أثاث','F1'),(2,'أجهزة','F2');
  `);
  for (const table of ["assets", "custody_items"])
    sqlite.exec(`CREATE TABLE ${table} (
    id INTEGER PRIMARY KEY, quantity INTEGER, excludedQuantity INTEGER,
    warrantyReplacedQuantity INTEGER, assetValue NUMERIC, assignedTo INTEGER,
    departmentId INTEGER, locationId INTEGER, classificationId INTEGER, status TEXT
  )`);
  sqlite.exec(`
    INSERT INTO assets VALUES
      (1,10,3,2,10.10,11,1,1,1,'ACTIVE'),
      (2,2,0,0,20.20,12,2,2,2,'ACTIVE'),
      (3,4,4,0,30,11,1,1,1,'EXCLUDED'),
      (4,99,0,0,1000,11,1,1,1,'DRAFT'),
      (5,99,0,0,1000,11,1,1,1,'CANCELLED'),
      (6,1,NULL,0,0.10,NULL,NULL,NULL,NULL,'ACTIVE');
    INSERT INTO custody_items VALUES
      (1,7,1,1,2.30,11,1,1,1,'ACTIVE'),
      (2,1,0,0,0.20,NULL,NULL,NULL,NULL,'ACTIVE'),
      (3,5,0,5,100,12,2,2,2,'WARRANTY_REPLACED'),
      (4,99,0,0,1000,11,1,1,1,'DRAFT');
  `);
  const queries: string[] = [];
  const client = {
    async query(config: { sql: string }, params: unknown[] = []) {
      const text = config.sql;
      queries.push(text);
      if (/^set transaction/i.test(text)) return [{}, []];
      if (/^(start transaction|begin)/i.test(text)) {
        sqlite.exec("BEGIN");
        return [{}, []];
      }
      if (/^(commit|rollback)$/i.test(text)) {
        sqlite.exec(text);
        return [{}, []];
      }
      if (!/^select /i.test(text))
        throw new Error("Read-only report attempted a write");
      const stmt = sqlite.prepare(text);
      stmt.setReturnArrays(true);
      const rows = stmt.all(...(params as any[])) as unknown as any[][];
      if (text.includes("SUM("))
        rows.forEach(row => {
          row[5] = Number(row[5]).toFixed(2);
        });
      return [rows, []];
    },
  };
  return { sqlite, queries, db: drizzle({ client: client as any }) };
}

describe("Inventory report summaries", () => {
  let f: ReturnType<typeof fixture>;
  const input = (overrides: object = {}) =>
    inventorySummaryInput.parse(overrides);
  beforeEach(() => {
    f = fixture();
    state.db = f.db;
  });
  afterEach(() => {
    f.sqlite.close();
  });

  for (const groupBy of [
    "location",
    "branch",
    "department",
    "employee",
    "classification",
  ] as const) {
    it(`${groupBy}: groups actual rows and preserves the grand total`, async () => {
      const result = await getInventorySummary(f.db, input({ groupBy }));
      expect(result.rows).toHaveLength(3);
      expect(result.total).toEqual({
        assetRecords: 4,
        assetQuantity: 8,
        assetValue: "91.00",
        custodyRecords: 3,
        custodyQuantity: 6,
        custodyValue: "11.70",
        totalValue: "102.70",
      });
      expect(result.rows.find(r => r.groupId === null)).toMatchObject({
        groupName: "غير محدد",
        totalValue: "0.30",
      });
      expect(f.queries[0]).toContain("repeatable read");
      expect(f.queries[1]).toBe("begin");
      expect(f.queries.some(q => /^(insert|update|delete)/i.test(q))).toBe(false);
    });
  }

  it("keeps identical department names separate by ID and code", async () => {
    const result = await getInventorySummary(f.db, input());
    const departments = result.rows.filter(r => r.groupName === "الإدارة");
    expect(
      departments.map(r => [r.groupId, r.groupCode, r.totalValue])
    ).toEqual([
      [1, "D1", "62.00"],
      [2, "D2", "40.40"],
    ]);
  });
  for (const [key, value, expected] of [
    ["locationId", 1, "62.00"],
    ["departmentId", 2, "40.40"],
    ["branchId", 2, "40.40"],
    ["employeeId", 11, "62.00"],
    ["classificationId", 1, "62.00"],
  ] as const) {
    it(`${key} works independently of the other filters`, async () => {
      expect(
        (await getInventorySummary(f.db, input({ [key]: value }))).total
          .totalValue
      ).toBe(expected);
    });
  }
  it("intersects hybrid filters and returns zero totals for no matches", async () => {
    const result = await getInventorySummary(
      f.db,
      input({ locationId: 1, departmentId: 2 })
    );
    expect(result.rows).toEqual([]);
    expect(result.total.totalValue).toBe("0.00");
    expect(result.total.assetRecords + result.total.custodyRecords).toBe(0);
  });
  it("supports each type without reading or leaking the other type", async () => {
    const assets = await getInventorySummary(f.db, input({ type: "assets" }));
    expect(assets.total).toMatchObject({
      totalValue: "91.00",
      custodyRecords: 0,
      custodyValue: "0.00",
    });
    expect(f.queries.some(q => q.includes("from `custody_items`"))).toBe(false);
    f.queries.length = 0;
    const custody = await getInventorySummary(f.db, input({ type: "custody" }));
    expect(custody.total).toMatchObject({
      totalValue: "11.70",
      assetRecords: 0,
      assetValue: "0.00",
    });
    expect(f.queries.some(q => q.includes("from `assets`"))).toBe(false);
    expect(summaryColumns(assets)).toHaveLength(4);
    expect(summaryColumns(custody)).toHaveLength(4);
  });
  it("clamps exhausted quantities and excludes drafts/cancellations from count and value", async () => {
    const result = await getInventorySummary(f.db, input({ departmentId: 1 }));
    expect(result.total).toMatchObject({
      assetRecords: 2,
      assetQuantity: 5,
      assetValue: "50.50",
      custodyQuantity: 5,
    });
    f.sqlite.exec("UPDATE assets SET excludedQuantity=20 WHERE id=1");
    expect(
      (
        await getInventorySummary(
          f.db,
          input({ type: "assets", departmentId: 1 })
        )
      ).total.assetValue
    ).toBe("0.00");
  });
  it("preserves exact amounts above JavaScript's safe integer range", () => {
    const row = {
      groupId: 1,
      groupName: "قسم",
      groupCode: "D1",
      records: 1,
      quantity: 1,
      value: "9007199254740993.10",
    };
    const result = mergeSummaryGroups([row], [{ ...row, value: "0.20" }]);
    expect(result.total.totalValue).toBe("9007199254740993.30");
  });
  it("returns filter IDs/names/codes only, without employee private fields", async () => {
    const result = await getInventorySummaryOptions(f.db);
    expect(result.employee[0]).toEqual({ id: 11, name: "أحمد", code: null });
    expect(Object.keys(result)).toHaveLength(5);
  });
  it("keeps the record departments when a single employee receives items from both", async () => {
    f.sqlite.exec("UPDATE assets SET assignedTo=11 WHERE id=2");
    const byDepartment = await getInventorySummary(f.db, input({ employeeId: 11, groupBy: "department" }));
    expect(byDepartment.rows.map(row => [row.groupId, row.totalValue])).toEqual([[1, "62.00"], [2, "40.40"]]);
    const byEmployee = await getInventorySummary(f.db, input({ employeeId: 11, groupBy: "employee" }));
    expect(byEmployee.rows).toMatchObject([{ groupId: 11, groupCode: null, totalValue: "102.40" }]);
  });
  it("exports the exact filtered snapshot, with numeric cells, RTL and totals", async () => {
    const result = await getInventorySummary(f.db, input({ departmentId: 1 }));
    const wb = await createInventorySummaryWorkbook(
      result,
      "القسم: الإدارة (D1)"
    );
    const bytes = await wb.xlsx.writeBuffer();
    const loaded = new ExcelJS.Workbook();
    await loaded.xlsx.load(bytes as any);
    const ws = loaded.worksheets[0];
    expect(ws.views[0].rightToLeft).toBe(true);
    expect(ws.getCell("A2").value).toBe("القسم: الإدارة (D1)");
    expect(ws.getCell("B7").value).toBe(2);
    expect(ws.getCell("C7").value).toBe(5);
    expect(ws.getCell("H7").value).toBe(62);
    expect(ws.getCell("H8").value).toBe(62);
    expect(ws.getCell("A8").value).toBe("الإجمالي العام");
    expect(ws.pageSetup.printTitlesRow).toBe("5:6");
  });
  it("prints escaped content and stores formula-like names as literal Excel text", async () => {
    const result = await getInventorySummary(f.db, input({ departmentId: 1 }));
    result.rows[0].groupName = "<script>alert(1)</script>";
    const html = inventorySummaryPrint(result, "<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("62.00");
    result.rows[0].groupName = '=HYPERLINK("https://example.com")';
    const wb = await createInventorySummaryWorkbook(result, "اختبار");
    expect(wb.worksheets[0].getCell("A7").type).toBe(ExcelJS.ValueType.String);
  });
  it("keeps large Excel amounts as exact text", async () => {
    const result = await getInventorySummary(f.db, input());
    result.rows[0].assetValue = "9007199254740993.10";
    const wb = await createInventorySummaryWorkbook(result, "اختبار");
    expect(wb.worksheets[0].getCell("D7").value).toBe("9007199254740993.10");
  });
  const caller = (role: string | null) =>
    recordsRouter.createCaller({
      user: role ? { id: 1, role } : null,
      req: {},
      res: {},
    } as TrpcContext).reports;
  for (const role of ["owner", "admin", "accounting_manager", "accountant"]) {
    it(`allows the existing report role ${role}`, async () => {
      expect((await caller(role).summary(input())).total.totalValue).toBe(
        "102.70"
      );
    });
  }
  it("enforces report permissions and validates IDs and grouping", async () => {
    await expect(caller(null).summary(input())).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(caller("employee").summary(input())).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(caller("employee").summaryOptions()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      caller("accountant").summary({ groupBy: "unknown" } as any)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller("accountant").summary({ ...input(), departmentId: -1 })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
