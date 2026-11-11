// Independent read-only verification after the authorized cleanup commits.
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { readFileSync, writeFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
const root = 'qa-results/client-handover-2026-10-14';
const cleanup = JSON.parse(readFileSync(`${root}/cleanup-result.json`, 'utf8'));
if (cleanup.status !== 'PASS_COMMITTED') throw Error('No committed cleanup to verify');
const backupHash = createHash('sha256'); for await (const chunk of createReadStream(cleanup.backup.filename)) backupHash.update(chunk);
if (backupHash.digest('hex') !== cleanup.backup.sha256) throw Error('Backup hash mismatch');
let backup;
const savedUsers = [];
for await (const line of createInterface({ input: createReadStream(cleanup.backup.filename).pipe(createGunzip()), crlfDelay: Infinity })) {
  const entry = JSON.parse(line);
  if (entry.type === 'manifest') backup = entry;
  else if (entry.table === 'users') savedUsers.push(entry.row);
}
backup.tables = { users: savedUsers };
const serialize = value => JSON.stringify(value, (_k,v) => typeof v === 'bigint' ? v.toString() : v);
const preserve = new Set(['users', '__drizzle_migrations', 'depreciation_control']);
const pool = mysql.createPool({ uri: process.env.DATABASE_URL, connectionLimit: 4, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true, ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true } });
try {
  const [meta] = await pool.query("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME");
  if (serialize(meta.map(t => t.name)) !== serialize(backup.schema.tableNames)) throw Error('Table structure changed');
  const tables = await Promise.all(meta.map(async ({name}) => {
    if (!/^[A-Za-z0-9_]+$/.test(name)) throw Error('Unexpected table');
    const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM ${mysql.escapeId(name)}`);
    const count = Number(rows[0].n), expected = preserve.has(name) ? backup.stats[name] : 0;
    if (count !== expected) throw Error('Count verification failed: ' + name);
    return { table: name, count, expected };
  }));
  const [users] = await pool.query('SELECT * FROM users ORDER BY id');
  const keys = backup.schema.columns.users.map(c => c.name).filter(k => !['employeeId','updatedAt'].includes(k));
  const usersPreserved = users.length === backup.tables.users.length && users.every(u => {
    const old = backup.tables.users.find(r => r.id === u.id);
    return old && u.employeeId === null && keys.every(k => serialize(u[k]) === serialize(old[k]));
  });
  if (!usersPreserved) throw Error('User preservation verification failed');
  const [control] = await pool.query('SELECT revision FROM depreciation_control WHERE id=1');
  if (Number(control[0]?.revision) !== 0) throw Error('Control metadata mismatch');
  const result = { status: 'PASS', verifiedAt: new Date().toISOString(), databaseWrites: 0, tables, usersPreserved: users.length, credentialsRolesAndUserMetadataPreserved: true, businessRecordsRemaining: 0, backupHashVerified: true };
  writeFileSync(`${root}/independent-verification.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ status: result.status, tablesVerified: tables.length, usersPreserved: users.length, credentialsRolesAndUserMetadataPreserved: true, businessRecordsRemaining: 0, databaseWrites: 0 }));
} finally { await pool.end(); }
