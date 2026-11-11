import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { canApprove, canOperate } from "@shared/roles";
import {
  conversionTarget,
  conversionTypeLabel,
  type ConversionDraft,
} from "@shared/inventoryConversion";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { ArrowLeftRight, Loader2 } from "lucide-react";
import { toast } from "sonner";

type Kind = "asset" | "custody";
export function InventoryConversionLinks({
  entityType,
  entityId,
}: {
  entityType: Kind;
  entityId: number;
}) {
  const { user } = useAuth();
  const { data } = trpc.conversions.links.useQuery(
    { entityType, entityId },
    { enabled: canOperate(user?.role) }
  );
  if (!data?.length) return null;
  return (
    <div className="rounded-lg border p-3 text-xs space-y-2 bg-primary/5">
      {data.map(link => {
        const incoming =
          link.targetType === entityType && link.targetId === entityId;
        const kind = incoming ? link.sourceType : link.targetType,
          id = incoming ? link.sourceId : link.targetId;
        const code = incoming ? link.sourceCode : link.targetCode;
        return (
          <p key={`${link.conversionId}-${link.sourceId}`}>
            {incoming ? "وارد من" : "حُوّل إلى"} {conversionTypeLabel(kind)} —{" "}
            <span dir="ltr">{code}</span> · الكمية {link.quantity}{" "}
            <a
              className="text-primary underline"
              href={`/tracking?type=${kind}&id=${id}&code=${encodeURIComponent(code)}&name=${encodeURIComponent(code)}`}
            >
              عرض تاريخ السجل {incoming ? "السابق" : "الجديد"}
            </a>
          </p>
        );
      })}
    </div>
  );
}

