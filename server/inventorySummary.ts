import { and, eq, sql } from "drizzle-orm";
import {
  assets,
  custodyItems,
  departments,
  branches,
  locations,
  employees,
  financialClassifications,
} from "../drizzle/schema";
import type { getDb } from "./db";
import {
  mergeSummaryGroups,
  type InventorySummaryInput,
  type InventorySummary,
} from "../shared/inventorySummary";

type Database = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type QueryDatabase = Pick<Database, "select">;

export function inventorySummaryQuery(
  db: QueryDatabase,
  table: typeof assets | typeof custodyItems,
  input: InventorySummaryInput
) {
  const dimensions = {
    department: {
      id: departments.id,
      name: departments.name,
      code: departments.code,
    },
    branch: { id: branches.id, name: branches.name, code: branches.code },
    location: { id: locations.id, name: locations.name, code: locations.code },
    employee: {
      id: employees.id,
      name: employees.fullName,
      code: sql<null>`NULL`,
    },
    classification: {
      id: financialClassifications.id,
      name: financialClassifications.name,
      code: financialClassifications.code,
    },
  };
  const group = dimensions[input.groupBy];
  const groupColumns = input.groupBy === "employee" ? [group.id, group.name] : [group.id, group.name, group.code];
  const filters = [sql`${table.status} NOT IN ('DRAFT', 'CANCELLED', 'CONVERTED')`];
  if (input.locationId) filters.push(eq(table.locationId, input.locationId));
  if (input.departmentId)
    filters.push(eq(table.departmentId, input.departmentId));
  if (input.branchId) filters.push(eq(departments.branchId, input.branchId));
  if (input.employeeId) filters.push(eq(table.assignedTo, input.employeeId));
  if (input.classificationId)
    filters.push(eq(table.classificationId, input.classificationId));
  const remaining = sql`GREATEST(${table.quantity} - COALESCE(${table.excludedQuantity}, 0) - COALESCE(${table.warrantyReplacedQuantity}, 0), 0)`;
  return db
    .select({
      groupId: group.id,
      groupName: group.name,
      groupCode: group.code,
      records: sql<number>`COUNT(*)`,
      quantity: sql<string>`COALESCE(SUM(${remaining}), 0)`,
      value: sql<string>`COALESCE(SUM(${remaining} * COALESCE(${table.assetValue}, 0)), 0.00)`,
    })
    .from(table)
    .leftJoin(departments, eq(table.departmentId, departments.id))
    .leftJoin(branches, eq(departments.branchId, branches.id))
    .leftJoin(locations, eq(table.locationId, locations.id))
    .leftJoin(employees, eq(table.assignedTo, employees.id))
    .leftJoin(
      financialClassifications,
      eq(table.classificationId, financialClassifications.id)
    )
    .where(and(...filters))
    .groupBy(...groupColumns);
}

export async function getInventorySummary(
  db: Database,
  input: InventorySummaryInput
): Promise<InventorySummary> {
  // Both aggregates share one read snapshot; no operational records are changed.
  const result = await db.transaction(
    async tx => {
      const assetRows =
        input.type === "custody"
          ? []
          : await inventorySummaryQuery(tx, assets, input);
      const custodyRows =
        input.type === "assets"
          ? []
          : await inventorySummaryQuery(tx, custodyItems, input);
      return mergeSummaryGroups(assetRows, custodyRows);
    },
    {
      isolationLevel: "repeatable read",
    }
  );
  return {
    ...result,
    groupBy: input.groupBy,
    type: input.type,
    generatedAt: new Date().toISOString(),
  };
}

export async function getInventorySummaryOptions(db: Database) {
  const [location, branch, department, employee, classification] =
    await Promise.all([
      db
        .select({
          id: locations.id,
          name: locations.name,
          code: locations.code,
        })
        .from(locations)
        .orderBy(locations.name),
      db
        .select({ id: branches.id, name: branches.name, code: branches.code })
        .from(branches)
        .orderBy(branches.name),
      db
        .select({
          id: departments.id,
          name: departments.name,
          code: departments.code,
        })
        .from(departments)
        .orderBy(departments.name),
      db
        .select({
          id: employees.id,
          name: employees.fullName,
          code: sql<null>`NULL`,
        })
        .from(employees)
        .orderBy(employees.fullName, employees.id),
      db
        .select({
          id: financialClassifications.id,
          name: financialClassifications.name,
          code: financialClassifications.code,
        })
        .from(financialClassifications)
        .orderBy(financialClassifications.name),
    ]);
  return { location, branch, department, employee, classification };
}
