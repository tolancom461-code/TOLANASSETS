import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";
import { transactionDatabase } from "./test-utils/transactionDatabase";
import { generateArchiveReport } from "../client/src/lib/archiveReport";

const state = vi.hoisted(() => ({ db: null as any }));
vi.mock("./db", () => ({ getDb: async () => state.db }));
vi.mock("./security", () => ({ logAuditAction: vi.fn() }));
import { operationsRouter } from "./routers/operations";

describe("Historical transfer integrity", () => {
  const ctx = { user: { id: 1, name: "مسؤول النظام", role: "owner" }, req: { ip: "127.0.0.1", headers: { "user-agent": "test" } }, res: {} } as TrpcContext;
  const input = { entityType: "asset" as const, entityId: 1, movementType: "partial" as const, fromEmployeeId: 10,
    toEmployeeId: 20, toDepartmentId: 200, toLocationId: 2000 };
  const caller = () => operationsRouter.createCaller(ctx).transfers;
  const initial = () => ({
    assets: [{ id: 1, assetName: "حاسب تاريخي", assetCode: "A1", quantity: 10, excludedQuantity: 3, assetValue: "500.00", status: "ACTIVE", assignedTo: 10, departmentId: 100, locationId: 1000 }],
    custody_items: [{ id: 1, name: "عهدة تاريخية", code: "C1", quantity: 10, excludedQuantity: 3, assetValue: "300.00", status: "ACTIVE", assignedTo: 10, departmentId: 100, locationId: 1000 }],
    employees: [{ id: 10, fullName: "المسؤول السابق" }, { id: 20, fullName: "المسؤول الجديد" }],
    departments: [{ id: 100, name: "القسم القديم", branchId: 1 }, { id: 200, name: "القسم الجديد", branchId: 2 }],
    branches: [{ id: 1, locationId: 1000, name: "الفرع القديم" }, { id: 2, locationId: 2000, name: "الفرع الجديد" }],
    locations: [{ id: 1000, name: "الموقع القديم" }, { id: 2000, name: "الموقع الجديد" }],
    asset_transfers: [], audit_log: [],
  });
  beforeEach(() => { state.db = transactionDatabase(initial()); });

  for (const entityType of ["asset", "custody"] as const) {
    it(`${entityType}: locks inventory and records actual remaining quantity with audit`, async () => {
      const result = await caller().create({ ...input, entityType });
      const rows = state.db.rows();
      expect(rows[entityType === "asset" ? "assets" : "custody_items"][0]).toMatchObject({ assignedTo: 20, departmentId: 200, locationId: 2000, quantity: 10, excludedQuantity: 3, status: "ACTIVE" });
      expect(result).toMatchObject({ count: 1, quantityMoved: 7, affectedEntityIds: [1] });
      expect(rows.asset_transfers[0]).toMatchObject({ fromEmployeeId: 10, toEmployeeId: 20, fromDepartment: "القسم القديم", fromLocation: "الموقع القديم", quantity: 7 });
      expect(rows.audit_log[0]).toMatchObject({ recordId: result.id, actionType: "TRANSFER", performedBy: 1 });
      expect(rows.audit_log[0].oldData).toMatchObject({ assignedTo: 10 });
      expect(rows.audit_log[0].newData).toMatchObject({ entityType, entityId: 1, transferSnapshot: { fromEmployeeName: "المسؤول السابق", toEmployeeName: "المسؤول الجديد" } });
      expect(state.db.locks).toContain(`${entityType === "asset" ? "assets" : "custody_items"}:update`);
    });
    it(`${entityType}: rejects excluded and empty individual records`, async () => {
      const row = state.db.rows()[entityType === "asset" ? "assets" : "custody_items"][0];
      row.status = "EXCLUDED";
      await expect(caller().create({ ...input, entityType })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      row.status = "ACTIVE"; row.excludedQuantity = 10;
      await expect(caller().create({ ...input, entityType })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(state.db.rows().asset_transfers).toHaveLength(0);
    });
    it(`${entityType}: total transfer leaves excluded/empty/other employees' records unchanged`, async () => {
      const name = entityType === "asset" ? "assets" : "custody_items";
      const rows = state.db.rows()[name], first = rows[0];
      rows.push({ ...first, id: 2, status: "EXCLUDED" }, { ...first, id: 3, excludedQuantity: 10 }, { ...first, id: 4, assignedTo: 30 }, { ...first, id: 5, quantity: 4, excludedQuantity: 1 });
      const result = await caller().create({ ...input, entityType, movementType: "total" });
      expect(result).toMatchObject({ count: 2, quantityMoved: 10, affectedEntityIds: [1, 5] });
      expect(rows.filter((row: any) => [2, 3, 4].includes(row.id)).map((row: any) => row.assignedTo)).toEqual([10, 10, 30]);
      expect(state.db.rows().asset_transfers.map((row: any) => row.entityId)).toEqual([1, 5]);
      expect(state.db.rows().audit_log).toHaveLength(2);
    });
  }
  it("rejects stale source and repeated execution", async () => {
    await expect(caller().create({ ...input, fromEmployeeId: 30 })).rejects.toMatchObject({ code: "CONFLICT" });
    await caller().create(input);
    await expect(caller().create(input)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(state.db.rows().asset_transfers).toHaveLength(1);
  });
  it("rejects unchanged assignment, missing receiver and inconsistent destination", async () => {
    await expect(caller().create({ ...input, toEmployeeId: 10, toDepartmentId: 100, toLocationId: 1000 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().create({ ...input, toEmployeeId: 999 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().create({ ...input, toLocationId: 1000 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(state.db.rows().asset_transfers).toHaveLength(0);
  });
  it("requires a source for total transfer and rejects unsupported item baskets", async () => {
    await expect(caller().create({ ...input, movementType: "total", fromEmployeeId: null })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().create({ ...input, items: [{ entityId: 1 }] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().create({ ...input, fromEmployeeId: undefined } as any)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("allows relocation for the same employee and audits only actual changes", async () => {
    await caller().create({ ...input, toEmployeeId: 10 });
    expect(state.db.rows().audit_log[0].changedFields).toEqual(["departmentId", "locationId"]);
  });
  it("rejects an empty total transfer and a nonexistent source", async () => {
    state.db.rows().assets[0].status = "EXCLUDED";
    await expect(caller().create({ ...input, movementType: "total" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().create({ ...input, movementType: "total", fromEmployeeId: 999 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(state.db.rows().asset_transfers).toHaveLength(0);
  });
  it("rejects a destination whose referenced location no longer exists", async () => {
    state.db.rows().locations = state.db.rows().locations.filter((row: any) => row.id !== 2000);
    await expect(caller().create(input)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(state.db.rows().assets[0].assignedTo).toBe(10);
    expect(state.db.rows().asset_transfers).toHaveLength(0);
  });
  for (const table of ["asset_transfers", "assets", "audit_log"]) {
    it(`failure writing ${table} rolls back movement, assignment and audit`, async () => {
      const before = structuredClone(state.db.rows());
      state.db.failOn(table);
      await expect(caller().create(input)).rejects.toThrow(`Injected ${table} failure`);
      expect(state.db.rows()).toEqual(before);
    });
  }
  it("a late bulk audit failure rolls back every earlier transfer in the group", async () => {
    state.db.rows().assets.push({ ...state.db.rows().assets[0], id: 2 });
    const before = structuredClone(state.db.rows());
    state.db.failOn("audit_log", 2);
    await expect(caller().create({ ...input, movementType: "total" })).rejects.toThrow("Injected audit_log failure");
    expect(state.db.rows()).toEqual(before);
  });
  it("blocks historical edits through the API", async () => {
    const result = await caller().create(input);
    const before = structuredClone(state.db.rows());
    await expect(caller().update({ id: result.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.db.rows()).toEqual(before);
  });
  it("details and list retain saved names after source data is renamed", async () => {
    const result = await caller().create(input);
    state.db.rows().employees[0].fullName = "اسم مختلف";
    state.db.rows().employees[1].fullName = "اسم مستلم مختلف";
    state.db.rows().assets[0].assetName = "اسم أصل مختلف";
    for (const record of [await caller().getById({ id: result.id }), (await caller().list())[0]]) {
      expect(record).toMatchObject({ entityName: "حاسب تاريخي", entityCode: "A1", fromEmployeeName: "المسؤول السابق", toEmployeeName: "المسؤول الجديد", historicalSnapshot: true });
    }
  });
  it("ignores client-supplied quantity/value/source names and uses locked data", async () => {
    await caller().create({ ...input, quantity: 999, assetValue: "999", fromDepartment: "مزور" } as any);
    expect(state.db.rows().asset_transfers[0]).toMatchObject({ quantity: 7, assetValue: "500.00", fromDepartment: "القسم القديم" });
  });
  it("employees cannot execute transfers", async () => {
    const employee = operationsRouter.createCaller({ ...ctx, user: { ...ctx.user!, role: "employee" } });
    await expect(employee.transfers.create(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.db.rows().asset_transfers).toHaveLength(0);
  });

  describe("Total transfer by department", () => {
    const source = { fromEmployeeId: 10 };
    const recipients = [{ departmentId: 100, toEmployeeId: 20 }, { departmentId: 200, toEmployeeId: 30 }];

    beforeEach(() => {
      const rows = state.db.rows();
      rows.employees[0].departmentId = 999;
      rows.employees.push({ id: 30, fullName: "مستلم القسم الآخر" });
      rows.custody_items.push({ ...rows.custody_items[0], id: 2, departmentId: 200, locationId: 2000, quantity: 6, excludedQuantity: 1, warrantyReplacedQuantity: 2 });
      rows.assets.push(
        { ...rows.assets[0], id: 2, status: "DRAFT" },
        { ...rows.assets[0], id: 3, quantity: 3, excludedQuantity: 3 },
        { ...rows.assets[0], id: 4, assignedTo: 20 },
        { ...rows.assets[0], id: 5, departmentId: 200 },
      );
    });

    it("previews both inventory types and assigns all valid records to each department's recipient", async () => {
      const preview = await caller().previewTotal(source);
      expect(preview.incompleteCount).toBe(1);
      expect(preview.groups).toEqual([
        { departmentId: 100, departmentName: "القسم القديم", branchId: 1, branchName: "الفرع القديم", locationId: 1000, locationName: "الموقع القديم", assetCount: 1, custodyCount: 1 },
        { departmentId: 200, departmentName: "القسم الجديد", branchId: 2, branchName: "الفرع الجديد", locationId: 2000, locationName: "الموقع الجديد", assetCount: 0, custodyCount: 1 },
      ]);

      const request = { ...source, snapshot: preview.snapshot, recipients };
      const result = await caller().executeTotal(request);
      const rows = state.db.rows();
      expect(result).toEqual({ count: 3, quantityMoved: 17, transferIds: [1, 2, 3], documentId: 4 });
      expect(rows.assets.map((row: any) => row.assignedTo)).toEqual([20, 10, 10, 20, 10]);
      expect(rows.assets[0]).toMatchObject({ departmentId: 100, locationId: 1000, assetCode: "A1" });
      expect(rows.custody_items[1]).toMatchObject({ assignedTo: 30, departmentId: 200, locationId: 2000 });
      expect(rows.asset_transfers.map((row: any) => [row.entityType, row.entityId, row.movementType, row.toEmployeeId, row.quantity])).toEqual([
        ["asset", 1, "total", 20, 7], ["custody", 1, "total", 20, 7], ["custody", 2, "total", 30, 3],
      ]);
      expect(rows.audit_log.map((row: any) => row.changedFields)).toEqual([["assignedTo"], ["assignedTo"], ["assignedTo"]]);
      expect(rows.archive_documents.slice(0, 3).map((row: any) => row.transferId)).toEqual(result.transferIds);
      expect(rows.archive_documents[3]).toMatchObject({ id: result.documentId, entityType: "total_transfer", snapshot: { eventType: "TOTAL_TRANSFER", newData: { quantityMoved: 17 } } });
      expect(state.db.locks).toEqual(expect.arrayContaining(["assets:update", "custody_items:update"]));
      expect((await caller().previewTotal(source)).groups).toEqual([]);
      await expect(caller().executeTotal(request)).rejects.toMatchObject({ code: "CONFLICT" });
      expect(state.db.rows().asset_transfers).toHaveLength(3);
    });

    it("rejects stale inventory even when the department and record counts are unchanged", async () => {
      const { snapshot } = await caller().previewTotal(source);
      state.db.rows().custody_items[0].warrantyReplacedQuantity = 1;
      await expect(caller().executeTotal({ ...source, snapshot, recipients })).rejects.toMatchObject({ code: "CONFLICT" });
      expect(state.db.rows().asset_transfers).toHaveLength(0);
    });

    it("requires each department exactly once and a valid, different recipient", async () => {
      const { snapshot } = await caller().previewTotal(source);
      for (const invalid of [
        recipients.slice(0, 1),
        [recipients[0], recipients[0]],
        [recipients[0], { departmentId: 250, toEmployeeId: 30 }],
        [recipients[0], { departmentId: 200, toEmployeeId: 10 }],
        [recipients[0], { departmentId: 200, toEmployeeId: 999 }],
      ]) {
        await expect(caller().executeTotal({ ...source, snapshot, recipients: invalid })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      }
      expect(state.db.rows().asset_transfers).toHaveLength(0);
    });

    it("rolls back changes across departments if the last archive write fails", async () => {
      const { snapshot } = await caller().previewTotal(source);
      const before = structuredClone(state.db.rows());
      state.db.failOn("archive_documents", 3);
      await expect(caller().executeTotal({ ...source, snapshot, recipients })).rejects.toThrow("Injected archive_documents failure");
      expect(state.db.rows()).toEqual(before);
    });

    it("applies the financial history guard across asset and custody records", async () => {
      const rows = state.db.rows();
      rows.depreciation_batches = [{ entityType: "custody", entityId: 2, status: "APPROVED" }];
      rows.depreciation_periods = [{ month: "9999-12", status: "CLOSED" }];
      const { snapshot } = await caller().previewTotal(source);
      await expect(caller().executeTotal({ ...source, snapshot, recipients })).rejects.toThrow("إهلاك معتمدة");
      expect(state.db.rows().asset_transfers).toHaveLength(0);
    });

    async function clearanceInput(reason: string) {
      const rows = state.db.rows();
      rows.assets = rows.assets.filter((row: any) => row.id !== 5);
      const clearance = operationsRouter.createCaller(ctx).clearance;
      const inventory = await clearance.getEmployeeItems({ employeeId: 10 });
      return {
        clearance,
        inventory,
        input: {
          clearanceCode: "CLR-TEST-TRANSFER", employeeId: 10, employeeName: "اسم من العميل",
          reason, lastWorkDay: "2026-10-31",
          review: {
            snapshot: inventory.snapshot,
            recipients: recipients.map(row => ({ groupKey: String(row.departmentId), toEmployeeId: row.toEmployeeId })),
            statements: ["بند الاختبار"], signatures: ["المسؤول"],
          },
        },
      };
    }

    it.each(["خروج نهائي", "انتهاء عمل"])("moves inventory and archives a linked transfer document when saving %s", async reason => {
      const { clearance, input } = await clearanceInput(reason);
      const result = await clearance.create(input);
      const rows = state.db.rows();
      expect(result).toMatchObject({ id: 1, transferredCount: 3, transferDocumentId: 4 });
      expect(rows.asset_transfers.map((row: any) => [row.movementType, row.toEmployeeId, row.notes])).toEqual([
        ["total", 20, "براءة الذمة CLR-TEST-TRANSFER"],
        ["total", 20, "براءة الذمة CLR-TEST-TRANSFER"],
        ["total", 30, "براءة الذمة CLR-TEST-TRANSFER"],
      ]);
      const doc = rows.archive_documents.find((row: any) => row.id === result.transferDocumentId);
      expect(doc).toMatchObject({
        entityType: "total_transfer", operationType: "نقل كلي",
        snapshot: { eventType: "TOTAL_TRANSFER", newData: {
          clearanceCode: input.clearanceCode, fromEmployeeName: "المسؤول السابق", rows: [
            { transferId: 1, entityType: "asset", entityCode: "A1", targetEmployeeName: "المسؤول الجديد", quantity: 7 },
            { transferId: 2, entityType: "custody", entityCode: "C1", targetEmployeeName: "المسؤول الجديد", quantity: 7 },
            { transferId: 3, entityType: "custody", targetEmployeeName: "مستلم القسم الآخر", quantity: 3 },
          ],
        } },
      });
      const printed = generateArchiveReport(doc);
      expect(printed).toContain("براءة الذمة المرتبطة");
      expect(printed).toContain(input.clearanceCode);
      expect(printed).toContain("مستلم القسم الآخر");
      expect(printed).toContain("الفرع الجديد");
      expect(rows.archive_documents).toHaveLength(4);
      expect(rows.audit_log.at(-1)).toMatchObject({ actionType: "CLEARANCE", newData: { transferDocumentId: 4 } });

      rows.assets[0].assetName = "اسم بعد النقل";
      const saved = await clearance.getById({ id: result.id });
      expect(saved.record).toMatchObject({ employeeName: "المسؤول السابق", reason });
      expect(saved.assets).toMatchObject([{ id: 1, name: "حاسب تاريخي", quantity: 7, groupKey: "100" }]);
      expect(saved.custody).toHaveLength(2);
      expect(saved.departmentAlternates).toEqual({ "100": "المسؤول الجديد", "200": "مستلم القسم الآخر" });
      expect(saved.transferDocumentId).toBe(4);
      await expect(clearance.create(input)).resolves.toMatchObject(result);
      expect(rows.clearance_records).toHaveLength(1);
      expect(rows.asset_transfers).toHaveLength(3);
    });

    it.each(["خروج وعودة", "إجازة داخلية"])("documents the replacements without moving inventory for %s", async reason => {
      const { clearance, input } = await clearanceInput(reason);
      const result = await clearance.create(input);
      const rows = state.db.rows();
      expect(result).toMatchObject({ transferredCount: 0, transferDocumentId: null });
      expect(rows.assets[0].assignedTo).toBe(10);
      expect(rows.custody_items.every((row: any) => row.assignedTo === 10)).toBe(true);
      expect(rows.asset_transfers).toHaveLength(0);
      expect(rows.archive_documents ?? []).toHaveLength(0);
      expect((await clearance.getById({ id: result.id })).departmentAlternates).toEqual({ "100": "المسؤول الجديد", "200": "مستلم القسم الآخر" });
    });

    it.each(["archive_documents", "clearance_records"])("rolls back the clearance and total transfer if persistence fails at %s", async table => {
      const { clearance, input } = await clearanceInput("انتهاء عمل");
      const before = structuredClone(state.db.rows());
      state.db.failOn(table, table === "archive_documents" ? 4 : 1);
      await expect(clearance.create(input)).rejects.toThrow("Injected " + table + " failure");
      expect(state.db.rows()).toEqual(before);
    });

    it("saves a permanent clearance for a source with no inventory without producing an empty transfer document", async () => {
      const { clearance, input } = await clearanceInput("خروج نهائي");
      const rows = state.db.rows();
      rows.assets = [];
      rows.custody_items = [];
      const inventory = await clearance.getEmployeeItems({ employeeId: 10 });
      const result = await clearance.create({ ...input, review: { ...input.review, snapshot: inventory.snapshot, recipients: [] } });
      expect(result).toMatchObject({ id: 1, transferDocumentId: null, transferredCount: 0 });
      expect(rows.asset_transfers).toHaveLength(0);
    });

    it("requires reviewed inventory and refuses a permanent clearance while an active record lacks a valid allocation", async () => {
      const { clearance, input } = await clearanceInput("خروج نهائي");
      await expect(clearance.create({ ...input, review: undefined })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      state.db.rows().assets[0].locationId = null;
      const inventory = await clearance.getEmployeeItems({ employeeId: 10 });
      expect(inventory.incompleteCount).toBe(1);
      const keys = new Set([...inventory.assets, ...inventory.custody].map(row => row.groupKey));
      await expect(clearance.create({ ...input, review: {
        ...input.review, snapshot: inventory.snapshot,
        recipients: [...keys].map(groupKey => ({ groupKey, toEmployeeId: 20 })),
      } })).rejects.toThrow("صحّح تخصيص الموقع");
      expect(state.db.rows().asset_transfers).toHaveLength(0);
    });

  });

});
