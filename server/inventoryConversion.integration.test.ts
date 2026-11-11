import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { TrpcContext } from "./_core/context";
import {
  assets,
  custodyItems,
  users,
  locations,
  branches,
  departments,
  employees,
  financialClassifications,
  depreciationControl,
  inventoryConversions,
  inventoryConversionItems,
  inventoryApprovalNumbers,
  auditLog,
  archiveDocuments,
  depreciationPolicies,
  depreciationBatches,
} from "../drizzle/schema";
import { conversionDraft } from "../shared/inventoryConversion";
import { getInventorySummary } from "./inventorySummary";
import { inventorySummaryInput } from "../shared/inventorySummary";
import {
  formatSequence,
  getNumberingPeriod,
  normalizeNumberPrefix,
} from "./numbering";
const state = vi.hoisted(() => ({ db: null as any }));
vi.mock("./db", () => ({ getDb: async () => state.db }));
import { inventoryConversionRouter } from "./inventoryConversion";
if (process.env.RUN_CONVERSION_DB_TESTS === "1")
  vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

describe.skipIf(process.env.RUN_CONVERSION_DB_TESTS !== "1")(
  "Conversion on an isolated MySQL database",
  () => {
    let pool: mysql.Pool,
      db: ReturnType<typeof drizzle>,
      locationId: number,
      branchId: number,
      departmentId: number,
      employeeId: number,
      classificationId: number,
      ids: number[];
    const ctx = (role = "accounting_manager", id = 3) =>
      ({
        user: { id, name: `مستخدم اختبار ${id}`, role },
        req: { ip: "127.0.0.1", headers: {} },
        res: {},
      }) as TrpcContext;
    const caller = (role?: string, id?: number) =>
      inventoryConversionRouter.createCaller(ctx(role, id));
    beforeAll(async () => {
      const url = new URL(process.env.TEST_DATABASE_URL || "http://invalid");
      if (
        !/^tolan_conversion_qa_\d+_[a-f0-9]{8}$/.test(url.pathname.slice(1)) ||
        url.pathname === new URL(process.env.DATABASE_URL!).pathname
      )
        throw new Error("An owned isolated conversion database is required");
      pool = mysql.createPool({
        uri: process.env.TEST_DATABASE_URL,
        ssl: { minVersion: "TLSv1.2", rejectUnauthorized: true },
        connectionLimit: 5,
      });
      db = drizzle(pool);
      state.db = db;
      const suffix = randomUUID().slice(0, 8);
      locationId = Number(
        (
          await db.insert(locations).values({
            name: "موقع اختبار التحويل",
            assetPrefix: `QA-A-${suffix}`,
            custodyPrefix: `QA-C-${suffix}`,
          })
        )[0].insertId
      );
      branchId = Number(
        (
          await db.insert(branches).values({ name: "فرع اختبار", locationId })
        )[0].insertId
      );
      departmentId = Number(
        (
          await db
            .insert(departments)
            .values({ name: "قسم اختبار", branchId, locationId })
        )[0].insertId
      );
      employeeId = Number(
        (
          await db
            .insert(employees)
            .values({ fullName: "موظف اختبار", departmentId })
        )[0].insertId
      );
      classificationId = Number(
        (
          await db
            .insert(financialClassifications)
            .values({ code: `QA-${suffix}`, name: "تصنيف اختبار" })
        )[0].insertId
      );
      await db
        .insert(depreciationControl)
        .values({ id: 1 })
        .onDuplicateKeyUpdate({ set: { id: 1 } });
    });
    beforeEach(async () => {
      ids = [];
      for (let i = 0; i < 2; i++)
        ids.push(
          Number(
            (
              await db.insert(assets).values({
                assetName: `أصل اختبار ${i}`,
                assetCode: `QA-SOURCE-${randomUUID()}`,
                quantity: 10,
                excludedQuantity: 3,
                warrantyReplacedQuantity: 2,
                assetValue: "13.37",
                locationId,
                departmentId,
                assignedTo: employeeId,
                classificationId,
                status: "ACTIVE",
                approvedBy: 1,
                approvedAt: new Date(),
              })
            )[0].insertId
          )
        );
    });
    afterAll(async () => {
      await pool?.end();
    });
    const payload = (
      sourceIds = ids,
      sourceType: "asset" | "custody" = "asset"
    ) =>
      conversionDraft.parse({
        sourceType,
        ids: sourceIds,
        notes: "تحويل تجريبي معزول",
      });
    const previewed = async (request = payload()) => ({
      request,
      previewHash: (await caller().preview(request)).previewHash,
      requestKey: randomUUID(),
    });
    const count = async (
      table:
        | typeof assets
        | typeof custodyItems
        | typeof inventoryConversions
        | typeof inventoryApprovalNumbers
    ) =>
      Number((await db.select({ n: sql<number>`COUNT(*)` }).from(table))[0].n);

    it("executes a batch atomically and preserves combined financial/quantity totals", async () => {
      const input = inventorySummaryInput.parse({ groupBy: "location" });
      const before = (await getInventorySummary(db, input)).total;
      const result = await caller().execute(await previewed());
      expect(result.results).toHaveLength(2);
      const after = (await getInventorySummary(db, input)).total;
      expect(after.totalValue).toBe(before.totalValue);
      expect(after.assetQuantity + after.custodyQuantity).toBe(
        before.assetQuantity + before.custodyQuantity
      );
      expect(after.assetRecords + after.custodyRecords).toBe(
        before.assetRecords + before.custodyRecords
      );
      for (const resultItem of result.results) {
        const [old] = await db
          .select()
          .from(assets)
          .where(eq(assets.id, resultItem.sourceId));
        const [next] = await db
          .select()
          .from(custodyItems)
          .where(eq(custodyItems.id, resultItem.targetId));
        expect(old).toMatchObject({
          status: "CONVERTED",
          quantity: 10,
          excludedQuantity: 3,
          warrantyReplacedQuantity: 2,
        });
        expect(next).toMatchObject({
          status: "ACTIVE",
          quantity: 5,
          excludedQuantity: 0,
          warrantyReplacedQuantity: 0,
          assignedTo: employeeId,
          assetValue: "13.37",
        });
        expect(
          (
            await caller().links({ entityType: "custody", entityId: next.id })
          )[0].sourceId
        ).toBe(old.id);
      }
    });
    it("returns the same operation for concurrent identical retries without duplicate codes", async () => {
      // Use two requests with precisely the same reviewed payload and idempotency key.
      const input = await previewed(payload([ids[0]]));
      const before = await count(custodyItems);
      const [a, b] = await Promise.all([
        caller().execute(input),
        caller().execute(input),
      ]);
      expect(a.id).toBe(b.id);
      expect(await count(custodyItems)).toBe(before + 1);
      expect(a.results[0].targetCode).toBe(b.results[0].targetCode);
    });
    it("allows only one concurrent operation for the same source with different keys", async () => {
      const input = await previewed(payload([ids[0]]));
      const before = await count(custodyItems);
      const outcomes = await Promise.allSettled([
        caller().execute(input),
        caller().execute({ ...input, requestKey: randomUUID() }),
      ]);
      expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
      expect(await count(custodyItems)).toBe(before + 1);
    });
    it("queues the accountant's request, then manager executes; supports the reverse direction", async () => {
      const data = await previewed(payload([ids[0]]));
      const request = await caller("accountant", 2).submit(data);
      expect(request.status).toBe("PENDING");
      const [source] = await db
        .select()
        .from(assets)
        .where(eq(assets.id, ids[0]));
      expect(source.status).toBe("ACTIVE");
      await expect(
        caller("accountant", 2).approve({ id: request.id, expectedVersion: 0 })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const executed = await caller().approve({
        id: request.id,
        expectedVersion: 0,
      });
      const targetId = executed.results[0].targetId;
      const reverse = await caller().execute(
        await previewed(payload([targetId], "custody"))
      );
      const [final] = await db
        .select()
        .from(assets)
        .where(eq(assets.id, reverse.results[0].targetId));
      expect(final.quantity).toBe(5);
      expect(final.status).toBe("ACTIVE");
    });
    it("checks financial drafts created between request and approval", async () => {
      const request = await caller("accountant", 2).submit(
        await previewed(payload([ids[0]]))
      );
      const policyId = Number(
        (
          await db.insert(depreciationPolicies).values({
            effectiveDate: "2026-01-01",
            payload: {},
            createdBy: 1,
            updatedBy: 1,
          })
        )[0].insertId
      );
      await db.insert(depreciationBatches).values({
        entityType: "asset",
        entityId: ids[0],
        classificationId,
        policyId,
        payload: {},
        createdBy: 1,
        updatedBy: 1,
      });
      await expect(
        caller().approve({ id: request.id, expectedVersion: 0 })
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await caller("accountant", 2).cancel({
        id: request.id,
        expectedVersion: 0,
      });
    });
    it("rolls back source, destination, request, archive and numbering on a real SQL failure", async () => {
      const input = await previewed();
      const [location] = await db
        .select()
        .from(locations)
        .where(eq(locations.id, locationId));
      const period = getNumberingPeriod();
      const nextSequence =
        location.custodySequencePeriod === period
          ? location.custodySequence + 1
          : 1;
      // Force the second destination's official number to violate a real unique
      // constraint, after the first row, its audit and archive have been written.
      const reserved = await db
        .insert(inventoryApprovalNumbers)
        .values({
          entityType: "custody",
          entityId: 2000000000,
          code: formatSequence(
            normalizeNumberPrefix(location.custodyPrefix)!,
            period,
            nextSequence + 1
          ),
          approvedBy: 1,
        });
      const reservedId = Number(reserved[0].insertId);
      const auditsBefore = Number(
        (await db.select({ n: sql<number>`COUNT(*)` }).from(auditLog))[0].n
      );
      const archiveBefore = Number(
        (
          await db.select({ n: sql<number>`COUNT(*)` }).from(archiveDocuments)
        )[0].n
      );
      const before = {
        targets: await count(custodyItems),
        requests: await count(inventoryConversions),
        numbers: await count(inventoryApprovalNumbers),
        location: (
          await db.select().from(locations).where(eq(locations.id, locationId))
        )[0],
      };
      try {
        await expect(caller().execute(input)).rejects.toThrow();
        expect(await count(custodyItems)).toBe(before.targets);
        expect(await count(inventoryConversions)).toBe(before.requests);
        expect(await count(inventoryApprovalNumbers)).toBe(before.numbers);
        expect(
          Number(
            (await db.select({ n: sql<number>`COUNT(*)` }).from(auditLog))[0].n
          )
        ).toBe(auditsBefore);
        expect(
          Number(
            (
              await db
                .select({ n: sql<number>`COUNT(*)` })
                .from(archiveDocuments)
            )[0].n
          )
        ).toBe(archiveBefore);
        expect(
          (
            await db
              .select()
              .from(locations)
              .where(eq(locations.id, locationId))
          )[0]
        ).toEqual(before.location);
        expect(
          (await db.select().from(assets).where(eq(assets.id, ids[0])))[0]
            .status
        ).toBe("ACTIVE");
      } finally {
        await db
          .delete(inventoryApprovalNumbers)
          .where(eq(inventoryApprovalNumbers.id, reservedId));
      }
    });
  }
);
