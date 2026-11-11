import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import {drizzle} from 'drizzle-orm/mysql2';
import {depreciationReport} from '../server/depreciationReports.ts';
import {depreciationReportExcel} from '../shared/depreciationReportExcel.ts';

// Read-only comparison against the committed report; no inserts, updates or DDL.
const temporary = path.resolve('server/.report-baseline-qa.ts');
const expected = path.join(process.cwd(),'server','.report-baseline-qa.ts');
assert.equal(temporary,expected);
await assert.rejects(fs.access(temporary));
await fs.writeFile(temporary,execFileSync('git',['show','HEAD:server/depreciationReports.ts']));
const pool=mysql.createPool({uri:process.env.DATABASE_URL!,ssl:{minVersion:'TLSv1.2',rejectUnauthorized:true},connectionLimit:10});
try {
 const db=drizzle(pool);
 const {depreciationReport:baseline}=await import(pathToFileURL(temporary).href);
 const comparisons:any[]=[];
 let latest:any;
 const stripRates=(rows:any[])=>rows.map(({depreciationRate,depreciationRateLabel,...row})=>row);
 for(const filters of [
  {from:'2026-01-01',to:'2026-09-30'},
  {from:'2026-05-01',to:'2026-05-31',entityType:'asset' as const},
  {from:'2026-09-15',to:'2026-09-30'},
 ]) {
  const before=performance.now(); const old=await baseline(db,filters); const oldMs=performance.now()-before;
  const after=performance.now(); const current=await depreciationReport(db,{...filters,includeJournalSnapshots:false}); const newMs=performance.now()-after;
  assert.deepEqual(current.total,old.total);
  assert.deepEqual(stripRates(current.rows),old.rows);
  assert.deepEqual(stripRates(current.groups),old.groups);
  for(const key of ['expenses','periodStatus','journalExpense','reconciled','pendingMonths','exceptions'])assert.deepEqual(current[key],old[key],key);
  comparisons.push({filters,oldMs:Math.round(oldMs),newMs:Math.round(newMs),oldBytes:Buffer.byteLength(JSON.stringify(old)),newBytes:Buffer.byteLength(JSON.stringify(current)),rows:current.rows.length,financialValuesUnchanged:true});
  if(!latest)latest=current;
 }
 const dir='qa-results/depreciation-report-improvements';await fs.mkdir(dir,{recursive:true});
 await fs.writeFile(`${dir}/report-sample.xlsx`,await depreciationReportExcel(latest));
 await fs.writeFile(`${dir}/report-data.json`,JSON.stringify(latest));
 await fs.writeFile(`${dir}/verification.json`,JSON.stringify({status:'PASS',databaseWrites:0,comparisons,rateSource:'Approved classification policy effective at report end'},null,2));
 console.log(JSON.stringify({status:'PASS',databaseWrites:0,comparisons}));
}finally{
 await pool.end();
 await fs.unlink(temporary);
}
