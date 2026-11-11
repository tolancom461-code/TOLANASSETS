// Original quantity never changes; exclusion and warranty replacement are distinct exits.
export function remainingQuantity(row: {
  quantity: number;
  excludedQuantity?: number | null;
  warrantyReplacedQuantity?: number | null;
  status?: string;
}) {
  if (row.status === "CONVERTED") return 0;
  return (
    row.quantity -
    (row.excludedQuantity || 0) -
    (row.warrantyReplacedQuantity || 0)
  );
}
