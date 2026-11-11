import "dotenv/config";
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const db = await mysql.createConnection({
  uri: process.env.DATABASE_URL,
  ssl: { minVersion: "TLSv1.2", rejectUnauthorized: true },
});
try {
  const tracked = [
    "users",
    "assets",
    "custody_items",
    "depreciation_batches",
    "depreciation_periods",
    "depreciation_journals",
    "audit_log",
    "archive_documents",
  ];
  const counts = async () =>
    Object.fromEntries(
      await Promise.all(
        tracked.map(async table => {
          const [rows] = await db.query(`SELECT COUNT(*) n FROM \`${table}\``);
          return [table, Number(rows[0].n)];
        })
      )
    );
  const before = await counts();
  if (!process.argv.includes("--check")) {
    const sql = readFileSync(
      new URL("../drizzle/0022_inventory_conversions.sql", import.meta.url),
      "utf8"
    );
    for (const statement of sql
      .split("--> statement-breakpoint")
      .map(s => s.trim())
      .filter(Boolean)) {
      if (
        !/^CREATE TABLE IF NOT EXISTS `inventory_conversion(s|_items)` \(/.test(
          statement
        )
      )
        throw new Error("Unexpected migration statement");
      await db.query(statement);
    }
  }
  const [columns] = await db.query(
    "SELECT TABLE_NAME t,COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('inventory_conversions','inventory_conversion_items')"
  );
  const expected = {
    inventory_conversions: [
      "id",
      "requestKey",
      "sourceType",
      "status",
      "version",
      "payload",
      "previewHash",
      "createdBy",
      "createdByName",
      "executedBy",
      "executedByName",
      "executedAt",
      "cancelledBy",
      "createdAt",
    ],
    inventory_conversion_items: [
      "id",
      "conversionId",
      "sourceType",
      "sourceId",
      "targetType",
      "targetId",
      "quantity",
      "sourceSnapshot",
      "targetSnapshot",
    ],
  };
  const ready = Object.entries(expected).every(
    ([table, names]) =>
      columns.filter(c => c.t === table).length === names.length &&
      names.every(name => columns.some(c => c.t === table && c.c === name))
  );
  if (!ready && !process.argv.includes("--check"))
    throw new Error("Conversion schema verification failed");
  const after = await counts();
  console.log(
    JSON.stringify({
      mode: process.argv.includes("--check") ? "read-only" : "apply",
      schemaReady: ready,
      existingCountsUnchanged: JSON.stringify(before) === JSON.stringify(after),
      counts: after,
    })
  );
} finally {
  await db.end();
}
