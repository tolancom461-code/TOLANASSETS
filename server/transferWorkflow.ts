import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { archiveDocuments, assets, assetTransfers, branches, custodyItems, departments, employees, locations } from "../drizzle/schema";
import { remainingQuantity } from "../shared/inventoryQuantity";
import type { TrpcContext } from "./_core/context";
import { operatorProcedure } from "./_core/trpc";
import { getDb } from "./db";
import { operationalFinanceLock, protectFinancialHistoryForEntities } from "./financialOperationalGuard";
import { historyAudit } from "./history";

type TransferKind = "asset" | "custody";
type TransferEntity = typeof assets.$inferSelect | typeof custodyItems.$inferSelect;
type OperatorContext = TrpcContext & { user: NonNullable<TrpcContext["user"]> };

export function transferItem(entity: TransferEntity) {
  const isAsset = "assetName" in entity;
  return {
    id: entity.id,
    name: isAsset ? entity.assetName : entity.name,
    code: isAsset ? entity.assetCode : entity.code,
    quantity: remainingQuantity(entity),
    value: entity.assetValue,
    type: isAsset ? "asset" as const : "custody" as const,
  };
}
type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
export type TransferTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type TransferDestination = {
  employeeId: number;
  departmentId: number;
  departmentName: string;
  locationId: number;
  locationName: string;
};
type TransferDepartment = Omit<TransferDestination, "employeeId"> & {
  branchId: number;
  branchName: string;
  assets: TransferEntity[];
  custody: TransferEntity[];
};

export function employeeInventory(db: Pick<Db, "select">, kind: TransferKind, employeeId: number, lock: boolean) {
  const table = kind === "asset" ? assets : custodyItems;
  const query = db.select().from(table).where(and(
    eq(table.assignedTo, employeeId),
    eq(table.status, "ACTIVE"),
    sql`${table.quantity} - COALESCE(${table.excludedQuantity}, 0) - ${table.warrantyReplacedQuantity} > 0`,
  )).orderBy(asc(table.id));
  return lock ? query.for("update") : query;
}

export function isTransferable(entity: TransferEntity) {
  const quantity = remainingQuantity(entity);
  return entity.status === "ACTIVE" && Number.isInteger(quantity) && quantity > 0 && (entity.excludedQuantity ?? 0) >= 0;
}

export async function recordTransfer(tx: TransferTx, ctx: OperatorContext, {
  kind, entity, movementType, destination, sourceEmployeeName, targetEmployeeName,
  sourceDepartmentName, sourceLocationName, notes, affectedEntityIds,
}: {
  kind: TransferKind;
  entity: TransferEntity;
  movementType: "total" | "partial";
  destination: TransferDestination;
  sourceEmployeeName: string;
  targetEmployeeName: string;
  sourceDepartmentName: string | null;
  sourceLocationName: string | null;
  notes?: string | null;
  affectedEntityIds: number[];
}) {
  const item = transferItem(entity);
  const quantity = item.quantity;
  const snapshot = {
    entityName: item.name,
    entityCode: item.code,
    fromEmployeeName: sourceEmployeeName,
    toEmployeeName: targetEmployeeName,
  };
  const record = {
    entityType: kind, entityId: entity.id, movementType,
    fromEmployeeId: entity.assignedTo, toEmployeeId: destination.employeeId,
    fromDepartment: sourceDepartmentName, toDepartment: destination.departmentName,
    fromLocation: sourceLocationName, toLocation: destination.locationName,
    quantity, assetValue: entity.assetValue, notes: notes || null, transferredBy: ctx.user.id,
  };
  const inserted = await tx.insert(assetTransfers).values(record);
  const id = Number(inserted[0].insertId);
  const table = kind === "asset" ? assets : custodyItems;
  await tx.update(table).set({
    assignedTo: destination.employeeId,
    departmentId: destination.departmentId,
    locationId: destination.locationId,
  }).where(eq(table.id, entity.id));
  await historyAudit(tx, ctx, {
    entityType: kind, entityId: entity.id, transferId: id, tableName: "asset_transfers", recordId: id, actionType: "TRANSFER",
    actionDescription: "نقل " + (kind === "asset" ? "أصل" : "عهدة") + " #" + entity.id,
    oldData: entity, newData: { ...record, destination, affectedEntityIds, transferSnapshot: snapshot },
    changedFields: [
      ...(entity.assignedTo !== destination.employeeId ? ["assignedTo"] : []),
      ...(entity.departmentId !== destination.departmentId ? ["departmentId"] : []),
      ...(entity.locationId !== destination.locationId ? ["locationId"] : []),
    ],
  });
  return { id, quantity };
}

