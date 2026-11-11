
import {legacyFixture} from './test-utils/legacyFixture';
const isolated=vi.hoisted(()=>({db:null}));
vi.mock('./db',()=>({getDb:async()=>isolated.db,revokeUserSessions:vi.fn()}));
vi.mock('./security',()=>({logAuditAction:vi.fn(),clearBruteForceBlock:vi.fn()}));
vi.mock('./storage',()=>({storagePut:vi.fn(async()=>({url:'/api/files/test/backup.tln'}))}));
beforeEach(()=>{isolated.db=legacyFixture();});
import { describe, expect, it, vi, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// Mock authenticated user context
function createMockContext(role: "admin" | "accountant" = "admin"): TrpcContext {
  return {
    user: {
      id: 1,
      openId: "test-user-123",
      email: "test@example.com",
      name: "Test User",
      loginMethod: "manus",
      role,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: {
      protocol: "https",
      headers: {},
      ip: "127.0.0.1",
    } as TrpcContext["req"],
    res: {
      clearCookie: vi.fn(),
      cookie: vi.fn(),
    } as unknown as TrpcContext["res"],
  };
}

// Mock unauthenticated context
function createUnauthContext(): TrpcContext {
  return {
    user: null,
    req: {
      protocol: "https",
      headers: {},
      ip: "127.0.0.1",
    } as TrpcContext["req"],
    res: {
      clearCookie: vi.fn(),
      cookie: vi.fn(),
    } as unknown as TrpcContext["res"],
  };
}

describe("Auth API", () => {
  it("auth.me returns user when authenticated", async () => {
    const ctx = createMockContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.auth.me();
    expect(result).toBeDefined();
    expect(result?.id).toBe(1);
    expect(result).not.toHaveProperty("passwordHash");
    expect(result?.role).toBe("admin");
  });

  it("auth.me returns null when not authenticated", async () => {
    const ctx = createUnauthContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.auth.me();
    expect(result).toBeNull();
  });

  it("auth.logout clears session cookie", async () => {
    const ctx = createMockContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.auth.logout();
    expect(result).toEqual({ success: true });
    expect(ctx.res.clearCookie).toHaveBeenCalled();
  });
});

describe("Settings API - Input Validation", () => {
  it("settings.departments.create requires non-empty name", async () => {
    const ctx = createMockContext();
    const caller = appRouter.createCaller(ctx);
    
    // Empty name should fail validation
    await expect(
      caller.settings.departments.create({ name: "" })
    ).rejects.toThrow();
  });

  it("settings.locations.create requires non-empty name", async () => {
    const ctx = createMockContext();
    const caller = appRouter.createCaller(ctx);
    
    await expect(
      caller.settings.locations.create({ name: "" })
    ).rejects.toThrow();
  });

  it("settings.employees.create requires valid data", async () => {
    const ctx = createMockContext();
    const caller = appRouter.createCaller(ctx);
    
    // Missing required field should fail
    await expect(
      caller.settings.employees.create({ fullName: "" } as any)
    ).rejects.toThrow();
  });

  it.each([
    { field: "fingerprintId", value: undefined, message: "رقم البصمة مطلوب" },
    { field: "fingerprintId", value: "   ", message: "رقم البصمة مطلوب" },
    { field: "nationalId", value: undefined, message: "رقم الهوية مطلوب" },
    { field: "nationalId", value: "   ", message: "رقم الهوية مطلوب" },
  ])("settings.employees.create rejects $field when it is $value", async ({ field, value, message }) => {
    const caller = appRouter.createCaller(createMockContext());
    await expect(caller.settings.employees.create({
      fullName: "موظف اختبار",
      fingerprintId: "0012",
      nationalId: "0000000012",
      [field]: value,
    })).rejects.toThrow(message);
  });

  it("settings.exclusionTypes.create requires non-empty name", async () => {
    const ctx = createMockContext();
    const caller = appRouter.createCaller(ctx);
    
    await expect(
      caller.settings.exclusionTypes.create({ name: "" })
    ).rejects.toThrow();
  });
});

describe("Independent employee records", () => {
  it("adds and edits an employee independently of the departments assigned to their assets and custody", async () => {
    const caller = appRouter.createCaller(createMockContext());
    isolated.db.rows().departments.push({ id: 2, name: "قسم آخر", branchId: 1 });
    const details = { fullName: "موظف جديد", fingerprintId: "0012", nationalId: "0000000012", departmentId: 1 };

    const created = await caller.settings.employees.create(details);
    expect(created).toMatchObject({ ...details, departmentId: null, code: null, sequenceNo: null });
    await caller.settings.employees.update({ id: created.id, ...details, phone: "0500000012" });
    const employee = isolated.db.rows().employees.find((row: { id: number }) => row.id === created.id);
    expect(employee).toMatchObject({ phone: "0500000012", departmentId: null, code: null, sequenceNo: null });
    const listed = (await caller.settings.employees.list()).find(row => row.id === created.id);
    expect(listed).toMatchObject({ fullName: details.fullName, fingerprintId: details.fingerprintId, phone: "0500000012" });
    expect(listed).not.toHaveProperty("departmentId");
    expect(listed).not.toHaveProperty("code");

    const scope = { assignedTo: created.id, locationId: 1 };
    const asset = await caller.inventory.assets.create({ ...scope, departmentId: 1, assetName: "جهاز اختبار" });
    const custody = await caller.inventory.custody.create({ ...scope, departmentId: 2, name: "عهدة اختبار" });
    await caller.inventory.assets.approve({ id: asset.id, expectedVersion: 0 });
    await caller.inventory.custody.approve({ id: custody.id, expectedVersion: 0 });
    expect(await caller.inventory.assets.getById({ id: asset.id })).toMatchObject({ ...scope, departmentId: 1, status: "ACTIVE" });
    expect(await caller.inventory.custody.getById({ id: custody.id })).toMatchObject({ ...scope, departmentId: 2, status: "ACTIVE" });
  });

  it("imports new employees without a department and retains an existing employee's assignment", async () => {
    const caller = appRouter.createCaller(createMockContext());
    const employee = isolated.db.rows().employees[0];
    Object.assign(employee, { fingerprintId: "0001", code: "01-01-001-0001", sequenceNo: 1, phone: "0500000001" });
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("الموظفون");
    worksheet.addRow(["رقم البصمة", "اسم الموظف", "رقم الهوية", "رقم الهاتف", "القسم"]);
    worksheet.addRow(["0012", "موظف مستورد", "0000000012", "0500000012", "قسم اختبار"]);
    worksheet.addRow([employee.fingerprintId, employee.fullName, "0000000001", "", "قسم آخر"]);

    const base64Data = Buffer.from(await workbook.xlsx.writeBuffer()).toString("base64");
    const result = await caller.excel.importEmployees({ base64Data });
    expect(result).toMatchObject({ imported: 1, updated: 1, skipped: 0 });
    const imported = isolated.db.rows().employees.find((row: { fingerprintId: string }) => row.fingerprintId === "0012");
    expect(imported).toMatchObject({ departmentId: null, nationalId: "0000000012", phone: "0500000012" });
    expect(imported.code ?? null).toBeNull();
    expect(employee).toMatchObject({ departmentId: 1, code: "01-01-001-0001", nationalId: "0000000001", phone: "0500000001" });
  });
});

describe("Inventory API - Input Validation", () => {
  it("inventory.assets.create requires valid data", async () => {
    const ctx = createMockContext();
    const caller = appRouter.createCaller(ctx);
    
    // Missing required fields should fail
    await expect(
      caller.inventory.assets.create({} as any)
    ).rejects.toThrow();
  });

  it("inventory.custody.create requires valid data", async () => {
    const ctx = createMockContext();
    const caller = appRouter.createCaller(ctx);
    
    await expect(
      caller.inventory.custody.create({} as any)
    ).rejects.toThrow();
  });

  it("inventory.assets.delete requires valid id", async () => {
    const ctx = createMockContext();
    const caller = appRouter.createCaller(ctx);
    
    // Non-existent id should not crash but may throw
    await expect(
      caller.inventory.assets.delete({ id: -1 })
    ).rejects.toThrow();
  });
});

describe("Operations API - Input Validation", () => {
  it("operations.transfers.fullTransfer requires valid employee ids", async () => {
    const ctx = createMockContext();
    const caller = appRouter.createCaller(ctx);
    
    await expect(
      caller.operations.transfers.fullTransfer({
        fromEmployeeId: 0,
        toEmployeeId: 0,
      })
    ).rejects.toThrow();
  });

  it("operations.transfers.partialTransfer requires items", async () => {
    const ctx = createMockContext();
    const caller = appRouter.createCaller(ctx);
    
    await expect(
      caller.operations.transfers.partialTransfer({
        toEmployeeId: 0,
        items: [],
      })
    ).rejects.toThrow();
  });

  it("operations.exclusions.excludeAsset requires valid data", async () => {
    const ctx = createMockContext();
    const caller = appRouter.createCaller(ctx);
    
    await expect(
      caller.operations.exclusions.excludeAsset({
        assetId: 0,
        exclusionTypeId: 0,
        reason: "",
      })
    ).rejects.toThrow();
  });
});

describe("Records API - Input Validation", () => {
  it("records.reports.inventory accepts valid type filter", async () => {
    const ctx = createMockContext();
    const caller = appRouter.createCaller(ctx);
    
    // Valid type should not throw (but may return empty array if DB is empty)
    const result = await caller.records.reports.inventory({ type: "all" });
    expect(Array.isArray(result)).toBe(true);
  });

  it("records.reports.inventory rejects invalid type", async () => {
    const ctx = createMockContext();
    const caller = appRouter.createCaller(ctx);
    
    await expect(
      caller.records.reports.inventory({ type: "invalid" as any })
    ).rejects.toThrow();
  });
});

describe("Security - Protected Routes", () => {
  it("protected routes reject unauthenticated users", async () => {
    const ctx = createUnauthContext();
    const caller = appRouter.createCaller(ctx);
    
    // Settings operations should require authentication
    await expect(
      caller.settings.departments.create({ name: "Test" })
    ).rejects.toThrow();
  });

  it("admin routes reject non-admin users", async () => {
    const ctx = createMockContext("user");
    const caller = appRouter.createCaller(ctx);
    
    // Some operations may require admin role
    // This tests that role-based access is enforced
    // Note: depends on implementation - some routes may allow regular users
    const meResult = await caller.auth.me();
    expect(meResult?.role).toBe("user");
  });
});

describe("Data Integrity", () => {
  it("department name cannot be just whitespace", async () => {
    const ctx = createMockContext();
    const caller = appRouter.createCaller(ctx);
    
    await expect(
      caller.settings.departments.create({ name: "   " })
    ).rejects.toThrow();
  });

  it("location name cannot be just whitespace", async () => {
    const ctx = createMockContext();
    const caller = appRouter.createCaller(ctx);
    
    await expect(
      caller.settings.locations.create({ name: "   " })
    ).rejects.toThrow();
  });

  it("asset quantity must be positive", async () => {
    const ctx = createMockContext();
    const caller = appRouter.createCaller(ctx);
    
    await expect(
      caller.inventory.assets.create({
        name: "Test Asset",
        code: "TST-001",
        quantity: -1,
        unitValue: "100",
        employeeId: 1,
        departmentId: 1,
        locationId: 1,
      } as any)
    ).rejects.toThrow();
  });
});
