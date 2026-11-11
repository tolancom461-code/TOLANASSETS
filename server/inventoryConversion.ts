import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { operatorProcedure, approvalProcedure, router } from "./_core/trpc";
import { z } from "zod";
import { getDb } from "./db";
import {
  assets,
  custodyItems,
  departments,
  branches,
  employees,
  locations,
  depreciationBatches,
  depreciationControl,
  inventoryConversions,
  inventoryConversionItems,
  inventoryApprovalNumbers,
  exclusionDrafts,
  warrantyReplacements,
  inventorySessions,
  inventoryDifferences,
  inventoryDifferenceActions,
  appSettings,
  financialClassifications,
} from "../drizzle/schema";
import {
  conversionDraft,
  conversionExecution,
  conversionTarget,
  conversionTypeLabel,
  type ConversionDraft,
} from "../shared/inventoryConversion";
import { remainingQuantity } from "../shared/inventoryQuantity";
import { historyAudit, parseHistoryData } from "./history";
import { bumpFinance } from "./depreciationStore";
import { allocateEntityCode, normalizeNumberPrefix } from "./numbering";
import { canApprove } from "../shared/roles";

const fail = (
  message: string,
  code: "BAD_REQUEST" | "CONFLICT" | "FORBIDDEN" | "NOT_FOUND" = "BAD_REQUEST"
): never => {
  throw new TRPCError({ code, message });
};
const tableFor = (kind: string) => (kind === "asset" ? assets : custodyItems);
// MySQL/TiDB JSON storage can reorder object keys. Identity must depend on the
// values, not on the serializer's key order, including nested snapshots.
function canonical(value: any): any {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonical(value[key])])
    );
  return value;
}
const digest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const reviewed = z.object({
  id: z.number().int().positive(),
  expectedVersion: z.number().int().nonnegative(),
});
async function database() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
  return db;
}
async function lockConversion(tx: any) {
  await tx
    .insert(depreciationControl)
    .values({ id: 1, revision: 0 })
    .onDuplicateKeyUpdate({ set: { id: 1 } });
  await tx
    .select()
    .from(depreciationControl)
    .where(eq(depreciationControl.id, 1))
    .for("update");
  // Same gate used by creation of count-session snapshots.
  await tx
    .insert(appSettings)
    .values({ id: 1 })
    .onDuplicateKeyUpdate({ set: { id: 1 } });
  await tx
    .select()
    .from(appSettings)
    .where(eq(appSettings.id, 1))
    .for("update");
}