export async function readTotalTransferScope(db: Pick<Db, "select">, employeeId: number, lock = false) {
  const [employee] = await db.select({ fullName: employees.fullName, fingerprintId: employees.fingerprintId, nationalId: employees.nationalId }).from(employees)
    .where(eq(employees.id, employeeId)).limit(1);
  if (!employee) throw new TRPCError({ code: "BAD_REQUEST", message: "الموظف المصدر غير موجود" });

  const assetRows = await employeeInventory(db, "asset", employeeId, lock);
  const custodyRows = await employeeInventory(db, "custody", employeeId, lock);
  const eligible = [...assetRows, ...custodyRows].filter(isTransferable);
  const departmentIds = [...new Set(eligible.flatMap(row => row.departmentId ? [row.departmentId] : []))];
  const hierarchyQuery = db.select({
    departmentId: departments.id, departmentName: departments.name,
    branchId: branches.id, branchName: branches.name,
    locationId: locations.id, locationName: locations.name,
  }).from(departments)
    .leftJoin(branches, eq(departments.branchId, branches.id))
    .leftJoin(locations, eq(branches.locationId, locations.id))
    .where(inArray(departments.id, departmentIds))
    .orderBy(asc(departments.id));
  const hierarchy = departmentIds.length ? await (lock ? hierarchyQuery.for("update") : hierarchyQuery) : [];
  const groups = new Map<number, TransferDepartment>();
  for (const row of hierarchy) {
    const { branchId, branchName, locationId, locationName } = row;
    if (branchId != null && branchName != null && locationId != null && locationName != null) {
      groups.set(row.departmentId, { ...row, branchId, branchName, locationId, locationName, assets: [], custody: [] });
    }
  }

  const incomplete: TransferEntity[] = [];
  for (const entity of eligible) {
    const group = groups.get(entity.departmentId ?? 0);
    if (!group || group.locationId !== entity.locationId) {
      incomplete.push(entity);
      continue;
    }
    const rows = "assetName" in entity ? group.assets : group.custody;
    rows.push(entity);
  }
  const populated = [...groups.values()].filter(group => group.assets.length || group.custody.length);
  const fingerprint = (entity: TransferEntity) => [entity.id, entity.quantity, entity.excludedQuantity ?? 0, entity.warrantyReplacedQuantity ?? 0];
  const snapshot = createHash("sha256").update(JSON.stringify([
    employeeId, employee.fullName, incomplete.map(entity => [transferItem(entity).type, entity.departmentId, entity.locationId, ...fingerprint(entity)]),
    populated.map(({ assets, custody, ...group }) => [group, assets.map(fingerprint), custody.map(fingerprint)]),
  ])).digest("hex");
  return { employee, groups: populated, incomplete, hierarchy, snapshot };
}

const sourceInput = z.object({ fromEmployeeId: z.number().int().positive() });
export const transferReviewInput = z.object({
  snapshot: z.string().regex(/^[a-f0-9]{64}$/),
  recipients: z.array(z.object({
    departmentId: z.number().int().positive(),
    toEmployeeId: z.number().int().positive(),
  })),
});
const totalInput = sourceInput.extend({
  ...transferReviewInput.shape,
  recipients: transferReviewInput.shape.recipients.min(1),
});

