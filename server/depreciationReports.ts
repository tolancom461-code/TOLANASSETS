import { depreciationJournals, depreciationPeriods } from "../drizzle/schema";
import { sql, lte } from "drizzle-orm";
import { financialReportState, jsonData } from "./depreciationStore";
import { reportUnitMetadata } from "./depreciationReportMetadata";
import {
  money,
  amount,
  splitCents,
  periodTitle,
  annualRate,
  policyPayload, monthStart, nextMonth,
} from "../shared/depreciation";

export type ReportFilters = {
  from: string;
  to: string;
  classificationId?: number;
  costCenter?: string;
  location?: string;
  branch?: string;
  department?: string;
  entityType?: "asset" | "custody";
  search?: string;
  includeJournalSnapshots?: boolean;
};
// Approved ledger movements only. Custom mid-month dates do not manufacture daily posted journals.
export async function depreciationReport(db: any, input: ReportFilters) {
  const [state, journalRows, periods] = await Promise.all([
    financialReportState(db),
    input.includeJournalSnapshots === false
      ? db.select({ id: depreciationJournals.id, code: depreciationJournals.code, kind: depreciationJournals.kind, effectiveDate: depreciationJournals.effectiveDate,
          snapshot: sql`JSON_OBJECT('details', JSON_EXTRACT(${depreciationJournals.snapshot}, '$.details'))` }).from(depreciationJournals).where(lte(depreciationJournals.effectiveDate, input.to))
      : db.select().from(depreciationJournals),
    // Reports read posted journal details, not the repeated unit snapshots in
    // every monthly calculation. Keep status, total and exceptions only.
    db.select({
      month: depreciationPeriods.month,
      status: depreciationPeriods.status,
      snapshot: sql`JSON_OBJECT('total', JSON_EXTRACT(${depreciationPeriods.snapshot}, '$.total'), 'exceptions', JSON_EXTRACT(${depreciationPeriods.snapshot}, '$.exceptions'))`,
    }).from(depreciationPeriods),
  ]);
  const policy=state.policies.filter((r:any)=>r.status==="APPROVED"&&r.effectiveDate<=input.to).sort((a:any,b:any)=>b.effectiveDate.localeCompare(a.effectiveDate))[0];
  const setup=policy?policyPayload.parse(jsonData(policy.payload)):null;
  const reportRules = new Map(setup?.rules.map(rule => [rule.classificationId, rule]) ?? []);
  const journals = journalRows.filter((j: any) => j.effectiveDate <= input.to);
  const depreciation = journals
    .filter((j: any) => ["DEPRECIATION", "REVERSAL"].includes(j.kind))
    .flatMap((j: any) => {
      const p = jsonData(j.snapshot);
      return (p.details ?? []).map((l: any) => ({
        ...l,
        effectiveDate: j.effectiveDate,
        sign: j.kind === "REVERSAL" ? -1n : 1n,
      }));
    });
  const disposals = journals
    .filter((j: any) => ["DISPOSAL", "WARRANTY"].includes(j.kind))
    .flatMap((j: any) => {
      const p = jsonData(j.snapshot);
      return p.details.units.map((u: any) => ({
        ...u,
        batchId: p.details.batch.id,
        effectiveDate: j.effectiveDate,
        kind: j.kind,
      }));
    });
  const rows: any[] = [];
  const signedMoney=(v:string)=>v.startsWith("-")?-money(v.slice(1)):money(v);
  const corrections=journals.filter((j:any)=>j.kind==="CORRECTION").flatMap((j:any)=>jsonData(j.snapshot).details.map((d:any)=>({...d,effectiveDate:j.effectiveDate})));
  const indexUnits = (records: any[]) => {
    const index = new Map<string, any[]>();
    for (const row of records) {
      const key = `${row.batchId}:${row.unit}`;
      const entries = index.get(key) ?? [];
      entries.push(row); index.set(key, entries);
    }
    return index;
  };
  const depByUnit = indexUnits(depreciation), disposalsByUnit = indexUnits(disposals), correctionsByUnit = indexUnits(corrections);
  const movementsByBatch = new Map<number, typeof state.movements>();
  for (const movement of state.movements) {
    const entries = movementsByBatch.get(movement.batchId) ?? [];
    entries.push(movement); movementsByBatch.set(movement.batchId, entries);
  }
  for (const batch of state.batches) {
    const p = batch.payload;
    if (p.balanceDate > input.to) continue;
    if ((input.classificationId && batch.classificationId !== input.classificationId) || (input.entityType && batch.entityType !== input.entityType)) continue;
    const closing = reportUnitMetadata(batch, movementsByBatch.get(batch.id) ?? [], input.to);
    const rateRule = reportRules.get(batch.classificationId);
    const depreciationRate = rateRule?.treatment === "DEPRECIABLE" ? annualRate(rateRule.lifeMonths) : null;
    const depreciationRateLabel = depreciationRate === null ? (rateRule ? "غير قابل للإهلاك" : "غير مهيأ") : `${Number(depreciationRate)}%`;
    for (let index = 0; index < p.units.length; index++) {
      const unit = p.units[index],
        allocation = closing[index].allocation;
      if (
        (input.classificationId &&
          batch.classificationId !== input.classificationId) ||
        (input.entityType && batch.entityType !== input.entityType) ||
        (input.costCenter && allocation.costCenter !== input.costCenter) ||
        (input.location && allocation.location !== input.location) ||
        (input.branch && allocation.branch !== input.branch) ||
        (input.department && allocation.department !== input.department) ||
        (input.search &&
          !`${batch.identity.code} ${batch.identity.name} ${unit}`
            .toLowerCase()
            .includes(input.search.toLowerCase()))
      )
        continue;
      const key = `${batch.id}:${unit}`;
      const unitDep = depByUnit.get(key) ?? [], unitDisposals = disposalsByUnit.get(key) ?? [];
      const sum = (data: any[], key: string, predicate: (l: any) => boolean): bigint =>
        data
          .filter(predicate)
          .reduce(
            (n: bigint, l: any) => n + money(l[key]) * (l.sign ?? 1n),
            0n
          );
      const initialCost = money(p.unitCost),
        initialAccum = splitCents(
          money(p.openingAccumulated),
          p.quantity,
          index
        ),
        initialImpairment = splitCents(
          money(p.openingImpairment)+money(p.openingAccumulated),
          p.quantity,
          index
        )-initialAccum;
      const before = (l: any) => l.effectiveDate < input.from,
        inside = (l: any) => l.effectiveDate >= input.from;
      const existsBefore = p.balanceDate < input.from || (p.balanceDate === input.from && p.recognitionDate < p.balanceDate && !p.sourceMovementId);
      const changes=correctionsByUnit.get(key) ?? [];
      const correctionSum=(key:string,predicate:(l:any)=>boolean):bigint=>changes.filter(predicate).reduce((n:bigint,d:any)=>n+signedMoney(d[key]),0n);
      const costAdjustments=correctionSum("costDelta",inside),accumAdjustments=correctionSum("accumDelta",inside),impairmentAdjustments=correctionSum("impairmentDelta",inside);
      const openingCost =
          (existsBefore ? initialCost : 0n) -
          sum(unitDisposals, "cost", before) + correctionSum("costDelta",before),
        additions = !existsBefore ? initialCost : 0n,
        removedCost = sum(unitDisposals, "cost", inside),
        closingCost = openingCost + additions - removedCost + costAdjustments;
      const openingAccum =
          (existsBefore ? initialAccum : 0n) +
          sum(unitDep, "debit", before) -
          sum(unitDisposals, "accumulated", before) + correctionSum("accumDelta",before),
        carriedAccum = !existsBefore ? initialAccum : 0n,
        charge = sum(unitDep, "debit", inside),
        removedAccum = sum(unitDisposals, "accumulated", inside),
        closingAccum = openingAccum + carriedAccum + charge - removedAccum + accumAdjustments;
      const openingImpairment =
          (existsBefore ? initialImpairment : 0n) -
          sum(unitDisposals, "impairment", before) + correctionSum("impairmentDelta",before),
        carriedImpairment = !existsBefore ? initialImpairment : 0n,
        removedImpairment = sum(unitDisposals, "impairment", inside),
        closingImpairment =
          openingImpairment + carriedImpairment - removedImpairment + impairmentAdjustments;
      rows.push({
        batchId: batch.id,
        entityType: batch.entityType,
        entityId: batch.entityId,
        ...batch.identity,
        classificationId: batch.classificationId,
        depreciationRate, depreciationRateLabel,
        unit,
        allocation,
        lifeMonths: p.lifeMonths,
        availableForUseDate: p.availableForUseDate,
        openingCost: amount(openingCost),
        additions: amount(additions),
        costAdjustments: amount(costAdjustments), accumAdjustments: amount(accumAdjustments), impairmentAdjustments: amount(impairmentAdjustments),
        removedCost: amount(removedCost),
        closingCost: amount(closingCost),
        openingAccum: amount(openingAccum),
        carriedAccum: amount(carriedAccum),
        charge: amount(charge),
        removedAccum: amount(removedAccum),
        closingAccum: amount(closingAccum),
        openingImpairment: amount(openingImpairment),
        carriedImpairment: amount(carriedImpairment),
        removedImpairment: amount(removedImpairment),
        closingImpairment: amount(closingImpairment),
        net: amount(closingCost - closingAccum - closingImpairment),
        fullyDepreciated:
          batch.rule.treatment==="DEPRECIABLE" && !closing[index].disposed &&
          closingCost-closingAccum-closingImpairment <= money(closing[index].residual),
        disposed: closing[index].disposed,
      });
    }
  }
  const keys = [
    "costAdjustments", "accumAdjustments", "impairmentAdjustments",
    "openingCost",
    "additions",
    "removedCost",
    "closingCost",
    "openingAccum",
    "carriedAccum",
    "charge",
    "removedAccum",
    "closingAccum",
    "openingImpairment",
    "carriedImpairment",
    "removedImpairment",
    "closingImpairment",
    "net",
  ] as const;
  const signed = (v: string) =>
    v.startsWith("-") ? -money(v.slice(1)) : money(v);
  const totals = (data: any[]) =>
    Object.fromEntries(
      keys.map(key => [
        key,
        amount(data.reduce((n: bigint, r: any) => n + signed(r[key]), 0n)),
      ])
    );
  const groups = [...new Set(rows.map(r => r.classificationId))].map(id => ({
    classificationId: id,
    classification: rows.find(r => r.classificationId === id).classification,
    depreciationRate: rows.find(r => r.classificationId === id).depreciationRate,
    depreciationRateLabel: rows.find(r => r.classificationId === id).depreciationRateLabel,
    ...totals(rows.filter(r => r.classificationId === id)),
  }));
  const expenseGroups = new Map<string, any>();
  for (const line of depreciation.filter(
    (l: any) => l.effectiveDate >= input.from
  )) {
    if (
      (input.classificationId &&
        line.classificationId !== input.classificationId) ||
      (input.entityType && line.entityType !== input.entityType) ||
      (input.costCenter && line.allocation.costCenter !== input.costCenter) ||
      (input.location && line.allocation.location !== input.location) ||
      (input.branch && line.allocation.branch !== input.branch) ||
      (input.department && line.allocation.department !== input.department) ||
      (input.search &&
        !`${line.code} ${line.name} ${line.unit}`
          .toLowerCase()
          .includes(input.search.toLowerCase()))
    )
      continue;
    const key = JSON.stringify([line.classification, line.allocation]),
      entry = expenseGroups.get(key) ?? {
        classification: line.classification,
        ...line.allocation,
        value: 0n,
      };
    entry.value += money(line.debit) * line.sign;
    expenseGroups.set(key, entry);
  }
  const storedPeriodStatus = periods
    .filter(
      (p: any) =>
        p.month >= input.from.slice(0, 7) && p.month <= input.to.slice(0, 7)
    )
    .map((p: any) => ({
      month: p.month,
      status: p.status,
      total: jsonData(p.snapshot).total,
    }));
  const periodStatus:Array<{month:string;status:string;total:string}>=[];
  if(setup)for(let date=monthStart(input.from)>setup.openingDate?monthStart(input.from):setup.openingDate;date.slice(0,7)<=input.to.slice(0,7);date=nextMonth(date))periodStatus.push(storedPeriodStatus.find((p:any)=>p.month===date.slice(0,7))??{month:date.slice(0,7),status:"NOT_CALCULATED",total:"0.00"});
  const total = totals(rows),
    journalExpense = amount(
      depreciation
        .filter((l: any) => l.effectiveDate >= input.from)
        .reduce((n: bigint, l: any) => n + money(l.debit) * l.sign, 0n)
    );
  return {
    organizationName:setup?.organizationName??"",currency:setup?.currency??"",
    pendingMonths:periodStatus.filter(p=>!["APPROVED","CLOSED"].includes(p.status)).map(p=>p.month),
    title: periodTitle("تقرير حركة الأصول ومجمع الإهلاك", input.from, input.to),
    from: input.from,
    to: input.to,
    basis:
      "الحركات المالية المعتمدة بتاريخ القيد؛ لا يشمل احتساباً تقديرياً لأجزاء الأشهر غير المعتمدة",
    rateBasis: "نسبة الإهلاك السنوية من سياسة التصنيف المعتمدة السارية في نهاية الفترة؛ قد يختلف العمر المثبت في الملف المالي للأصل عنها.",
    rows,
    groups,
    total,
    expenses: [...expenseGroups.values()].map(g => ({
      ...g,
      value: amount(g.value),
    })),
    periodStatus,
    journalExpense,
    unfiltered:
      !input.classificationId &&
      !input.entityType &&
      !input.costCenter &&
      !input.location &&
      !input.branch &&
      !input.department &&
      !input.search,
    reconciled: total.charge === journalExpense,
    exceptions: periods
      .filter((p: any) => !["APPROVED", "CLOSED"].includes(p.status))
      .flatMap((p: any) => jsonData(p.snapshot).exceptions ?? []),
    journals: input.includeJournalSnapshots === false ? [] : journalRows.filter(
      (j: any) => j.effectiveDate >= input.from && j.effectiveDate <= input.to
    ),
  };
}