async function prepare(
  tx: any,
  request: ConversionDraft,
  ownRequestId?: number
) {
  const table = tableFor(request.sourceType),
    targetType = conversionTarget(request.sourceType);
  const ids = [...request.ids].sort((a, b) => a - b);
  const sources = await tx
    .select()
    .from(table)
    .where(inArray(table.id, ids))
    .orderBy(asc(table.id))
    .for("update");
  if (sources.length !== ids.length)
    fail("أحد السجلات المحددة غير موجود؛ حدّث الصفحة");
  const [files, exclusions, warranties, sessions, pending, links, differences] =
    await Promise.all([
      tx
        .select()
        .from(depreciationBatches)
        .where(
          and(
            eq(depreciationBatches.entityType, request.sourceType),
            inArray(depreciationBatches.entityId, ids)
          )
        )
        .for("update"),
      tx.select().from(exclusionDrafts).for("update"),
      tx
        .select()
        .from(warrantyReplacements)
        .where(
          and(
            eq(warrantyReplacements.entityType, request.sourceType),
            inArray(warrantyReplacements.entityId, ids)
          )
        )
        .for("update"),
      tx
        .select()
        .from(inventorySessions)
        .where(inArray(inventorySessions.status, ["DRAFT", "SUBMITTED"]))
        .for("update"),
      tx
        .select()
        .from(inventoryConversions)
        .where(eq(inventoryConversions.status, "PENDING"))
        .for("update"),
      tx
        .select()
        .from(inventoryConversionItems)
        .where(
          and(
            eq(inventoryConversionItems.sourceType, request.sourceType),
            inArray(inventoryConversionItems.sourceId, ids)
          )
        )
        .for("update"),
      tx
        .select()
        .from(inventoryDifferences)
        .where(
          and(
            eq(inventoryDifferences.entityType, request.sourceType),
            inArray(inventoryDifferences.entityId, ids)
          )
        )
        .for("update"),
    ]);
  const differenceActions = differences.length
    ? await tx
        .select()
        .from(inventoryDifferenceActions)
        .where(
          inArray(
            inventoryDifferenceActions.differenceId,
            differences.map((d: any) => d.id)
          )
        )
        .orderBy(desc(inventoryDifferenceActions.id))
        .for("update")
    : [];
  const references = (key: string, extra?: number) =>
    [
      ...new Set<number>(
        [...sources.map((r: any) => r[key]), extra].filter(
          (id: any) => Number.isInteger(id) && id > 0
        )
      ),
    ].sort((a, b) => a - b);
  const [employeeRows, departmentRows, locationRows, classes] =
    await Promise.all([
      tx
        .select({ id: employees.id, fullName: employees.fullName })
        .from(employees)
        .where(
          inArray(employees.id, references("assignedTo", request.employeeId))
        )
        .orderBy(asc(employees.id))
        .for("update"),
      tx
        .select()
        .from(departments)
        .where(
          inArray(
            departments.id,
            references("departmentId", request.departmentId)
          )
        )
        .orderBy(asc(departments.id))
        .for("update"),
      tx
        .select()
        .from(locations)
        .where(
          inArray(locations.id, references("locationId", request.locationId))
        )
        .orderBy(asc(locations.id))
        .for("update"),
      tx
        .select()
        .from(financialClassifications)
        .where(
          inArray(financialClassifications.id, references("classificationId"))
        )
        .orderBy(asc(financialClassifications.id))
        .for("update"),
    ]);
  const branchRows = await tx
    .select()
    .from(branches)
    .where(
      inArray(
        branches.id,
        departmentRows.map((r: any) => r.branchId).filter(Boolean)
      )
    )
    .orderBy(asc(branches.id))
    .for("update");
  const employeeMap = new Map<number, any>(
    employeeRows.map((r: any) => [r.id, r])
  );
  const departmentMap = new Map<number, any>(
    departmentRows.map((r: any) => [r.id, r])
  );
  const branchMap = new Map<number, any>(branchRows.map((r: any) => [r.id, r]));
  const locationMap = new Map<number, any>(
    locationRows.map((r: any) => [r.id, r])
  );
  const classMap = new Map<number, any>(classes.map((r: any) => [r.id, r]));
  const pendingIds = new Set(
    pending.filter((r: any) => r.id !== ownRequestId).map((r: any) => r.id)
  );
  const rows: any[] = [];
  for (const row of sources) {
    const errors: string[] = [];
    const quantity = remainingQuantity(row);
    if (
      row.status !== "ACTIVE" ||
      !Number.isInteger(quantity) ||
      quantity <= 0 ||
      !Number.isInteger(row.quantity) ||
      row.quantity <= 0 ||
      (row.excludedQuantity || 0) < 0 ||
      (row.warrantyReplacedQuantity || 0) < 0
    )
      errors.push("السجل غير نشط أو لا يملك كمية متبقية صحيحة");
    if (!(request.sourceType === "asset" ? row.assetCode : row.code))
      errors.push("السجل لا يحمل رمزًا رسميًا");
    if (files.some((f: any) => f.entityId === row.id))
      errors.push("مرتبط بملف إهلاك؛ التحويل غير متاح حتى لو كان الملف مسودة");
    if (
      exclusions.some((d: any) => {
        const p = parseHistoryData(d.payload);
        return p?.entityType === request.sourceType && p.entityId === row.id;
      })
    )
      errors.push("توجد مسودة استبعاد معلقة");
    if (
      warranties.some(
        (w: any) =>
          w.entityId === row.id && ["DRAFT", "SUBMITTED"].includes(w.status)
      )
    )
      errors.push("يوجد طلب ضمان معلق");
    if (
      sessions.some((s: any) => {
        const raw = parseHistoryData(s.items);
        return (Array.isArray(raw) ? raw : raw?.items || []).some(
          (i: any) =>
            i.id === row.id &&
            (i.entityType
              ? i.entityType === request.sourceType
              : s.sessionType === "both" ||
                (s.sessionType === "custody" ? "custody" : "asset") ===
                  request.sourceType)
        );
      })
    )
      errors.push("السجل داخل جلسة جرد مفتوحة");
    if (
      links.some(
        (l: any) => l.sourceId === row.id && pendingIds.has(l.conversionId)
      )
    )
      errors.push("يوجد طلب تحويل آخر بانتظار الاعتماد");
    if (
      differences.some(
        (d: any) =>
          d.entityId === row.id &&
          differenceActions.find((a: any) => a.differenceId === d.id)
            ?.actionType !== "REVIEW"
      )
    )
      errors.push("توجد فروق جرد لم تُغلق بالمراجعة النهائية");
    const locationId =
      request.allocationMode === "KEEP" ? row.locationId : request.locationId;
    const departmentId =
      request.allocationMode === "KEEP"
        ? row.departmentId
        : request.departmentId;
    const assignedTo =
      request.employeeMode === "KEEP" ? row.assignedTo : request.employeeId;
    const destination = {
      locationId,
      departmentId,
      assignedTo,
      classificationId: row.classificationId,
    };
    const department = departmentMap.get(departmentId),
      branch = branchMap.get(department?.branchId),
      location = locationMap.get(locationId),
      employee = employeeMap.get(assignedTo);
    const classification = classMap.get(row.classificationId);
    if (!location || !employee || !department)
      errors.push("موقع أو قسم أو موظف الوجهة غير موجود");
    if (row.classificationId && !classification?.active)
      errors.push("التصنيف المالي غير موجود أو غير نشط");
    const names = {
      employeeName: employee?.fullName ?? null,
      departmentName: department?.name ?? null,
      locationName: location?.name ?? null,
      classificationName: classification?.name ?? null,
      classificationCode: classification?.code ?? null,
    };
    if (
      !branch ||
      branch.locationId !== locationId ||
      (request.allocationMode === "CHANGE" && branch.id !== request.branchId)
    )
      errors.push("فرع وقسم الوجهة لا يتبعان الموقع المختار");
    const prefix = normalizeNumberPrefix(
      targetType === "asset" ? location?.assetPrefix : location?.custodyPrefix
    );
    if (!prefix) errors.push("بادئة ترقيم الوجهة غير مهيأة في الموقع");
    const known: unknown = parseHistoryData(row.serialNumbers);
    if (
      known != null &&
      (!Array.isArray(known) || known.some(v => typeof v !== "string"))
    )
      errors.push("معرفات الوحدات المحفوظة غير صحيحة");
    const originalSerials: string[] = Array.isArray(known) ? known : [];
    const replaced = new Set(
      warranties
        .filter((w: any) => w.entityId === row.id && w.status === "EXECUTED")
        .flatMap(
          (w: any) => parseHistoryData(w.payload)?.originalSerialNumbers || []
        )
    );
    const candidates = originalSerials.filter(s => !replaced.has(s));
    const requiresSerialReview =
      (row.excludedQuantity || 0) > 0 && candidates.length > 0;
    const serialNumbers =
      request.serials[String(row.id)] ??
      (requiresSerialReview ? [] : candidates);
    if (requiresSerialReview && !Object.hasOwn(request.serials, String(row.id)))
      errors.push("حدد معرفات الوحدات المتبقية بعد الاستبعاد");
    if (
      new Set(originalSerials).size !== originalSerials.length ||
      originalSerials.length > row.quantity ||
      new Set(serialNumbers).size !== serialNumbers.length ||
      serialNumbers.some(s => !candidates.includes(s)) ||
      serialNumbers.length > quantity ||
      serialNumbers.length <
        Math.max(0, candidates.length - (row.excludedQuantity || 0))
    )
      errors.push("معرفات الوحدات المحولة لا تطابق الكمية والمتبقي من السجل");
    rows.push({
      source: {
        ...row,
        employeeName: employeeMap.get(row.assignedTo)?.fullName ?? null,
        departmentName: departmentMap.get(row.departmentId)?.name ?? null,
        locationName: locationMap.get(row.locationId)?.name ?? null,
      },
      id: row.id,
      name: row.assetName ?? row.name,
      code: row.assetCode ?? row.code,
      quantity,
      destination: {
        ...destination,
        ...names,
        branchId: branch?.id ?? null,
        branchName: branch?.name ?? null,
        prefix,
      },
      serialNumbers,
      candidates,
      requiresSerialReview,
      errors,
    });
  }
  const previewHash = digest({ request, rows });
  if (Buffer.byteLength(JSON.stringify({ request, rows }), "utf8") > 1_000_000)
    fail("حجم التحديد كبير؛ قسّم التحويل إلى دفعات أصغر");
  return {
    sourceType: request.sourceType,
    targetType,
    rows,
    previewHash,
    valid: rows.every(r => r.errors.length === 0),
  };
}