export const departmentTransferProcedures = {
  previewTotal: operatorProcedure.input(sourceInput).query(async ({ input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const { groups, employee, snapshot, incomplete } = await readTotalTransferScope(db, input.fromEmployeeId);
    return {
      employeeName: employee.fullName, snapshot, incompleteCount: incomplete.length,
      groups: groups.map(({ assets, custody, ...group }) => ({
        ...group, assetCount: assets.length, custodyCount: custody.length,
      })),
    };
  }),
  executeTotal: operatorProcedure.input(totalInput).mutation(async ({ input, ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    return db.transaction(async tx => {
      await operationalFinanceLock(tx);
      const scope = await readTotalTransferScope(tx, input.fromEmployeeId, true);
      const { recipientNames, ...result } = await executeReviewedTotalTransfer(tx, ctx, scope, input);
      return result;
    });
  }),
};


export async function executeReviewedTotalTransfer(
  tx: TransferTx,
  ctx: OperatorContext,
  scope: Awaited<ReturnType<typeof readTotalTransferScope>>,
  input: z.infer<typeof transferReviewInput> & { fromEmployeeId: number },
  clearanceCode?: string,
) {
  if (scope.snapshot !== input.snapshot) {
    throw new TRPCError({ code: "CONFLICT", message: "تغيّرت السجلات أو الأقسام منذ المعاينة. راجع القائمة المحدّثة قبل النقل." });
  }
  if (clearanceCode && scope.incomplete.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "صحّح تخصيص الموقع أو القسم للسجلات المبيّنة قبل إصدار براءة الذمة." });
  }

  const recipients = new Map(input.recipients.map(row => [row.departmentId, row.toEmployeeId]));
  if (input.recipients.length !== scope.groups.length || recipients.size !== scope.groups.length ||
    scope.groups.some(group => !recipients.has(group.departmentId))) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "اختر موظفًا مستلمًا واحدًا لكل قسم معروض." });
  }
  if (!scope.groups.length) {
    return { count: 0, quantityMoved: 0, transferIds: [], documentId: null, recipientNames: new Map<number, string>() };
  }
  const recipientIds = [...new Set(recipients.values())];
  if (recipientIds.includes(input.fromEmployeeId)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "اختر موظفًا مستلمًا مختلفًا عن الموظف الحالي." });
  }
  const employeeRows = await tx.select({ id: employees.id, fullName: employees.fullName }).from(employees)
    .where(inArray(employees.id, recipientIds));
  const recipientNames = new Map(employeeRows.map(row => [row.id, row.fullName]));
  if (recipientNames.size !== recipientIds.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "أحد الموظفين المستلمين غير موجود. حدّث القائمة واختر مستلمًا آخر." });
  }

  const financialRecords = scope.groups.flatMap(group => [
    ...group.assets.map(entity => ({ type: "asset", id: entity.id })),
    ...group.custody.map(entity => ({ type: "custody", id: entity.id })),
  ]);
  await protectFinancialHistoryForEntities(tx, financialRecords, new Date().toISOString().slice(0, 10));
  const rows = [];
  const notes = clearanceCode ? "براءة الذمة " + clearanceCode : null;
  for (const group of scope.groups) {
    const employeeId = recipients.get(group.departmentId)!;
    const targetEmployeeName = recipientNames.get(employeeId)!;
    const { departmentId, departmentName, locationId, locationName, branchName } = group;
    const destination = { employeeId, departmentId, departmentName, locationId, locationName };
    for (const entity of [...group.assets, ...group.custody]) {
      const item = transferItem(entity);
      const result = await recordTransfer(tx, ctx, {
        kind: item.type, entity, movementType: "total", destination,
        sourceEmployeeName: scope.employee.fullName, targetEmployeeName,
        sourceDepartmentName: departmentName, sourceLocationName: locationName, notes,
        affectedEntityIds: [entity.id],
      });
      rows.push({
        transferId: result.id, entityType: item.type, entityName: item.name, entityCode: item.code,
        quantity: result.quantity, departmentName, branchName, locationName, targetEmployeeName,
      });
    }
  }

  const transferIds = rows.map(row => row.transferId);
  const quantityMoved = rows.reduce((sum, row) => sum + row.quantity, 0);
  const [document] = await tx.insert(archiveDocuments).values({
    entityType: "total_transfer",
    operationType: "نقل كلي",
    transferId: transferIds[0],
    sourceKey: "total-transfer:" + transferIds[0],
    documentTitle: ["نقل كلي", scope.employee.fullName, clearanceCode].filter(Boolean).join(" · "),
    fileName: "total-transfer-" + transferIds[0] + ".html",
    isAutoGenerated: true,
    createdBy: ctx.user.id,
    snapshot: {
      version: 1, eventType: "TOTAL_TRANSFER", performedBy: ctx.user.id, performedByName: ctx.user.name,
      recordedAt: new Date().toISOString(),
      newData: { fromEmployeeName: scope.employee.fullName, clearanceCode, rows, quantityMoved },
    },
  });
  return { count: rows.length, quantityMoved, transferIds, documentId: Number(document.insertId), recipientNames };
}
