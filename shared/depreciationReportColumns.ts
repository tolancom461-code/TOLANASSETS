// Keep screen, print and Excel columns in the same financial order.
export const depreciationReportColumns: string[][] = [
  ["classification", "التصنيف"],
  ["depreciationRateLabel", "نسبة الإهلاك"],
  ["openingCost", "التكلفة أول الفترة"],
  ["additions", "إضافات / نقل قيمة للبديل"],
  ["costAdjustments", "تصحيحات التكلفة"],
  ["removedCost", "تكلفة المستبعد / السابق"],
  ["closingCost", "التكلفة آخر الفترة"],
  ["openingAccum", "المجمع أول الفترة"],
  ["carriedAccum", "مجمع منقول للبديل"],
  ["charge", "إهلاك الفترة"],
  ["accumAdjustments", "تصحيحات المجمع"],
  ["removedAccum", "مجمع المستبعد / السابق"],
  ["closingAccum", "المجمع آخر الفترة"],
  ["closingImpairment", "انخفاض القيمة"],
  ["net", "صافي القيمة الدفترية"],
];

export const depreciationComparisonColumns: string[][] = [
  ["classification", "التصنيف"],
  ["previousCharge", "مصروف الفترة المقارنة"],
  ["currentCharge", "مصروف الفترة الحالية"],
  ["chargeChange", "تغير المصروف"],
  ["previousNet", "صافي الفترة المقارنة"],
  ["currentNet", "صافي الفترة الحالية"],
  ["netChange", "تغير الصافي"],
];
