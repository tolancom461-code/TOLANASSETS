import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { transactionDatabase } from "./test-utils/transactionDatabase";
import type { TrpcContext } from "./_core/context";
import { remainingQuantity } from "../shared/inventoryQuantity";
import {
  canSelectConversion,
  conversionDraft,
} from "../shared/inventoryConversion";
import { sourceRecord } from "./depreciationStore";
import { getNumberingPeriod } from "./numbering";
const state = vi.hoisted(() => ({ db: null as any }));
vi.mock("./db", () => ({ getDb: async () => state.db }));
import { inventoryConversionRouter } from "./inventoryConversion";

function fixture() {
  const row = (id: number, nameKey: string, codeKey: string) => ({
    id,
    [nameKey]: `صنف ${id}`,
    [codeKey]: `${codeKey}-${id}`,
    quantity: 10,
    excludedQuantity: 3,
    warrantyReplacedQuantity: 2,
    assetValue: "13.37",
    status: "ACTIVE",
    draftVersion: 0,
    classificationId: 5,
    assignedTo: id === 1 ? 10 : 20,
    departmentId: 100,
    locationId: 1000,
    originLocationId: 1000,
    condition: "جيد",
    assetImagePath: "/api/files/source.webp",
    invoiceImagePath: "/api/files/invoice.webp",
    serialNumbers: null,
    warrantyStartDate: "2026-01-01",
    warrantyEndDate: "2027-01-01",
    notes: "ملاحظات محفوظة",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  });
  return transactionDatabase({
    assets: [
      row(1, "assetName", "assetCode"),
      row(2, "assetName", "assetCode"),
    ],
    custody_items: [row(1, "name", "code"), row(2, "name", "code")],
    locations: [
      {
        id: 1000,
        name: "الموقع الأول",
        assetPrefix: "AST",
        custodyPrefix: "CUS",
        assetSequence: 0,
        custodySequence: 0,
      },
      {
        id: 2000,
        name: "الموقع الثاني",
        assetPrefix: "NEW-A",
        custodyPrefix: "NEW-C",
        assetSequence: 0,
        custodySequence: 0,
      },
    ],
    branches: [
      { id: 50, name: "الفرع الأول", locationId: 1000 },
      { id: 60, name: "الفرع الثاني", locationId: 2000 },
    ],
    departments: [
      { id: 100, name: "القسم الأول", branchId: 50 },
      { id: 200, name: "القسم الثاني", branchId: 60 },
    ],
    employees: [
      { id: 10, fullName: "موظف أول", departmentId: 100 },
      { id: 20, fullName: "موظف ثان", departmentId: 200 },
    ],
    financial_classifications: [
      { id: 5, name: "أثاث", code: "F", active: true },
    ],
    depreciation_batches: [],
    depreciation_control: [{ id: 1, revision: 0 }],
    app_settings: [{ id: 1 }],
    exclusion_drafts: [],
    warranty_replacements: [],
    inventory_sessions: [],
    inventory_differences: [],
    inventory_difference_actions: [],
    inventory_conversions: [],
    inventory_conversion_items: [],
    inventory_approval_numbers: [],
    audit_log: [],
    archive_documents: [],
  });
}
const context = (role = "accountant", id = 2) =>
  ({
    user: { id, role, name: `مستخدم ${id}` },
    req: { headers: {}, ip: "127.0.0.1" },
    res: {},
  }) as TrpcContext;
const caller = (role = "accountant", id = 2) =>
  inventoryConversionRouter.createCaller(context(role, id));
const draft = (overrides: object = {}) =>
  conversionDraft.parse({
    sourceType: "asset",
    ids: [1],
    allocationMode: "KEEP",
    employeeMode: "KEEP",
    notes: "تصحيح نوع السجل",
    ...overrides,
  });
async function prepared(request = draft()) {
  return {
    request,
    previewHash: (await caller().preview(request)).previewHash,
    requestKey: randomUUID(),
  };
}