async function executePrepared(
  tx: any,
  ctx: any,
  record: any,
  prepared: Awaited<ReturnType<typeof prepare>>
) {
  const from = tableFor(record.sourceType),
    to = tableFor(prepared.targetType);
  const results: any[] = [];
  // Reserve destination locations in a stable order, shared with ordinary approvals.
  const locationIds = [
    ...new Set(prepared.rows.map(r => r.destination.locationId as number)),
  ].sort((a, b) => a - b);
  for (const id of locationIds)
    await tx.select().from(locations).where(eq(locations.id, id)).for("update");
  const savedItems = await tx
    .select()
    .from(inventoryConversionItems)
    .where(eq(inventoryConversionItems.conversionId, record.id));
  const now = new Date();
  for (const item of prepared.rows) {
    const old = item.source;
    const numbering = await allocateEntityCode(
      tx,
      item.destination.locationId,
      prepared.targetType
    );
    const next: any = {
      [prepared.targetType === "asset" ? "assetName" : "name"]: item.name,
      [prepared.targetType === "asset" ? "assetCode" : "code"]: numbering.code,
      quantity: item.quantity,
      assetValue: old.assetValue,
      condition: old.condition,
      classificationId: old.classificationId,
      assignedTo: item.destination.assignedTo,
      departmentId: item.destination.departmentId,
      locationId: item.destination.locationId,
      originLocationId: item.destination.locationId,
      status: "ACTIVE",
      draftVersion: 0,
      excludedQuantity: 0,
      warrantyReplacedQuantity: 0,
      serialNumbers: item.serialNumbers.length ? item.serialNumbers : null,
      warrantyStartDate: old.warrantyStartDate,
      warrantyEndDate: old.warrantyEndDate,
      assetImagePath: old.assetImagePath,
      invoiceImagePath: old.invoiceImagePath,
      notes: old.notes,
      approvedBy: ctx.user.id,
      approvedAt: now,
    };
    const result = await tx.insert(to).values(next);
    const targetId = Number(result[0].insertId);
    const conversion = {
      conversionId: record.id,
      sourceType: record.sourceType,
      sourceId: old.id,
      sourceCode: item.code,
      targetType: prepared.targetType,
      targetId,
      targetCode: numbering.code,
      quantity: item.quantity,
      reason: parseHistoryData(record.payload).notes,
      executedByName: ctx.user.name,
      executedAt: now.toISOString(),
    };
    const snapshot = {
      ...next,
      id: targetId,
      ...item.destination,
      ...conversion,
      approvedByName: ctx.user.name,
    };
    await tx.insert(inventoryApprovalNumbers).values({
      entityType: prepared.targetType,
      entityId: targetId,
      code: numbering.code,
      approvedBy: ctx.user.id,
    });
    await tx
      .update(to)
      .set({ approvalSnapshot: snapshot })
      .where(eq(to.id, targetId));
    await tx
      .update(from)
      .set({
        status: "CONVERTED",
        draftVersion: (old.draftVersion || 0) + 1,
        updatedAt: now,
      })
      .where(eq(from.id, old.id));
    const saved = savedItems.find((i: any) => i.sourceId === old.id);
    if (!saved) fail("تفاصيل الطلب غير مكتملة", "CONFLICT");
    await tx
      .update(inventoryConversionItems)
      .set({ targetId, targetSnapshot: snapshot })
      .where(eq(inventoryConversionItems.id, saved.id));
    await historyAudit(tx, ctx, {
      entityType: record.sourceType,
      entityId: old.id,
      tableName: record.sourceType === "asset" ? "assets" : "custody_items",
      recordId: old.id,
      actionType: "CONVERT_OUT",
      actionDescription: `تحويل ${item.code} إلى ${conversionTypeLabel(prepared.targetType)} بالرمز ${numbering.code}`,
      oldData: old,
      newData: {
        ...old,
        status: "CONVERTED",
        draftVersion: (old.draftVersion || 0) + 1,
        updatedAt: now,
        conversion,
      },
    });
    await historyAudit(tx, ctx, {
      entityType: prepared.targetType,
      entityId: targetId,
      tableName: prepared.targetType === "asset" ? "assets" : "custody_items",
      recordId: targetId,
      actionType: "CONVERT_IN",
      actionDescription: `وارد بالتحويل من ${conversionTypeLabel(record.sourceType)} بالرمز ${item.code}`,
      oldData: null,
      newData: snapshot,
    });
    results.push(conversion);
  }
  await tx
    .update(inventoryConversions)
    .set({
      status: "EXECUTED",
      version: record.version + 1,
      executedBy: ctx.user.id,
      executedByName: ctx.user.name,
      executedAt: now,
    })
    .where(eq(inventoryConversions.id, record.id));
  await bumpFinance(tx);
  return { id: record.id, status: "EXECUTED", results };
}
async function resultOf(tx: any, record: any) {
  const items = await tx
    .select()
    .from(inventoryConversionItems)
    .where(eq(inventoryConversionItems.conversionId, record.id))
    .for("update");
  return {
    id: record.id,
    status: record.status,
    results: items.map((i: any) => ({
      sourceId: i.sourceId,
      targetId: i.targetId,
      sourceCode:
        parseHistoryData(i.sourceSnapshot).assetCode ??
        parseHistoryData(i.sourceSnapshot).code,
      targetCode: parseHistoryData(i.targetSnapshot).targetCode,
    })),
  };
}
async function createRequest(
  ctx: any,
  input: z.infer<typeof conversionExecution>,
  execute: boolean
) {
  return (await database()).transaction(async tx => {
    await lockConversion(tx);
    const [existing] = await tx
      .select()
      .from(inventoryConversions)
      .where(eq(inventoryConversions.requestKey, input.requestKey))
      .for("update");
    if (existing) {
      if (
        existing.createdBy !== ctx.user.id ||
        digest(parseHistoryData(existing.payload)) !== digest(input.request) ||
        existing.previewHash !== input.previewHash
      )
        fail("مفتاح الطلب مستخدم لبيانات أخرى", "CONFLICT");
      if (existing.status === "CANCELLED")
        fail("الطلب ملغى؛ جهّز طلبًا جديدًا", "CONFLICT");
      return resultOf(tx, existing);
    }
    const prepared = await prepare(tx, input.request);
    if (!prepared.valid)
      fail(
        prepared.rows
          .filter(r => r.errors.length)
          .map(r => `${r.code}: ${r.errors.join("؛ ")}`)
          .join("\n")
      );
    if (prepared.previewHash !== input.previewHash)
      fail("تغيرت البيانات بعد المعاينة؛ راجع التحويل مجددًا", "CONFLICT");
    const data = {
      requestKey: input.requestKey,
      sourceType: input.request.sourceType,
      payload: input.request,
      previewHash: input.previewHash,
      status: "PENDING",
      version: 0,
      createdBy: ctx.user.id,
      createdByName: ctx.user.name,
    };
    const inserted = await tx.insert(inventoryConversions).values(data);
    const record = { ...data, id: Number(inserted[0].insertId) };
    for (const r of prepared.rows)
      await tx.insert(inventoryConversionItems).values({
        conversionId: record.id,
        sourceType: record.sourceType,
        sourceId: r.id,
        targetType: prepared.targetType,
        quantity: r.quantity,
        sourceSnapshot: r.source,
        targetSnapshot: r.destination,
      });
    if (execute) return executePrepared(tx, ctx, record, prepared);
    for (const r of prepared.rows)
      await historyAudit(tx, ctx, {
        entityType: record.sourceType,
        entityId: r.id,
        tableName: record.sourceType === "asset" ? "assets" : "custody_items",
        recordId: r.id,
        actionType: "CONVERT_REQUEST",
        actionDescription: `تقديم طلب تحويل #${record.id}: ${r.code}`,
        oldData: null,
        newData: {
          conversionId: record.id,
          entityName: r.name,
          entityCode: r.code,
          quantity: r.quantity,
          destination: r.destination,
          reason: input.request.notes,
        },
      });
    return { id: record.id, status: "PENDING", results: [] };
  });
}

