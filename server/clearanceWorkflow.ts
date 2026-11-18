import { eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { auditLog, clearanceRecords, employees } from "../drizzle/schema";
import { isPermanentClearance } from "../shared/clearance";
import type { TrpcContext } from "./_core/context";
import { operationalFinanceLock } from "./financialOperationalGuard";
import { executeReviewedTotalTransfer, readTotalTransferScope, transferItem, transferReviewInput, type TransferTx } from "./transferWorkflow";

const rowSchema = z.object({
  id: z.number(), name: z.string(), code: z.string().nullable(), quantity: z.number(),
  departmentId: z.number().nullable(), departmentName: z.string(),
  branchName: z.string().nullable(), locationName: z.string().nullable(),
  groupKey: z.string(), departmentLabel: z.string(),
});

export const clearanceReviewInput = z.object({
  snapshot: transferReviewInput.shape.snapshot,
  recipients: z.array(z.object({
    groupKey: z.string(),
    toEmployeeId: z.number().int().positive(),
  })),
  statements: z.array(z.string()),
  signatures: z.array(z.string()),
});

const storedSnapshot = z.object({
  version: z.literal(1),
  assets: z.array(rowSchema),
  custody: z.array(rowSchema),
  departmentAlternates: z.record(z.string(), z.string()),
  transferDocumentId: z.number().int().positive().nullable(),
  statements: z.array(z.string()),
  signatures: z.array(z.string()),
});

export function readClearanceSnapshot(value: unknown) {
  const result = storedSnapshot.safeParse(value);
  return result.success ? result.data : null;
}

type Scope = Awaited<ReturnType<typeof readTotalTransferScope>>;

export function clearanceInventory(scope: Scope) {
  const assets: Array<z.infer<typeof rowSchema> & { value: string | null; type: "asset" | "custody" }> = [];
  const custody: typeof assets = [];
  function add(entity: Scope["incomplete"][number], departmentName: string, branchName: string | null, locationName: string | null, groupKey: string) {
    const item = transferItem(entity);
    const row = {
      ...item, departmentId: entity.departmentId ?? null, departmentName, branchName, locationName, groupKey,
      departmentLabel: [departmentName, branchName, locationName].filter(Boolean).join(" · "),
    };
    (item.type === "asset" ? assets : custody).push(row);
  }
  for (const group of scope.groups) {
    for (const entity of [...group.assets, ...group.custody]) {
      add(entity, group.departmentName, group.branchName, group.locationName, String(group.departmentId));
    }
  }
  const hierarchy = new Map(scope.hierarchy.map(department => [department.departmentId, department]));
  for (const entity of scope.incomplete) {
    const department = hierarchy.get(entity.departmentId ?? 0);
    const groupKey = ["unallocated", entity.departmentId ?? 0, entity.locationId ?? 0].join(":");
    add(entity, department?.departmentName || "عام", null, null, groupKey);
  }
  return { assets, custody, snapshot: scope.snapshot, incompleteCount: scope.incomplete.length };
}

type ReviewInput = z.infer<typeof clearanceReviewInput>;
type ReviewedClearanceInput = {
  clearanceCode: string;
  employeeId: number;
  reason?: string | null;
  lastWorkDay?: string | null;
  htmlFilePath?: string | null;
  review: ReviewInput;
};

export async function saveReviewedClearance(
  tx: TransferTx,
  ctx: TrpcContext & { user: NonNullable<TrpcContext["user"]> },
  input: ReviewedClearanceInput,
) {
  await operationalFinanceLock(tx);
  const [existing] = await tx.select().from(clearanceRecords)
    .where(eq(clearanceRecords.clearanceCode, input.clearanceCode)).limit(1).for("update");
  if (existing) {
    const saved = readClearanceSnapshot(existing.replacementData);
    if (saved && existing.employeeId === input.employeeId && existing.reason === input.reason && existing.createdBy === ctx.user.id) {
      return { success: true, id: existing.id, transferDocumentId: saved.transferDocumentId, transferredCount: saved.transferDocumentId ? saved.assets.length + saved.custody.length : 0 };
    }
    throw new TRPCError({ code: "CONFLICT", message: "رقم براءة الذمة مستخدم بالفعل." });
  }

  const scope = await readTotalTransferScope(tx, input.employeeId, true);
  if (scope.snapshot !== input.review.snapshot) {
    throw new TRPCError({ code: "CONFLICT", message: "تغيّرت عهد الموظف أو أقسامه. راجع الأصول والعُهد والبدلاء قبل الحفظ." });
  }
  const { assets, custody } = clearanceInventory(scope);
  let transferDocumentId: number | null = null;
  let transferredCount = 0;
  let departmentAlternates: Record<string, string>;

  const groupKeys = new Set([...assets, ...custody].map(row => row.groupKey));
  const recipients = new Map(input.review.recipients.map(({ groupKey, toEmployeeId }) => [groupKey, toEmployeeId]));
  if (recipients.size !== groupKeys.size || recipients.size !== input.review.recipients.length ||
    [...groupKeys].some(key => !recipients.has(key))) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "اختر موظفًا بديلًا لكل قسم معروض." });
  }

  if (isPermanentClearance(input.reason)) {
    const result = await executeReviewedTotalTransfer(tx, ctx, scope, {
      snapshot: input.review.snapshot,
      fromEmployeeId: input.employeeId,
      recipients: scope.groups.map(({ departmentId }) => ({ departmentId, toEmployeeId: recipients.get(String(departmentId))! })),
    }, input.clearanceCode);
    departmentAlternates = Object.fromEntries([...recipients].map(([key, id]) => [key, result.recipientNames.get(id)!]));
    transferDocumentId = result.documentId;
    transferredCount = result.count;
  } else {
    const ids = [...new Set(recipients.values())];
    if (ids.includes(input.employeeId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "اختر موظفًا بديلًا مختلفًا عن الموظف الحالي." });
    }
    const options = ids.length ? await tx.select({ id: employees.id, name: employees.fullName })
      .from(employees).where(inArray(employees.id, ids)) : [];
    const names = new Map(options.map(({ id, name }) => [id, name]));
    if (names.size !== ids.length) throw new TRPCError({ code: "BAD_REQUEST", message: "أحد الموظفين البدلاء غير موجود." });
    departmentAlternates = Object.fromEntries([...recipients].map(([key, id]) => [key, names.get(id)!]));
  }

  const [result] = await tx.insert(clearanceRecords).values({
    clearanceCode: input.clearanceCode,
    employeeId: input.employeeId,
    employeeName: scope.employee.fullName,
    fingerprintId: scope.employee.fingerprintId || null,
    reason: input.reason || null,
    lastWorkDay: input.lastWorkDay ? new Date(input.lastWorkDay) : null,
    htmlFilePath: input.htmlFilePath || null,
    status: "ACTIVE",
    replacementData: {
      version: 1, assets, custody, departmentAlternates, transferDocumentId,
      statements: input.review.statements, signatures: input.review.signatures,
    } satisfies z.infer<typeof storedSnapshot>,
    createdBy: ctx.user.id,
  });
  const clearanceId = Number(result.insertId);
  await tx.insert(auditLog).values({
    tableName: "clearance_records",
    recordId: clearanceId,
    actionType: "CLEARANCE",
    actionDescription: "إصدار براءة ذمة للموظف: " + scope.employee.fullName,
    newData: { clearanceCode: input.clearanceCode, employeeId: input.employeeId, reason: input.reason, transferDocumentId, transferredCount },
    performedBy: ctx.user.id,
    performedByName: ctx.user.name,
    ipAddress: ctx.req.ip ?? null,
    userAgent: ctx.req.headers["user-agent"] ?? null,
  });
  return { success: true, id: clearanceId, transferDocumentId, transferredCount };
}

