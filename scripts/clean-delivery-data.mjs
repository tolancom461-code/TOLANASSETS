// One-off customer-handover cleanup, explicitly authorized by the user.
// DELETEs are atomic; schema, migrations and every existing user are preserved.
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { gzipSync, createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';

const root = 'qa-results/client-handover-2026-10-14';
const planFile = `${root}/cleanup-plan.json`;
const resultFile = `${root}/cleanup-result.json`;
const execute = process.argv[2] === '--execute-user-authorized';
if (!execute && process.argv[2] !== '--plan') throw Error('Use --plan or --execute-user-authorized');
if (execute && existsSync(resultFile)) throw Error('A cleanup result already exists; no repeat execution');
const serialize = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
const sha = value => createHash('sha256').update(value).digest('hex');
const id = name => { if (!/^[A-Za-z0-9_]+$/.test(name)) throw Error('Unsafe SQL identifier'); return mysql.escapeId(name); };
const url = new URL(process.env.DATABASE_URL);
const databaseIdentity = sha(`${url.hostname}:${url.port}${url.pathname}`);
const preserve = new Set(['users', '__drizzle_migrations', 'depreciation_control']);
const db = await mysql.createConnection({ uri: process.env.DATABASE_URL, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true, ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true } });
let transaction = false;
const result = { status: 'RUNNING', startedAt: new Date().toISOString(), databaseIdentity, authorization: 'User requested removing current database data for customer handover while keeping all users', tableChecks: [] };
mkdirSync(root, { recursive: true });
try {
  const [tableMeta] = await db.query("SELECT TABLE_NAME AS tableName,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME");
  const names = tableMeta.map(t => t.tableName);
  if (!names.includes('users') || !names.includes('depreciation_control')) throw Error('Unexpected application schema');
  if (tableMeta.some(t => t.engine.toLowerCase() !== 'innodb')) throw Error('Nontransactional table detected');
  const [columnRows] = await db.query("SELECT TABLE_NAME AS tableName,COLUMN_NAME AS name,DATA_TYPE AS dataType,COLUMN_TYPE AS columnType,IS_NULLABLE AS isNullable,COLUMN_KEY AS `key`,EXTRA AS extra,ORDINAL_POSITION AS ordinalPosition FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION");
  const columns = {};
  for (const row of columnRows) { const { tableName, isNullable, ...column } = row; (columns[tableName] ??= []).push({ ...column, nullable: isNullable === 'YES' }); }
  const [foreignKeys] = await db.query("SELECT TABLE_NAME AS childTable,COLUMN_NAME AS childColumn,REFERENCED_TABLE_NAME AS parentTable,REFERENCED_COLUMN_NAME AS parentColumn,CONSTRAINT_NAME AS constraintName FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION");
  for (const fk of foreignKeys.filter(f => preserve.has(f.childTable) && !preserve.has(f.parentTable))) {
    if (!(fk.childTable === 'users' && fk.childColumn === 'employeeId' && columns.users.find(c => c.name === 'employeeId')?.nullable)) throw Error('Unexpected preserved-table dependency');
  }
  const remaining = new Set(names), ordered = [];
  while (remaining.size) {
    const ready = [...remaining].filter(t => !foreignKeys.some(f => f.childTable === t && f.parentTable !== t && remaining.has(f.parentTable))).sort();
    if (!ready.length) throw Error('Cyclic table dependencies');
    for (const t of ready) { remaining.delete(t); ordered.push(t); }
  }
  const schema = { tableNames: names, columns, foreignKeys };
  const schemaHash = sha(serialize(schema));
  if (!execute) {
    const counts = {};
    for (const table of names) { const [rows] = await db.query(`SELECT COUNT(*) AS n FROM ${id(table)}`); counts[table] = Number(rows[0].n); }
    writeFileSync(planFile, JSON.stringify({ databaseIdentity, schemaHash, tableNames: names, counts, preserve: [...preserve], clear: [...ordered].reverse().filter(t => !preserve.has(t)) }, null, 2));
    console.log(JSON.stringify({ status: 'PLANNED_NO_WRITES', tables: counts, usersPreserved: counts.users, planFile }));
  } else {
    const plan = JSON.parse(readFileSync(planFile, 'utf8'));
    if (plan.databaseIdentity !== databaseIdentity || plan.schemaHash !== schemaHash) throw Error('Database or schema changed since plan');
    const ddl = {};
    for (const table of names) { const [rows] = await db.query(`SHOW CREATE TABLE ${id(table)}`); ddl[table] = rows[0]['Create Table']; }
    await db.beginTransaction(); transaction = true;
    const tables = {};
    for (const table of names.filter(t => preserve.has(t))) { const [rows] = await db.query(`SELECT * FROM ${id(table)} FOR UPDATE`); tables[table] = rows; }
    if (!tables.users.length || !tables.depreciation_control.some(r => r.id === 1)) throw Error('Required user/control rows missing');
    const stats = {}, primaryKeys = {};
    for (const table of names) {
      const keys = columns[table].filter(c => c.key === 'PRI');
      if (keys.length !== 1) throw Error('Expected a single primary key: ' + table);
      primaryKeys[table] = keys[0].name;
      const [rows] = await db.query(`SELECT COUNT(*) AS n FROM ${id(table)}`); stats[table] = Number(rows[0].n);
    }
    const snapshot = { type: 'manifest', format: 'tolan-jsonl-gzip-1', createdAt: new Date().toISOString(), schema, stats, ddl, databaseIdentity };
    const backup = `${root}/before-cleanup-${snapshot.createdAt.replace(/[:.]/g, '-')}.jsonl.gz`;
    writeFileSync(backup, '', { flag: 'wx', mode: 0o600 });
    const sourceHash = createHash('sha256');
    // Concatenated gzip members are valid gzip and keep memory bounded per row.
    const saveLine = async value => { const line = serialize(value) + '\n'; sourceHash.update(line); appendFileSync(backup, gzipSync(line, { level: 4 })); };
    await saveLine(snapshot);
    for (const table of names) {
      let last = null, count = 0;
      while (true) {
        const pk = primaryKeys[table];
        const [rows] = await db.query(`SELECT * FROM ${id(table)} ${last === null ? '' : `WHERE ${id(pk)} > ?`} ORDER BY ${id(pk)} LIMIT 20 FOR UPDATE`, last === null ? [] : [last]);
        if (!rows.length) break;
        for (const row of rows) await saveLine({ type: 'row', table, row });
        count += rows.length; last = rows.at(-1)[pk];
        if (count % 1000 === 0) console.log(JSON.stringify({ phase: 'BACKUP_PROGRESS', table, records: count, expected: stats[table] }));
      }
      if (count !== stats[table]) throw Error('Backup row count mismatch: ' + table);
      console.log(JSON.stringify({ phase: 'BACKUP', table, records: count }));
    }
    const verifiedHash = createHash('sha256'), checkedCounts = Object.fromEntries(names.map(t => [t, 0]));
    for await (const line of createInterface({ input: createReadStream(backup).pipe(createGunzip()), crlfDelay: Infinity })) {
      verifiedHash.update(line + '\n');
      const entry = JSON.parse(line);
      if (entry.type === 'manifest') { if (serialize(entry) !== serialize(snapshot)) throw Error('Backup manifest differs'); }
      else if (entry.type === 'row' && names.includes(entry.table)) checkedCounts[entry.table]++;
      else throw Error('Unexpected backup record');
    }
    if (sourceHash.digest('hex') !== verifiedHash.digest('hex') || names.some(t => checkedCounts[t] !== stats[t])) throw Error('Compressed backup verification failed');
    const fileHash = createHash('sha256'); for await (const chunk of createReadStream(backup)) fileHash.update(chunk);
    result.backup = { filename: backup, sha256: fileHash.digest('hex'), format: snapshot.format, roundTripVerified: true, schemaIncluded: true, counts: checkedCounts };
    console.log(JSON.stringify({ phase: 'BACKUP_VERIFIED', tables: names.length }));
    await db.query('UPDATE users SET employeeId=NULL WHERE employeeId IS NOT NULL');
    for (const table of [...ordered].reverse().filter(t => !preserve.has(t))) {
      const pk = primaryKeys[table];
      while (true) {
        const [rows] = await db.query(`SELECT ${id(pk)} FROM ${id(table)} ORDER BY ${id(pk)} LIMIT 50`);
        if (!rows.length) break;
        await db.query(`DELETE FROM ${id(table)} WHERE ${id(pk)} IN (${rows.map(() => '?').join(',')})`, rows.map(r => r[pk]));
      }
      console.log(JSON.stringify({ phase: 'CLEARED', table }));
    }
    await db.query('UPDATE depreciation_control SET revision=0 WHERE id=1');
    for (const table of names) {
      const [rows] = await db.query(`SELECT COUNT(*) AS n FROM ${id(table)}`);
      const expected = preserve.has(table) ? stats[table] : 0;
      const actual = Number(rows[0].n);
      result.tableChecks.push({ table, before: stats[table], after: actual, expected, pass: actual === expected });
      if (actual !== expected) throw Error('Unexpected remaining rows: ' + table);
    }
    const [users] = await db.query('SELECT * FROM users ORDER BY id');
    const userKeys = columns.users.map(c => c.name).filter(k => !['employeeId', 'updatedAt'].includes(k));
    result.userAccountsPreserved = users.length === tables.users.length && users.every(u => {
      const original = tables.users.find(r => r.id === u.id);
      return original && u.employeeId === null && userKeys.every(k => serialize(u[k]) === serialize(original[k]));
    });
    if (!result.userAccountsPreserved) throw Error('User identities, credentials, roles or session metadata changed');
    if (tables.__drizzle_migrations) {
      const [migrations] = await db.query('SELECT * FROM __drizzle_migrations');
      if (serialize(migrations) !== serialize(tables.__drizzle_migrations)) throw Error('Migration metadata changed');
    }
    const [control] = await db.query('SELECT revision FROM depreciation_control WHERE id=1');
    if (Number(control[0].revision) !== 0) throw Error('Finance control reset failed');
    await db.commit(); transaction = false;
    result.status = 'PASS_COMMITTED';
    result.usersPreserved = users.length;
    result.businessRecordsDeleted = names.filter(t => !preserve.has(t)).reduce((n,t) => n + stats[t], 0);
    result.businessRecordsRemaining = 0;
    result.foreignKeysPreserved = foreignKeys.length;
  }
} catch (error) {
  if (transaction) { await db.rollback(); transaction = false; }
  result.status = 'FAILED_ROLLED_BACK';
  result.error = String(error.message).replaceAll(process.env.DATABASE_URL, '[REDACTED]');
  process.exitCode = 1;
} finally {
  await db.end();
  if (execute) {
    result.finishedAt = new Date().toISOString();
    writeFileSync(resultFile, JSON.stringify(result, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ status: result.status, usersPreserved: result.usersPreserved, businessRecordsDeleted: result.businessRecordsDeleted, businessRecordsRemaining: result.businessRecordsRemaining, backup: result.backup?.filename, userAccountsPreserved: result.userAccountsPreserved, error: result.error }));
  }
}