export const inventoryConversionRouter = router({
  preview: operatorProcedure
    .input(conversionDraft)
    .mutation(async ({ input }) =>
      (await database()).transaction(async tx => {
        await lockConversion(tx);
        const prepared = await prepare(tx, input);
        // Return display fields only, keeping the source-row snapshot on the server.
        return {
          ...prepared,
          rows: prepared.rows.map(({ source, ...r }) => r),
        };
      })
    ),
  submit: operatorProcedure
    .input(conversionExecution)
    .mutation(({ input, ctx }) => createRequest(ctx, input, false)),
  execute: approvalProcedure
    .input(conversionExecution)
    .mutation(({ input, ctx }) => createRequest(ctx, input, true)),
  list: operatorProcedure
    .input(z.object({ sourceType: z.enum(["asset", "custody"]) }))
    .query(async ({ input }) =>
      (await database())
        .select()
        .from(inventoryConversions)
        .where(
          and(
            eq(inventoryConversions.sourceType, input.sourceType),
            eq(inventoryConversions.status, "PENDING")
          )
        )
        .orderBy(desc(inventoryConversions.id))
        .limit(100)
    ),
  details: operatorProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = await database();
      const [request] = await db
        .select()
        .from(inventoryConversions)
        .where(eq(inventoryConversions.id, input.id));
      if (!request) fail("طلب التحويل غير موجود", "NOT_FOUND");
      const items = await db
        .select()
        .from(inventoryConversionItems)
        .where(eq(inventoryConversionItems.conversionId, input.id));
      return { request, items };
    }),
  approve: approvalProcedure.input(reviewed).mutation(async ({ input, ctx }) =>
    (await database()).transaction(async tx => {
      await lockConversion(tx);
      const [request] = await tx
        .select()
        .from(inventoryConversions)
        .where(eq(inventoryConversions.id, input.id))
        .for("update");
      if (!request) fail("طلب التحويل غير موجود", "NOT_FOUND");
      if (request.status === "EXECUTED") return resultOf(tx, request);
      if (
        request.status !== "PENDING" ||
        request.version !== input.expectedVersion
      )
        fail("تغيرت حالة الطلب؛ حدّث القائمة", "CONFLICT");
      const prepared = await prepare(
        tx,
        conversionDraft.parse(parseHistoryData(request.payload)),
        request.id
      );
      if (!prepared.valid || prepared.previewHash !== request.previewHash)
        fail(
          "تغير السجل أو ارتباطاته منذ تقديم الطلب؛ ألغِ الطلب وأعد تجهيزه بعد المراجعة",
          "CONFLICT"
        );
      return executePrepared(tx, ctx, request, prepared);
    })
  ),
  cancel: operatorProcedure.input(reviewed).mutation(async ({ input, ctx }) =>
    (await database()).transaction(async tx => {
      await lockConversion(tx);
      const [request] = await tx
        .select()
        .from(inventoryConversions)
        .where(eq(inventoryConversions.id, input.id))
        .for("update");
      if (!request) fail("طلب التحويل غير موجود", "NOT_FOUND");
      if (request.createdBy !== ctx.user.id && !canApprove(ctx.user.role))
        fail("إلغاء الطلب متاح لمعدّه أو المختص", "FORBIDDEN");
      if (
        request.status !== "PENDING" ||
        request.version !== input.expectedVersion
      )
        fail("لا يمكن إلغاء تحويل منفذ أو طلب تغيرت حالته", "CONFLICT");
      await tx
        .update(inventoryConversions)
        .set({
          status: "CANCELLED",
          cancelledBy: ctx.user.id,
          version: request.version + 1,
        })
        .where(eq(inventoryConversions.id, input.id));
      const items = await tx
        .select()
        .from(inventoryConversionItems)
        .where(eq(inventoryConversionItems.conversionId, input.id));
      for (const r of items)
        await historyAudit(tx, ctx, {
          entityType: request.sourceType as "asset" | "custody",
          entityId: r.sourceId,
          tableName:
            request.sourceType === "asset" ? "assets" : "custody_items",
          recordId: r.sourceId,
          actionType: "CONVERT_CANCEL",
          actionDescription: `إلغاء طلب التحويل #${request.id}`,
          oldData: null,
          newData: { conversionId: request.id },
        });
      return { success: true };
    })
  ),
  links: operatorProcedure
    .input(
      z.object({
        entityType: z.enum(["asset", "custody"]),
        entityId: z.number().int().positive(),
      })
    )
    .query(async ({ input }) => {
      const db = await database();
      const [outgoing, incoming] = await Promise.all([
        db
          .select()
          .from(inventoryConversionItems)
          .where(
            and(
              eq(inventoryConversionItems.sourceType, input.entityType),
              eq(inventoryConversionItems.sourceId, input.entityId)
            )
          ),
        db
          .select()
          .from(inventoryConversionItems)
          .where(
            and(
              eq(inventoryConversionItems.targetType, input.entityType),
              eq(inventoryConversionItems.targetId, input.entityId)
            )
          ),
      ]);
      return [...outgoing, ...incoming]
        .filter(i => i.targetId != null)
        .map(i => ({
          conversionId: i.conversionId,
          sourceType: i.sourceType,
          sourceId: i.sourceId,
          targetType: i.targetType,
          targetId: i.targetId!,
          quantity: i.quantity,
          sourceCode: (parseHistoryData(i.sourceSnapshot).assetCode ??
            parseHistoryData(i.sourceSnapshot).code) as string,
          targetCode: parseHistoryData(i.targetSnapshot).targetCode as string,
        }));
    }),
});
