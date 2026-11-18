import { useRef, useState } from "react";
import { Check, ChevronsUpDown, Loader2 } from "lucide-react";
import { toast } from "sonner";
import WorkflowConfirmationDialog from "@/components/WorkflowConfirmationDialog";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { trpc } from "@/lib/trpc";
import { openArchiveReportAsync } from "@/lib/archiveReport";

type EmployeeOption = { id: number; fullName: string; fingerprintId: string | null };

function EmployeePicker({ employees, value, label, placeholder = label, disabled, onSelect }: {
  employees: EmployeeOption[];
  value: number | null;
  label: string;
  placeholder?: string;
  disabled: boolean;
  onSelect: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = employees.find(employee => employee.id === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" aria-label={selected ? label + "، " + selected.fullName : label} disabled={disabled}
          className="w-full justify-between text-right">
          <span className="truncate">{selected?.fullName ?? placeholder}{selected?.fingerprintId ? " · " + selected.fingerprintId : ""}</span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent dir="rtl" align="start" className="w-[var(--radix-popover-trigger-width)] min-w-64 max-w-[calc(100vw-2rem)] p-0">
        <Command>
          <CommandInput aria-label={`بحث ${label}`} placeholder="ابحث باسم الموظف أو رقم البصمة…" />
          <CommandList className="max-h-[min(18rem,var(--radix-popover-content-available-height))]">
            <CommandEmpty>لا يوجد موظف مطابق</CommandEmpty>
            {employees.map(employee => (
              <CommandItem key={employee.id} value={String(employee.id)}
                keywords={[employee.fullName, employee.fingerprintId ?? ""]}
                onSelect={() => { onSelect(employee.id); setOpen(false); }}>
                <Check className={employee.id === value ? "size-4 shrink-0" : "size-4 shrink-0 opacity-0"} />
                <span className="min-w-0 flex-1 break-words">{employee.fullName}</span>
                {employee.fingerprintId && <span className="shrink-0 text-xs text-muted-foreground">{employee.fingerprintId}</span>}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

type Review = {
  fromEmployeeId: number;
  snapshot: string;
  recipients: { departmentId: number; toEmployeeId: number }[];
  summary: string;
};

export default function TotalTransferDialog({ onClose, employees, employeesError, onTransferred }: {
  onClose: () => void;
  employees: EmployeeOption[] | undefined;
  employeesError: boolean;
  onTransferred: () => void;
}) {
  const [fromEmployeeId, setFromEmployeeId] = useState<number | null>(null);
  const [recipients, setRecipients] = useState<Partial<Record<number, number>>>({});
  const [review, setReview] = useState<Review | null>(null);
  const executing = useRef(false);
  const utils = trpc.useUtils();
  const preview = trpc.operations.transfers.previewTotal.useQuery(
    { fromEmployeeId: fromEmployeeId ?? 0 },
    { enabled: fromEmployeeId !== null }
  );
  const transfer = trpc.operations.transfers.executeTotal.useMutation();

  const groups = preview.data?.groups ?? [];
  const recordCount = groups.reduce((count, group) => count + group.assetCount + group.custodyCount, 0);
  const recipientOptions = (employees ?? []).filter(employee => employee.id !== fromEmployeeId);
  const canReview = Boolean(
    fromEmployeeId && preview.data && !preview.isFetching && !preview.isError && groups.length &&
    groups.every(group => recipientOptions.some(employee => employee.id === recipients[group.departmentId]))
  );

  function close() {
    if (executing.current) return;
    onClose();
  }

  function reviewTransfer() {
    if (!canReview || !fromEmployeeId || !preview.data) return;
    setReview({
      fromEmployeeId,
      snapshot: preview.data.snapshot,
      recipients: groups.map(group => ({
        departmentId: group.departmentId,
        toEmployeeId: recipients[group.departmentId]!,
      })),
      summary: `${preview.data.employeeName} · ${groups.length} قسم · ${recordCount} سجل`,
    });
  }

  async function execute() {
    if (!review || executing.current) return;
    executing.current = true;
    try {
      const result = await transfer.mutateAsync({
        fromEmployeeId: review.fromEmployeeId,
        snapshot: review.snapshot,
        recipients: review.recipients,
      });
      onTransferred();
      onClose();
      void utils.operations.transfers.previewTotal.invalidate();
      void utils.records.archive.list.invalidate();
      void utils.records.archive.count.invalidate();
      const documentId = result.documentId;
      toast.success(`تم النقل الكلي لعدد ${result.count} سجل، بإجمالي ${result.quantityMoved} وحدة`, {
        action: documentId ? {
          label: "عرض وثيقة النقل",
          onClick: () => {
            void openArchiveReportAsync(() => utils.records.archive.getById.fetch({ id: documentId }))
              .catch(error => toast.error(error instanceof Error ? error.message : "تعذّر فتح وثيقة النقل."));
          },
        } : undefined,
      });
    } catch (error) {
      setReview(null);
      toast.error(error instanceof Error ? error.message : "تعذّر تنفيذ النقل الكلي");
      void preview.refetch();
      void utils.settings.employees.list.invalidate();
    } finally {
      executing.current = false;
    }
  }

  return (
    <>
      <Dialog open onOpenChange={value => { if (!value) close(); }}>
        <DialogContent dir="rtl" className="flex max-h-[90dvh] flex-col sm:max-w-2xl" showCloseButton={!transfer.isPending}>
          <DialogHeader className="shrink-0">
            <DialogTitle>النقل الكلي</DialogTitle>
            <DialogDescription>اختر الموظف الحالي ثم حدّد مستلم الأصول والعُهد لكل قسم.</DialogDescription>
          </DialogHeader>

          <div className="min-h-0 space-y-4 overflow-y-auto px-1">
            <div className="space-y-1.5">
              <p className="text-sm font-medium">الموظف الحالي</p>
              <EmployeePicker
                employees={employees ?? []}
                value={fromEmployeeId}
                label="اختر الموظف الحالي"
                disabled={!employees?.length || transfer.isPending}
                onSelect={id => {
                  if (id === fromEmployeeId) return;
                  setFromEmployeeId(id);
                  setRecipients({});
                }}
              />
              {employeesError && <p role="alert" className="text-sm text-destructive">تعذّر تحميل الموظفين.</p>}
            </div>

            {fromEmployeeId !== null && (preview.isLoading || !employees) && !employeesError && (
              <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> جاري تحميل الأقسام…
              </p>
            )}
            {preview.isError && <p role="alert" className="text-sm text-destructive">{preview.error.message}</p>}
            {preview.data && groups.length === 0 && !preview.isError && (
              <p role="status" className="text-sm text-muted-foreground">لا توجد أصول أو عُهد قابلة للنقل ضمن أقسام الموظف.</p>
            )}
            {preview.data && preview.data.incompleteCount > 0 && (
              <p role="status" className="rounded-md border border-amber-500/50 p-3 text-sm">
                يوجد {preview.data.incompleteCount} سجل يحتاج إلى تصحيح تخصيص الموقع أو القسم قبل إدراجه في النقل الكلي.
              </p>
            )}

            <ul className="space-y-2">
              {groups.map(group => (
                <li key={group.departmentId} className="grid items-center gap-3 rounded-md border p-3 sm:grid-cols-2">
                  <div className="min-w-0 space-y-1">
                    <p className="break-words text-sm font-semibold">{group.departmentName}</p>
                    <p className="break-words text-xs text-muted-foreground">{group.branchName} · {group.locationName}</p>
                    <p className="text-xs text-muted-foreground">{group.assetCount} أصل · {group.custodyCount} عهدة</p>
                  </div>
                  <EmployeePicker
                    employees={recipientOptions}
                    value={recipients[group.departmentId] ?? null}
                    label={`الموظف المستلم لقسم ${group.departmentName} · ${group.branchName} · ${group.locationName}`}
                    placeholder="اختر الموظف المستلم"
                    disabled={!recipientOptions.length || transfer.isPending}
                    onSelect={id => setRecipients(current => ({ ...current, [group.departmentId]: id }))}
                  />
                </li>
              ))}
            </ul>
          </div>

          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={close} disabled={transfer.isPending}>إلغاء</Button>
            <Button onClick={reviewTransfer} disabled={!canReview || transfer.isPending}>تنفيذ النقل الكلي</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <WorkflowConfirmationDialog
        open={review !== null}
        title="تأكيد النقل الكلي"
        description="ستُنقل جميع السجلات المعروضة إلى المستلم المحدد لكل قسم وتُحفظ حركاتها في سجل النقل."
        recordName={review?.summary ?? ""}
        confirmLabel="تأكيد النقل الكلي"
        pending={transfer.isPending}
        onCancel={() => setReview(null)}
        onConfirm={() => void execute()}
      />
    </>
  );
}

