import { money, amount, type FinancialBatch, type FinancialMovement, type Allocation } from "../shared/depreciation";

// Monetary report balances come from posted journals. Only these end-of-period
// attributes are needed from lifecycle events; do not recalculate every month.
export function reportUnitMetadata(batch: FinancialBatch, movements: FinancialMovement[], to: string) {
  const units = new Map(batch.payload.units.map(unit => [unit, {
    allocation: batch.payload.allocation as Allocation,
    residual: amount(money(batch.payload.unitResidual)),
    disposed: false,
  }]));
  const events = movements.filter(m => m.batchId === batch.id)
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.id - b.id);
  for (const event of events) {
    if (event.effectiveDate < batch.payload.balanceDate && event.payload.units.some(unit => units.has(unit))) {
      throw new Error("حركة تسبق الرصيد المالي الافتتاحي");
    }
    if (event.effectiveDate > to) continue;
    for (const unit of event.payload.units) {
      const state = units.get(unit);
      if (!state || state.disposed) continue;
      if (event.kind === "DISPOSAL" || event.kind === "WARRANTY") state.disposed = true;
      else if (event.kind === "TRANSFER") state.allocation = event.payload.allocation!;
      else if (event.kind === "ESTIMATE" || event.kind === "CORRECTION") state.residual = amount(money(event.payload.unitResidual!));
    }
  }
  return batch.payload.units.map(unit => units.get(unit)!);
}