export default function InventoryConversion({
  sourceType,
  selectedIds,
  onClear,
  onComplete,
}: {
  sourceType: Kind;
  selectedIds: number[];
  onClear: () => void;
  onComplete: () => Promise<void>;
}) {
  const { user } = useAuth(),
    approver = canApprove(user?.role),
    operator = canOperate(user?.role);
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false),
    [pendingId, setPendingId] = useState<number | null>(null);
  const [allocationMode, setAllocationMode] = useState<"KEEP" | "CHANGE">(
    "KEEP"
  );
  const [employeeMode, setEmployeeMode] = useState<"KEEP" | "CHANGE">("KEEP");
  const [locationId, setLocationId] = useState(""),
    [branchId, setBranchId] = useState(""),
    [departmentId, setDepartmentId] = useState(""),
    [employeeId, setEmployeeId] = useState("");
  const [notes, setNotes] = useState(""),
    [serialText, setSerialText] = useState<Record<string, string>>({});
  const [review, setReview] = useState<any>(null),
    [reviewInput, setReviewInput] = useState("");
  const [requestKey, setRequestKey] = useState("");
  const input: ConversionDraft = {
    sourceType,
    ids: selectedIds,
    allocationMode,
    employeeMode,
    notes,
    serials: Object.fromEntries(
      Object.entries(serialText).map(([id, text]) => [
        id,
        text
          .split("\n")
          .map(s => s.trim())
          .filter(Boolean),
      ])
    ),
    ...(allocationMode === "CHANGE"
      ? {
          locationId: Number(locationId) || undefined,
          branchId: Number(branchId) || undefined,
          departmentId: Number(departmentId) || undefined,
        }
      : {}),
    ...(employeeMode === "CHANGE"
      ? { employeeId: Number(employeeId) || undefined }
      : {}),
  };
  const signature = JSON.stringify(input);
  const list = trpc.conversions.list.useQuery(
    { sourceType },
    { enabled: operator }
  );
  const detail = trpc.conversions.details.useQuery(
    { id: pendingId! },
    { enabled: pendingId !== null && operator }
  );
  const locs = trpc.settings.locations.list.useQuery(undefined, {
    enabled: open,
  });
  const branches = trpc.settings.branches.list.useQuery(undefined, {
    enabled: open,
  });
  const departments = trpc.settings.departments.list.useQuery(undefined, {
    enabled: open,
  });
  const employees = trpc.settings.employees.list.useQuery(undefined, {
    enabled: open,
  });
  const preview = trpc.conversions.preview.useMutation(),
    submit = trpc.conversions.submit.useMutation(),
    execute = trpc.conversions.execute.useMutation();
  const approve = trpc.conversions.approve.useMutation(),
    cancel = trpc.conversions.cancel.useMutation();
  const busy =
    preview.isPending ||
    submit.isPending ||
    execute.isPending ||
    approve.isPending ||
    cancel.isPending;
  const refresh = async () => {
    await Promise.all([
      utils.conversions.invalidate(),
      utils.inventory.invalidate(),
      utils.records.invalidate(),
      utils.depreciation.invalidate(),
      utils.settings.locations.invalidate(),
    ]);
    await onComplete();
  };
  const start = () => {
    setAllocationMode("KEEP");
    setEmployeeMode("KEEP");
    setLocationId("");
    setBranchId("");
    setDepartmentId("");
    setEmployeeId("");
    setNotes("");
    setSerialText({});
    setReview(null);
    setReviewInput("");
    setRequestKey(crypto.randomUUID());
    setOpen(true);
  };
  const reviewNow = async () => {
    try {
      const result = await preview.mutateAsync(input);
      setReview(result);
      setReviewInput(signature);
    } catch (e: any) {
      toast.error(e.message);
    }
  };
  const finish = async () => {
    if (!review?.valid || signature !== reviewInput || busy) return;
    try {
      const result = await (approver ? execute : submit).mutateAsync({
        request: input,
        previewHash: review.previewHash,
        requestKey,
      });
      setOpen(false);
      onClear();
      await refresh();
      toast.success(
        result.status === "EXECUTED"
          ? `تم تحويل ${result.results.length} سجل وتوليد الرموز الجديدة`
          : `تم حفظ طلب التحويل #${result.id} بانتظار اعتماد المختص`
      );
    } catch (e: any) {
      toast.error(e.message);
    }
  };
  const handlePending = async (action: "approve" | "cancel") => {
    const record = detail.data?.request;
    if (!record || busy) return;
    try {
      await (action === "approve" ? approve : cancel).mutateAsync({
        id: record.id,
        expectedVersion: record.version,
      });
      setPendingId(null);
      await refresh();
      toast.success(
        action === "approve"
          ? "تم اعتماد وتنفيذ التحويل"
          : "تم إلغاء طلب التحويل"
      );
    } catch (e: any) {
      toast.error(e.message);
    }
  };
  if (!operator) return null;
  const selectClass =
    "w-full h-10 rounded-md border border-input bg-background px-3 text-sm";
  const rows = review?.rows || [];
  const pendingPayload = detail.data?.request.payload as
    ConversionDraft | undefined;
  return (
    <div className="space-y-3 mb-4">
      {selectedIds.length > 0 && (
        <div className="flex justify-between items-center flex-wrap gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
          <span className="text-sm">
            تم تحديد {selectedIds.length} سجل · التحديد الجماعي يشمل الصفحة
            الحالية
          </span>
          <div className="flex gap-2">
            <Button size="sm" onClick={start}>
              <ArrowLeftRight className="w-4 h-4 ml-1" />
              تحويل المحدد
            </Button>
            <Button variant="ghost" size="sm" onClick={onClear}>
              إلغاء التحديد
            </Button>
          </div>
        </div>
      )}
      {!!list.data?.length && (
        <details className="rounded-lg border p-3">
          <summary className="cursor-pointer text-sm font-medium">
            طلبات التحويل بانتظار الاعتماد ({list.data.length})
          </summary>
          <div className="mt-3 space-y-2">
            {list.data.map(r => (
              <div
                key={r.id}
                className="flex justify-between items-center gap-2 text-xs border-t py-2"
              >
                <span>
                  طلب #{r.id} · أعدّه {r.createdByName || r.createdBy} · إلى{" "}
                  {conversionTypeLabel(conversionTarget(sourceType))}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setPendingId(r.id)}
                >
                  عرض الطلب
                </Button>
              </div>
            ))}
          </div>
        </details>
      )}
      {list.error && (
        <p role="alert" className="text-xs text-destructive">
          تعذر تحميل طلبات التحويل: {list.error.message}
        </p>
      )}
      <Dialog
        open={open}
        onOpenChange={value => {
          if (!busy) setOpen(value);
        }}
      >
        <DialogContent
          dir="rtl"
          className="sm:max-w-3xl max-h-[90vh] overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle>
              تحويل من {conversionTypeLabel(sourceType)} إلى{" "}
              {conversionTypeLabel(conversionTarget(sourceType))}
            </DialogTitle>
            <DialogDescription>
              يُحوّل المتبقي الفعلي فقط. يُحفظ السجل السابق وتاريخه ويُولد رمز
              جديد للوجهة عند التنفيذ. السجلات المرتبطة بالإهلاك أو بعمليات
              معلقة لا تُحوّل.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-xs space-y-1">
              <span>تخصيص الوجهة</span>
              <select
                className={selectClass}
                value={allocationMode}
                onChange={e => setAllocationMode(e.target.value as any)}
                disabled={busy}
              >
                <option value="KEEP">إبقاء موقع وفرع وقسم كل صنف</option>
                <option value="CHANGE">اختيار موقع وفرع وقسم جديد</option>
              </select>
            </label>
            <label className="text-xs space-y-1">
              <span>الموظف المستلم</span>
              <select
                className={selectClass}
                value={employeeMode}
                onChange={e => setEmployeeMode(e.target.value as any)}
                disabled={busy}
              >
                <option value="KEEP">إبقاء الموظف الحالي لكل صنف</option>
                <option value="CHANGE">تغيير الموظف للمحدد</option>
              </select>
            </label>
            {allocationMode === "CHANGE" && (
              <>
                <label className="text-xs space-y-1">
                  <span>الموقع الجديد</span>
                  <select
                    className={selectClass}
                    value={locationId}
                    disabled={busy}
                    onChange={e => {
                      setLocationId(e.target.value);
                      setBranchId("");
                      setDepartmentId("");
                    }}
                  >
                    <option value="">اختر الموقع</option>
                    {locs.data?.map(r => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs space-y-1">
                  <span>الفرع الجديد</span>
                  <select
                    className={selectClass}
                    value={branchId}
                    disabled={busy || !locationId}
                    onChange={e => {
                      setBranchId(e.target.value);
                      setDepartmentId("");
                    }}
                  >
                    <option value="">اختر الفرع</option>
                    {branches.data
                      ?.filter(r => r.locationId === Number(locationId))
                      .map(r => (
                        <option key={r.id} value={r.id}>
                          {r.name}{r.code ? ` (${r.code})` : ""}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="text-xs space-y-1">
                  <span>القسم الجديد</span>
                  <select
                    className={selectClass}
                    value={departmentId}
                    disabled={busy || !branchId}
                    onChange={e => setDepartmentId(e.target.value)}
                  >
                    <option value="">اختر القسم</option>
                    {departments.data
                      ?.filter(r => r.branchId === Number(branchId))
                      .map(r => (
                        <option key={r.id} value={r.id}>
                          {r.name}{r.code ? ` (${r.code})` : ""}
                        </option>
                      ))}
                  </select>
                </label>
              </>
            )}
            {employeeMode === "CHANGE" && (
              <label className="text-xs space-y-1">
                <span>الموظف الجديد</span>
                <select
                  className={selectClass}
                  value={employeeId}
                  disabled={busy}
                  onChange={e => setEmployeeId(e.target.value)}
                >
                  <option value="">اختر الموظف</option>
                  {employees.data?.map(r => (
                    <option key={r.id} value={r.id}>
                      {r.fullName}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <label className="text-xs space-y-1">
            <span>سبب التحويل</span>
            <textarea
              className="w-full rounded-md border border-input bg-background p-2 text-sm"
              maxLength={2000}
              value={notes}
              disabled={busy}
              onChange={e => setNotes(e.target.value)}
            />
          </label>
          <Button variant="outline" onClick={reviewNow} disabled={busy}>
            {preview.isPending && (
              <Loader2 className="w-4 h-4 animate-spin ml-2" />
            )}
            مراجعة التحويل
          </Button>
          {review && (
            <div className="space-y-3">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-muted">
                    <tr>
                      <th className="p-2">الرمز / الصنف</th>
                      <th>المتبقي المحوّل</th>
                      <th>تخصيص الوجهة</th>
                      <th>المراجعة</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r: any) => (
                      <tr key={r.id} className="border-b">
                        <td className="p-2">
                          <span dir="ltr">{r.code}</span>
                          <br />
                          {r.name}
                        </td>
                        <td className="p-2 text-center">{r.quantity}</td>
                        <td className="p-2">
                          {r.destination.locationName} /{" "}
                          {r.destination.branchName} /{" "}
                          {r.destination.departmentName}
                          <br />
                          الموظف: {r.destination.employeeName}
                          <br />
                          <span className="text-muted-foreground">
                            الرمز الجديد يولد عند التنفيذ ببادئة{" "}
                            {r.destination.prefix}
                          </span>
                        </td>
                        <td className="p-2">
                          {r.errors.length ? (
                            <ul className="text-destructive">
                              {r.errors.map((error: string) => (
                                <li key={error}>{error}</li>
                              ))}
                            </ul>
                          ) : (
                            "جاهز"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows
                .filter((r: any) => r.requiresSerialReview)
                .map((r: any) => (
                  <label key={r.id} className="block text-xs space-y-1">
                    <span>
                      معرفات الوحدات المتبقية للصنف {r.code} — معرف واحد في كل
                      سطر، ثم أعد المراجعة
                    </span>
                    <p className="text-muted-foreground">
                      المعرفات المتاحة: {r.candidates.join("، ")}
                    </p>
                    <textarea
                      className="w-full rounded-md border p-2 bg-background text-sm"
                      disabled={busy}
                      value={serialText[String(r.id)] || ""}
                      onChange={e =>
                        setSerialText(previous => ({
                          ...previous,
                          [String(r.id)]: e.target.value,
                        }))
                      }
                    />
                  </label>
                ))}
              {signature !== reviewInput && (
                <p className="text-xs text-amber-700">
                  تغيرت الاختيارات؛ اضغط «مراجعة التحويل» مجددًا.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                التحويل المنفذ تاريخي ولا يُعدل أو يُحذف مباشرة. إذا تعذر تحويل
                أحد الأصناف فلن يُحوّل أي صنف من الدفعة.
              </p>
              <Button
                onClick={finish}
                disabled={busy || !review.valid || signature !== reviewInput}
              >
                {(execute.isPending || submit.isPending) && (
                  <Loader2 className="w-4 h-4 animate-spin ml-2" />
                )}
                {approver
                  ? "تأكيد واعتماد وتنفيذ التحويل"
                  : "حفظ وإرسال طلب التحويل للاعتماد"}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={pendingId !== null}
        onOpenChange={value => {
          if (!value && !busy) setPendingId(null);
        }}
      >
        <DialogContent
          dir="rtl"
          className="sm:max-w-2xl max-h-[90vh] overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle>طلب التحويل #{pendingId}</DialogTitle>
            <DialogDescription>
              يُعاد التحقق من الحالة والكمية والارتباطات وقت الاعتماد.
            </DialogDescription>
          </DialogHeader>
          {detail.isFetching ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : detail.error ? (
            <p role="alert" className="text-destructive">
              {detail.error.message}
            </p>
          ) : (
            detail.data && (
              <div className="space-y-3 text-sm">
                <p>
                  أعدّه {detail.data.request.createdByName} · إلى{" "}
                  {conversionTypeLabel(conversionTarget(sourceType))}
                </p>
                <p>
                  الموظف:{" "}
                  {pendingPayload?.employeeMode === "KEEP"
                    ? "إبقاء موظف كل صنف"
                    : "تغيير الموظف"}
                </p>
                <p>السبب: {pendingPayload?.notes}</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr>
                        <th className="p-2">الرمز / الصنف</th>
                        <th>الكمية</th>
                        <th>الوجهة</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.data.items.map(i => {
                        const s = i.sourceSnapshot as any,
                          d = i.targetSnapshot as any;
                        return (
                          <tr key={i.id} className="border-b">
                            <td className="p-2">
                              {s.assetCode || s.code}
                              <br />
                              {s.assetName || s.name}
                            </td>
                            <td className="p-2 text-center">{i.quantity}</td>
                            <td className="p-2">
                              {d.locationName} / {d.branchName} /{" "}
                              {d.departmentName}
                              <br />
                              {d.employeeName}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="flex gap-2">
                  {approver && (
                    <Button
                      disabled={busy}
                      onClick={() => handlePending("approve")}
                    >
                      تأكيد اعتماد وتنفيذ التحويل
                    </Button>
                  )}
                  {(approver || detail.data.request.createdBy === user?.id) && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => handlePending("cancel")}
                    >
                      إلغاء الطلب
                    </Button>
                  )}
                </div>
              </div>
            )
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
