import { z } from "zod";

export const conversionDraft = z
  .object({
    sourceType: z.enum(["asset", "custody"]),
    ids: z
      .array(z.number().int().positive())
      .min(1)
      .max(50)
      .refine(ids => new Set(ids).size === ids.length, "السجل مكرر في التحديد"),
    allocationMode: z.enum(["KEEP", "CHANGE"]).default("KEEP"),
    locationId: z.number().int().positive().optional(),
    branchId: z.number().int().positive().optional(),
    departmentId: z.number().int().positive().optional(),
    employeeMode: z.enum(["KEEP", "CHANGE"]).default("KEEP"),
    employeeId: z.number().int().positive().optional(),
    serials: z
      .record(
        z.string().regex(/^\d+$/),
        z.array(z.string().trim().min(1).max(200)).max(10000)
      )
      .default({}),
    notes: z
      .string()
      .trim()
      .min(3, "اكتب سبب التحويل (3 أحرف على الأقل)")
      .max(2000),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (
      p.allocationMode === "CHANGE" &&
      (!p.locationId || !p.branchId || !p.departmentId)
    )
      ctx.addIssue({ code: "custom", message: "حدد موقع وفرع وقسم الوجهة" });
    if (p.employeeMode === "CHANGE" && !p.employeeId)
      ctx.addIssue({ code: "custom", message: "اختر الموظف الجديد" });
    if (Object.keys(p.serials).some(id => !p.ids.includes(Number(id))))
      ctx.addIssue({
        code: "custom",
        message: "معرفات الوحدات لا تخص السجلات المحددة",
      });
  });
export const conversionExecution = z
  .object({
    request: conversionDraft,
    previewHash: z.string().regex(/^[a-f0-9]{64}$/),
    requestKey: z.string().uuid(),
  })
  .strict();
export type ConversionDraft = z.infer<typeof conversionDraft>;
export const conversionTypeLabel = (type: string) =>
  type === "asset" ? "الأصول" : "العهد";
export const conversionTarget = (type: "asset" | "custody") =>
  type === "asset" ? ("custody" as const) : ("asset" as const);
export function canSelectConversion(row: {
  status: string;
  quantity: number;
  excludedQuantity?: number | null;
  warrantyReplacedQuantity?: number | null;
}) {
  return (
    row.status === "ACTIVE" &&
    row.quantity -
      (row.excludedQuantity || 0) -
      (row.warrantyReplacedQuantity || 0) >
      0
  );
}
