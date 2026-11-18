export const CLEARANCE_REASONS = ["خروج وعودة", "إجازة داخلية", "خروج نهائي", "انتهاء عمل"] as const;

export function isPermanentClearance(reason?: string | null) {
  return reason === "خروج نهائي" || reason === "انتهاء عمل";
}

