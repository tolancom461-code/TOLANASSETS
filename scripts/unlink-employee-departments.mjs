import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";

const args = process.argv.slice(2);
const apply = args[0] === "--apply";
if (args.length && !(apply && args.length === 2 && /^[a-f0-9]{64}$/.test(args[1]))) {
  throw new Error("Run without arguments for a preview, or use --apply with the preview token");
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const target = new URL(process.env.DATABASE_URL);
if (!target.pathname.slice(1)) throw new Error("A database name is required");

const db = await mysql.createConnection({
  uri: process.env.DATABASE_URL,
  ssl: { minVersion: "TLSv1.2", rejectUnauthorized: true },
});
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const legacyFields = "departmentId IS NOT NULL OR code IS NOT NULL OR sequenceNo IS NOT NULL";
const monitoredQueries = {
  employees: "SELECT id, fullName, fingerprintId, nationalId, phone FROM employees ORDER BY id",
  assets: "SELECT id, assignedTo, departmentId, locationId FROM assets ORDER BY id",
  custody: "SELECT id, assignedTo, departmentId, locationId FROM custody_items ORDER BY id",
  users: "SELECT id, employeeId FROM users ORDER BY id",
  transfers: "SELECT id, fromEmployeeId, toEmployeeId FROM asset_transfers ORDER BY id",
  clearances: "SELECT id, employeeId FROM clearance_records ORDER BY id",
};

async function snapshot() {
  const result = {};
  const employeeDepartments = new Map();
  for (const [name, query] of Object.entries(monitoredQueries)) {
    const [rows] = await db.query(query);
    result[name] = { count: rows.length, checksum: hash(rows) };
    if (name !== "assets" && name !== "custody") continue;
    result[name].assigned = rows.filter(row => row.assignedTo !== null).length;
    for (const { assignedTo, departmentId } of rows) {
      if (assignedTo === null || departmentId === null) continue;
      const departments = employeeDepartments.get(assignedTo) ?? new Set();
      departments.add(departmentId);
      employeeDepartments.set(assignedTo, departments);
    }
  }
  result.employeesAssignedAcrossDepartments = [...employeeDepartments.values()]
    .filter(departments => departments.size > 1).length;
  return result;
}

try {
  await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  await db.beginTransaction();
  const [legacy] = await db.query(
    `SELECT id, departmentId, code, sequenceNo FROM employees WHERE ${legacyFields} ORDER BY id${apply ? " FOR UPDATE" : ""}`
  );
  const previewToken = hash([target.host, target.pathname, legacy]);
  if (apply && args[1] !== previewToken) {
    throw new Error("Employee links or database target changed since the preview");
  }
  const before = await snapshot();
  let backupFile;
  if (apply && legacy.length) {
    const root = path.resolve("qa-results");
    mkdirSync(root, { recursive: true });
    const backupDirectory = mkdtempSync(path.join(root, "employee-department-unlink-"));
    backupFile = path.join(backupDirectory, "previous-employee-links.json");
    writeFileSync(backupFile, JSON.stringify({ previewToken, employees: legacy }, null, 2), { flag: "wx" });

    const [updated] = await db.query(
      `UPDATE employees SET departmentId = NULL, code = NULL, sequenceNo = NULL, updatedAt = updatedAt WHERE ${legacyFields}`
    );
    if (updated.affectedRows !== legacy.length) throw new Error("Unexpected number of changed employee rows");
    const [remaining] = await db.query(`SELECT id FROM employees WHERE ${legacyFields} LIMIT 1 FOR UPDATE`);
    if (remaining.length || hash(await snapshot()) !== hash(before)) {
      throw new Error("Employee data or record assignments did not pass verification");
    }
    await db.execute(
      "INSERT INTO audit_log (tableName, actionType, actionDescription, newData, changedFields, performedByName) VALUES (?, ?, ?, ?, ?, ?)",
      ["employees", "UPDATE", "إزالة الربط التنظيمي القديم للموظفين", JSON.stringify({ employeesUpdated: legacy.length }),
        JSON.stringify(["departmentId", "code", "sequenceNo"]), "صيانة النظام"]
    );
  }
  await db.commit();
  const { employeesAssignedAcrossDepartments, ...checks } = before;
  const counts = Object.fromEntries(Object.entries(checks).map(([name, { checksum, ...totals }]) => [name, totals]));
  console.log(JSON.stringify({
    mode: apply ? "applied" : "preview",
    employeesWithLegacyFields: legacy.length,
    employeesLinkedToDepartment: legacy.filter(row => row.departmentId !== null).length,
    employeesUpdated: apply ? legacy.length : 0,
    counts,
    employeesAssignedAcrossDepartments,
    ...(apply ? { remainingLegacyRows: 0, employeeDataAndAssignmentsVerified: true, backupFile } : { previewToken }),
  }));
} catch (error) {
  await db.rollback();
  throw error;
} finally {
  await db.end();
}
