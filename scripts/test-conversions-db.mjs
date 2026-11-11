import "dotenv/config";
import mysql from "mysql2/promise";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const sourceUrl = process.env.DATABASE_URL;
if (!sourceUrl) throw new Error("DATABASE_URL required");
const schemaName = `tolan_conversion_qa_${Date.now()}_${randomBytes(4).toString("hex")}`;
const source = new URL(sourceUrl),
  target = new URL(sourceUrl),
  adminUrl = new URL(sourceUrl);
target.pathname = "/" + schemaName;
adminUrl.pathname = "/";
const owned = () =>
  /^tolan_conversion_qa_\d+_[a-f0-9]{8}$/.test(schemaName) &&
  schemaName !== decodeURIComponent(source.pathname.slice(1));
const safeName = name => {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error("Unsafe identifier");
  return "`" + name + "`";
};
const ssl = { minVersion: "TLSv1.2", rejectUnauthorized: true };
const run = path.resolve(
  "qa-results",
  `conversion-${new Date().toISOString().replace(/[:.]/g, "-")}`
);
mkdirSync(run, { recursive: true });
const result = {
  status: "RUNNING",
  schemaName,
  temporarySchemaRemoved: false,
  applicationDataWritten: false,
};
let admin,
  app,
  test,
  server,
  created = false;
const connect = uri =>
  mysql.createConnection({ uri, ssl, connectTimeout: 15000 });
const spawnExit = (args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env,
      windowsHide: true,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", code => resolve(code));
  });
try {
  if (!owned()) throw new Error("Invalid isolation target");
  admin = await connect(adminUrl.toString());
  app = await connect(sourceUrl);
  const [tables] = await app.query(
    "SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE'"
  );
  const definitions = [];
  for (const { name } of tables) {
    const [ddl] = await app.query("SHOW CREATE TABLE " + safeName(name));
    const text = String(ddl[0]["Create Table"]);
    if (
      !text.startsWith("CREATE TABLE ") ||
      /REFERENCES\s+`[^`]+`\.`/i.test(text)
    )
      throw new Error("Qualified schema references require review");
    definitions.push(text);
  }
  await admin.query(
    "CREATE DATABASE " +
      safeName(schemaName) +
      " CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
  );
  created = true;
  test = await connect(target.toString());
  // Empty schema only: no source rows, credentials, sessions or business data are copied.
  await test.query("SET FOREIGN_KEY_CHECKS=0");
  try {
    for (const ddl of definitions) await test.query(ddl);
  } finally {
    await test.query("SET FOREIGN_KEY_CHECKS=1");
  }
  for (const statement of readFileSync(
    "drizzle/0022_inventory_conversions.sql",
    "utf8"
  )
    .split("--> statement-breakpoint")
    .map(s => s.trim())
    .filter(Boolean))
    await test.query(statement);
  const passwordHash = await bcrypt.hash("Conversion-QA-Only-12345", 10);
  for (const [id, role] of [
    [1, "owner"],
    [2, "accountant"],
    [3, "accounting_manager"],
  ])
    await test.query(
      "INSERT INTO users (id,openId,username,passwordHash,name,loginMethod,role) VALUES (?,?,?,?,?,'local',?)",
      [
        id,
        `conversion-qa-${id}`,
        `conversion-qa-${id}`,
        passwordHash,
        `مستخدم اختبار ${id}`,
        role,
      ]
    );
  const env = {
    ...process.env,
    TEST_DATABASE_URL: target.toString(),
    RUN_CONVERSION_DB_TESTS: "1",
  };
  const code = await spawnExit(
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "server/inventoryConversion.integration.test.ts",
    ],
    env
  );
  if (code !== 0) throw new Error("Isolated conversion tests failed");
  result.status = "PASSED";
  if (process.argv.includes("--ui")) {
    // Production bundle, test-only database and ephemeral signing secret, loopback only.
    const port = "3219";
    server = spawn(process.execPath, ["dist/index.js"], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        NODE_ENV: "production",
        APP_HOST: "127.0.0.1",
        PORT: port,
        PUBLIC_APP_URL: `http://127.0.0.1:${port}`,
        DATABASE_URL: target.toString(),
        JWT_SECRET: randomBytes(48).toString("hex"),
      },
    });
    writeFileSync(
      path.join(run, "ui-ready.json"),
      JSON.stringify(
        {
          url: `http://127.0.0.1:${port}`,
          schemaName,
          stopFile: path.join(run, "stop"),
        },
        null,
        2
      )
    );
    console.log(
      "CONVERSION_UI_READY " +
        JSON.stringify({ url: `http://127.0.0.1:${port}`, run })
    );
    while (!existsSync(path.join(run, "stop")) && server.exitCode === null)
      await new Promise(resolve => setTimeout(resolve, 250));
  }
} catch (error) {
  result.status = "FAILED";
  result.error = String(error.message)
    .replaceAll(sourceUrl, "[APPLICATION_CONNECTION]")
    .replaceAll(target.toString(), "[TEST_CONNECTION]");
  console.error(result.error);
  process.exitCode = 1;
} finally {
  if (server && server.exitCode === null) {
    server.kill();
    await new Promise(resolve => server.once("exit", resolve));
  }
  await Promise.allSettled([test?.end(), app?.end(), admin?.end()]);
  // A browser test can outlast the server's idle connection timeout.
  // Use a fresh connection for cleanup instead of the setup connection.
  if (created && owned()) {
    let cleanup;
    try {
      cleanup = await connect(adminUrl.toString());
      await cleanup.query("DROP DATABASE " + safeName(schemaName));
      result.temporarySchemaRemoved = true;
    } catch (error) {
      result.cleanupError = String(error.message)
        .replaceAll(sourceUrl, "[APPLICATION_CONNECTION]")
        .replaceAll(target.toString(), "[TEST_CONNECTION]");
      process.exitCode = 1;
    } finally {
      await cleanup?.end();
    }
  }
  writeFileSync(path.join(run, "result.json"), JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      status: result.status,
      temporarySchemaRemoved: result.temporarySchemaRemoved,
      applicationDataWritten: false,
      run,
    })
  );
}