describe("Safe inventory type conversion", () => {
  beforeEach(() => {
    state.db = fixture();
  });
  for (const sourceType of ["asset", "custody"] as const) {
    it(`${sourceType}: converts only remaining quantity and preserves source history, each employee, value and attachments`, async () => {
      const oldTable = sourceType === "asset" ? "assets" : "custody_items",
        targetTable = sourceType === "asset" ? "custody_items" : "assets";
      const originals = structuredClone(state.db.rows()[oldTable]);
      const result = await caller("accounting_manager", 3).execute(
        await prepared(draft({ sourceType, ids: [1, 2] }))
      );
      expect(result.results).toHaveLength(2);
      expect(state.db.rows()[oldTable].map((r: any) => r.status)).toEqual([
        "CONVERTED",
        "CONVERTED",
      ]);
      for (const [i, original] of originals.entries()) {
        const source = state.db.rows()[oldTable][i],
          target = state.db.rows()[targetTable][i + 2];
        expect(source).toMatchObject({
          quantity: original.quantity,
          excludedQuantity: 3,
          warrantyReplacedQuantity: 2,
          status: "CONVERTED",
        });
        expect(remainingQuantity(source)).toBe(0);
        expect(canSelectConversion(source)).toBe(false);
        expect(target).toMatchObject({
          quantity: 5,
          excludedQuantity: 0,
          warrantyReplacedQuantity: 0,
          assetValue: "13.37",
          assignedTo: original.assignedTo,
          status: "ACTIVE",
          approvedBy: 3,
          classificationId: 5,
          assetImagePath: original.assetImagePath,
          invoiceImagePath: original.invoiceImagePath,
          warrantyStartDate: original.warrantyStartDate,
          warrantyEndDate: original.warrantyEndDate,
          notes: original.notes,
        });
        expect(target[sourceType === "asset" ? "code" : "assetCode"]).toMatch(
          new RegExp(
            `^${sourceType === "asset" ? "CUS" : "AST"}-${getNumberingPeriod()}`
          )
        );
      }
      expect(state.db.rows().audit_log.map((r: any) => r.actionType)).toEqual([
        "CONVERT_OUT",
        "CONVERT_IN",
        "CONVERT_OUT",
        "CONVERT_IN",
      ]);
      expect(state.db.rows().archive_documents).toHaveLength(4);
      expect(state.db.rows().inventory_approval_numbers).toHaveLength(2);
      expect(state.db.rows().depreciation_batches).toHaveLength(0);
    });
  }
  it("changes destination and employee explicitly, or retains each employee independently of department", async () => {
    const request = draft({
      ids: [1, 2],
      allocationMode: "CHANGE",
      locationId: 2000,
      branchId: 60,
      departmentId: 200,
    });
    const result = await caller("owner", 1).execute(await prepared(request));
    expect(result.results).toHaveLength(2);
    expect(
      state.db
        .rows()
        .custody_items.slice(2)
        .map((r: any) => [r.locationId, r.departmentId, r.assignedTo])
    ).toEqual([
      [2000, 200, 10],
      [2000, 200, 20],
    ]);
    state.db = fixture();
    await caller("owner", 1).execute(
      await prepared(draft({ employeeMode: "CHANGE", employeeId: 20 }))
    );
    expect(state.db.rows().custody_items[2]).toMatchObject({
      assignedTo: 20,
      departmentId: 100,
      locationId: 1000,
    });
  });
  it("persists an accountant request without consuming codes; manager executes once", async () => {
    const data = await prepared();
    const request = await caller().submit(data);
    expect(request.status).toBe("PENDING");
    expect(state.db.rows().assets[0].status).toBe("ACTIVE");
    expect(state.db.rows().locations[0].custodySequence).toBe(0);
    expect(await caller().submit(data)).toMatchObject({
      id: request.id,
      status: "PENDING",
    });
    await caller("accounting_manager", 3).approve({
      id: request.id,
      expectedVersion: 0,
    });
    const after = structuredClone(state.db.rows());
    await caller("accounting_manager", 3).approve({
      id: request.id,
      expectedVersion: 0,
    });
    expect(state.db.rows()).toEqual(after);
  });
  it("direct execution is idempotent and rejects reuse of the key with different data", async () => {
    const data = await prepared();
    const manager = caller("admin", 3);
    await manager.execute(data);
    const after = structuredClone(state.db.rows());
    state.db.rows().inventory_conversions[0].payload = Object.fromEntries(
      Object.entries(state.db.rows().inventory_conversions[0].payload).reverse()
    );
    after.inventory_conversions[0].payload = structuredClone(
      state.db.rows().inventory_conversions[0].payload
    );
    await manager.execute(data);
    expect(state.db.rows()).toEqual(after);
    await expect(
      manager.execute({
        ...data,
        request: { ...data.request, notes: "سبب مختلف" },
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  for (const status of ["DRAFT", "SUBMITTED", "APPROVED"]) {
    it(`blocks any ${status} financial profile before allocating a number`, async () => {
      state.db.rows().depreciation_batches.push({
        id: 1,
        entityType: "asset",
        entityId: 1,
        status,
      });
      const request = draft();
      const preview = await caller().preview(request);
      expect(preview.valid).toBe(false);
      expect(preview.rows[0].errors.join()).toContain("إهلاك");
      await expect(
        caller("owner", 1).execute({
          request,
          previewHash: preview.previewHash,
          requestKey: randomUUID(),
        })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(state.db.rows().inventory_conversions).toHaveLength(0);
      expect(state.db.rows().custody_items).toHaveLength(2);
    });
  }
  it("does not confuse identical IDs in the other type with financial linkage", async () => {
    state.db.rows().depreciation_batches.push({
      id: 1,
      entityType: "custody",
      entityId: 1,
      status: "APPROVED",
    });
    expect((await caller().preview(draft())).valid).toBe(true);
  });
  for (const status of [
    "DRAFT",
    "CANCELLED",
    "EXCLUDED",
    "REPLACED",
    "CONVERTED",
  ]) {
    it(`refuses source status ${status}`, async () => {
      state.db.rows().assets[0].status = status;
      expect((await caller().preview(draft())).valid).toBe(false);
    });
  }
  for (const setup of [
    (db: any) =>
      db.rows().exclusion_drafts.push({
        id: 1,
        createdBy: 999,
        payload: { entityType: "asset", entityId: 1 },
      }),
    (db: any) =>
      db.rows().warranty_replacements.push({
        id: 1,
        entityType: "asset",
        entityId: 1,
        status: "DRAFT",
      }),
    (db: any) =>
      db.rows().warranty_replacements.push({
        id: 1,
        entityType: "asset",
        entityId: 1,
        status: "SUBMITTED",
      }),
    (db: any) =>
      db.rows().inventory_sessions.push({
        id: 1,
        status: "DRAFT",
        sessionType: "assets",
        items: [{ id: 1, entityType: "asset" }],
      }),
    (db: any) =>
      db.rows().inventory_sessions.push({
        id: 1,
        status: "SUBMITTED",
        sessionType: "both",
        items: [{ id: 1 }],
      }),
    (db: any) =>
      db.rows().inventory_differences.push({
        id: 1,
        entityType: "asset",
        entityId: 1,
      }),
  ])
    it("blocks a pending operational request/session or unresolved difference", async () => {
      setup(state.db);
      expect((await caller().preview(draft())).valid).toBe(false);
    });
  it("blocks duplicate pending requests and permits cancellation before resubmission", async () => {
    const request = await caller().submit(await prepared());
    expect((await caller().preview(draft())).valid).toBe(false);
    await expect(
      caller("accountant", 9).cancel({ id: request.id, expectedVersion: 0 })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await caller().cancel({ id: request.id, expectedVersion: 0 });
    expect((await caller().preview(draft())).valid).toBe(true);
    expect(state.db.rows().audit_log.at(-1).actionType).toBe("CONVERT_CANCEL");
  });
  it("rejects stale preview and stale submitted source without partial updates", async () => {
    const data = await prepared();
    state.db.rows().assets[0].excludedQuantity++;
    await expect(caller("owner", 1).execute(data)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(state.db.rows().inventory_conversions).toHaveLength(0);
    const queued = await caller().submit(await prepared());
    state.db.rows().assets[0].assignedTo = 20;
    await expect(
      caller("owner", 1).approve({ id: queued.id, expectedVersion: 0 })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(state.db.rows().assets[0].status).toBe("ACTIVE");
    expect(state.db.rows().custody_items).toHaveLength(2);
  });
  it("rechecks financial links created after submission", async () => {
    const request = await caller().submit(await prepared());
    state.db.rows().depreciation_batches.push({
      id: 1,
      entityType: "asset",
      entityId: 1,
      status: "DRAFT",
    });
    await expect(
      caller("owner", 1).approve({ id: request.id, expectedVersion: 0 })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(state.db.rows().inventory_approval_numbers).toHaveLength(0);
  });
  it("validates the destination hierarchy, employee and code prefix", async () => {
    expect(
      (
        await caller().preview(
          draft({
            allocationMode: "CHANGE",
            locationId: 1000,
            branchId: 60,
            departmentId: 200,
          })
        )
      ).valid
    ).toBe(false);
    expect(
      (
        await caller().preview(
          draft({ employeeMode: "CHANGE", employeeId: 999 })
        )
      ).valid
    ).toBe(false);
    state.db.rows().locations[0].custodyPrefix = null;
    expect((await caller().preview(draft())).valid).toBe(false);
  });
  it("requires explicit serial selection after partial exclusion and retires warranty serials", async () => {
    state.db.rows().assets[0].serialNumbers = Array.from(
      { length: 10 },
      (_, i) => `SN${i + 1}`
    );
    state.db.rows().warranty_replacements.push({
      id: 1,
      entityType: "asset",
      entityId: 1,
      status: "EXECUTED",
      payload: { originalSerialNumbers: ["SN1", "SN2"] },
    });
    const review = await caller().preview(draft());
    expect(review.valid).toBe(false);
    expect(review.rows[0].candidates).not.toContain("SN1");
    const serials = ["SN3", "SN4", "SN5", "SN6", "SN7"];
    await caller("owner", 1).execute(
      await prepared(draft({ serials: { "1": serials } }))
    );
    expect(state.db.rows().custody_items[2].serialNumbers).toEqual(serials);
    expect(state.db.rows().assets[0].serialNumbers).toHaveLength(10);
  });
  for (const serials of [
    ["SN1", "SN1"],
    ["UNKNOWN"],
    ["SN1", "SN2", "SN3", "SN4", "SN5", "SN6"],
  ]) {
    it("rejects duplicate, foreign or excessive unit identifiers", async () => {
      state.db.rows().assets[0].serialNumbers = Array.from(
        { length: 10 },
        (_, i) => `SN${i + 1}`
      );
      expect(
        (await caller().preview(draft({ serials: { "1": serials } }))).valid
      ).toBe(false);
    });
  }
  for (const [table, attempt] of [
    ["audit_log", 3],
    ["inventory_approval_numbers", 2],
    ["inventory_conversion_items", 3],
    ["archive_documents", 2],
  ] as const) {
    it(`rolls back the complete batch, allocations and numbering on ${table} failure`, async () => {
      const data = await prepared(draft({ ids: [1, 2] }));
      const before = structuredClone(state.db.rows());
      state.db.failOn(table, attempt);
      await expect(caller("owner", 1).execute(data)).rejects.toThrow();
      expect(state.db.rows()).toEqual(before);
    });
  }
  it("exposes history links both ways and refuses financial attachment to the historical source", async () => {
    const result = await caller("owner", 1).execute(await prepared());
    expect(
      await caller().links({ entityType: "asset", entityId: 1 })
    ).toMatchObject([{ sourceId: 1, targetId: result.results[0].targetId }]);
    expect(
      await caller().links({
        entityType: "custody",
        entityId: result.results[0].targetId,
      })
    ).toHaveLength(1);
    await expect(
      sourceRecord(state.db, "asset", 1, true)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("never converts only a subset when a selected record is blocked", async () => {
    state.db.rows().depreciation_batches.push({
      id: 1,
      entityType: "asset",
      entityId: 2,
      status: "DRAFT",
    });
    const request = draft({ ids: [1, 2] }),
      preview = await caller().preview(request);
    await expect(
      caller("owner", 1).execute({
        request,
        previewHash: preview.previewHash,
        requestKey: randomUUID(),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(
      state.db.rows().assets.every((r: any) => r.status === "ACTIVE")
    ).toBe(true);
  });
  it("enforces accountant/approver roles and strict request validation", async () => {
    const data = await prepared();
    await expect(caller().execute(data)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      caller().approve({ id: 1, expectedVersion: 0 })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("employee", 8).preview(draft())).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      inventoryConversionRouter
        .createCaller({ ...context(), user: null })
        .preview(draft())
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(conversionDraft.safeParse({ ...draft(), ids: [1, 1] }).success).toBe(
      false
    );
    expect(
      conversionDraft.safeParse({ ...draft(), assetValue: "0.01" }).success
    ).toBe(false);
    expect(
      conversionDraft.safeParse({
        ...draft(),
        ids: Array.from({ length: 51 }, (_, i) => i + 1),
      }).success
    ).toBe(false);
  });
});
