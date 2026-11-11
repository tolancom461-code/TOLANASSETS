import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FileSpreadsheet,
  Filter,
  Loader2,
  Printer,
  RotateCcw,
} from "lucide-react";
import { toast } from "sonner";
import {
  formatSummaryMoney,
  summaryBasis,
  summaryColumns,
  summaryGroups,
  summaryTitle,
  summaryTypes,
  type InventorySummaryInput,
  type SummaryRow,
} from "@shared/inventorySummary";
import {
  downloadInventorySummary,
  inventorySummaryPrint,
} from "@/lib/inventorySummaryExport";

type Group = InventorySummaryInput["groupBy"];
const filterFields = [
  ["location", "locationId", "الموقع", "جميع المواقع"],
  ["branch", "branchId", "الفرع", "جميع الفروع"],
  ["department", "departmentId", "القسم", "جميع الأقسام"],
  ["employee", "employeeId", "الموظف", "جميع الموظفين"],
  ["classification", "classificationId", "التصنيف", "جميع التصنيفات"],
] as const;
type Filters = Record<(typeof filterFields)[number][1], string>;
const emptyFilters = (): Filters => ({
  locationId: "all",
  branchId: "all",
  departmentId: "all",
  employeeId: "all",
  classificationId: "all",
});
function Picker({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs font-medium">
        {label}
      </label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(option => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export default function InventorySummaryReport({
  active,
}: {
  active: boolean;
}) {
  const [groupBy, setGroupBy] = useState<Group>("department");
  const [type, setType] = useState<InventorySummaryInput["type"]>("all");
  const [filters, setFilters] = useState(emptyFilters);
  const [exporting, setExporting] = useState(false);
  const input: InventorySummaryInput = { groupBy, type };
  filterFields.forEach(([, key]) => {
    if (filters[key] !== "all") input[key] = Number(filters[key]);
  });
  const options = trpc.records.reports.summaryOptions.useQuery(undefined, {
    enabled: active,
    staleTime: 30_000,
  });
  const query = trpc.records.reports.summary.useQuery(input, {
    enabled: active,
  });
  const report = query.data;
  const columns = summaryColumns({ groupBy, type });
  const sections = columns.reduce<Array<{ name: string; count: number }>>(
    (list, col) => {
      const last = list.at(-1);
      if (last?.name === col.section) last.count++;
      else list.push({ name: col.section, count: 1 });
      return list;
    },
    []
  );
  const selected = filterFields
    .filter(([, key]) => filters[key] !== "all")
    .map(([dimension, key, label]) => {
      const item = options.data?.[dimension].find(
        o => String(o.id) === filters[key]
      );
      return `${label}: ${item?.name || `#${filters[key]}`}${item?.code ? ` (${item.code})` : ""}`;
    });
  const scope = [
    `النطاق: ${summaryTypes[type]}`,
    ...(selected.length ? selected : ["جميع البيانات"]),
  ].join(" | ");
  const canOutput =
    !!report?.rows.length && !query.isFetching && !query.isError;
  const reset = () => {
    setGroupBy("department");
    setType("all");
    setFilters(emptyFilters());
  };
  const print = () => {
    if (!report || !canOutput) return;
    const popup = window.open("", "_blank");
    if (!popup) {
      toast.error("اسمح بالنوافذ المنبثقة لمعاينة الطباعة");
      return;
    }
    popup.opener = null;
    popup.document.write(inventorySummaryPrint(report, scope));
    popup.document.close();
  };
  const exportExcel = async () => {
    if (!report || !canOutput) return;
    setExporting(true);
    try {
      await downloadInventorySummary(report, scope);
      toast.success("تم تصدير تقرير الإجماليات");
    } catch {
      toast.error("تعذر تصدير التقرير، حاول مجددًا");
    } finally {
      setExporting(false);
    }
  };
  const renderCells = (row: SummaryRow) =>
    columns.map(col => (
      <td
        key={col.key}
        className={`px-3 py-3 ${col.key === "groupName" ? "text-right font-medium" : "text-center font-mono whitespace-nowrap"}`}
      >
        {col.key === "groupName" ? (
          <>
            {row.groupName}
            {row.groupCode && (
              <span
                className="block text-xs font-normal text-muted-foreground"
                dir="ltr"
              >
                {row.groupCode}
              </span>
            )}
          </>
        ) : (
          <span dir="ltr">
            {col.money
              ? formatSummaryMoney(String(row[col.key]))
              : Number(row[col.key]).toLocaleString("en-US")}
          </span>
        )}
      </td>
    ));

  return (
    <div className="space-y-4">
      <section
        className="bg-card rounded-xl border border-border p-4 space-y-4"
        aria-label="إعداد تقرير الإجماليات"
      >
        <div className="flex items-center justify-between gap-3">
          <h3 className="flex items-center gap-2 text-sm font-bold">
            <Filter className="w-4 h-4 text-primary" />
            إعداد التقرير
          </h3>
          <Button variant="ghost" size="sm" onClick={reset}>
            <RotateCcw className="w-3.5 h-3.5 ml-1" />
            إعادة التعيين
          </Button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Picker
            id="summary-group"
            label="عرض الإجماليات حسب"
            value={groupBy}
            onChange={v => setGroupBy(v as Group)}
            options={Object.entries(summaryGroups).map(([value, label]) => ({
              value,
              label,
            }))}
          />
          <Picker
            id="summary-type"
            label="نوع السجلات"
            value={type}
            onChange={v => setType(v as InventorySummaryInput["type"])}
            options={Object.entries(summaryTypes).map(([value, label]) => ({
              value,
              label,
            }))}
          />
        </div>
        <div className="border-t border-border pt-3">
          <div className="flex justify-between flex-wrap gap-1 mb-3">
            <span className="text-xs font-medium">تصفية النتائج</span>
            <span className="text-xs text-muted-foreground">
              يمكن استخدام أي فلتر بمفرده أو دمج أكثر من فلتر
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {filterFields.map(([dimension, key, label, all]) => (
              <Picker
                key={key}
                id={`summary-${key}`}
                label={label}
                value={filters[key]}
                onChange={value =>
                  setFilters(previous => ({ ...previous, [key]: value }))
                }
                options={[
                  { value: "all", label: all },
                  ...(options.data?.[dimension] || []).map(o => ({
                    value: String(o.id),
                    label: `${o.name}${o.code ? ` (${o.code})` : ""}`,
                  })),
                ]}
              />
            ))}
          </div>
        </div>
        {options.isError && (
          <p role="alert" className="text-sm text-destructive">
            تعذر تحميل خيارات الفلاتر.{" "}
            <button className="underline" onClick={() => options.refetch()}>
              إعادة المحاولة
            </button>
          </p>
        )}
      </section>
      {report && !query.isError && (
        <div
          className="grid grid-cols-1 sm:grid-cols-3 gap-3"
          aria-live="polite"
        >
          <div className="bg-card rounded-xl border p-4">
            <p className="text-xs text-muted-foreground">
              عدد السجلات المعتمدة
            </p>
            <p className="text-2xl font-bold mt-1" dir="ltr">
              {(
                report.total.assetRecords + report.total.custodyRecords
              ).toLocaleString("en-US")}
            </p>
          </div>
          <div className="bg-card rounded-xl border p-4">
            <p className="text-xs text-muted-foreground">
              إجمالي الكميات المتبقية
            </p>
            <p className="text-2xl font-bold mt-1" dir="ltr">
              {(
                report.total.assetQuantity + report.total.custodyQuantity
              ).toLocaleString("en-US")}
            </p>
          </div>
          <div className="bg-primary/5 rounded-xl border border-primary/40 p-4">
            <p className="text-xs text-muted-foreground">
              القيمة الإجمالية المسجلة (ر.س)
            </p>
            <p
              className="text-2xl font-bold text-primary mt-1 break-words"
              dir="ltr"
            >
              {formatSummaryMoney(report.total.totalValue)}
            </p>
          </div>
        </div>
      )}
      <section
        className="bg-card rounded-xl border border-border overflow-hidden"
        aria-label="نتائج تقرير الإجماليات"
      >
        <div className="p-4 space-y-3">
          <div className="flex justify-between items-center flex-wrap gap-3">
            <div>
              <h3 className="font-bold">{summaryTitle({ groupBy, type })}</h3>
              <p className="text-xs text-muted-foreground mt-1">
                إجماليات فقط دون تفاصيل الأصناف · جميع القيم بالريال السعودي
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!canOutput}
                onClick={print}
              >
                <Printer className="w-4 h-4 ml-1.5" />
                معاينة الطباعة
              </Button>
              <Button
                size="sm"
                disabled={!canOutput || exporting}
                onClick={exportExcel}
              >
                {exporting ? (
                  <Loader2 className="w-4 h-4 ml-1.5 animate-spin" />
                ) : (
                  <FileSpreadsheet className="w-4 h-4 ml-1.5" />
                )}
                تصدير Excel
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {[
              `النطاق: ${summaryTypes[type]}`,
              ...(selected.length ? selected : ["جميع البيانات"]),
            ].map(text => (
              <span
                key={text}
                className="bg-muted/60 rounded px-2 py-1 text-xs text-muted-foreground"
              >
                {text}
              </span>
            ))}
          </div>
        </div>
        {query.isError ? (
          <div role="alert" className="p-8 text-center space-y-3">
            <p className="text-destructive">تعذر تحميل تقرير الإجماليات</p>
            <Button variant="outline" onClick={() => query.refetch()}>
              إعادة المحاولة
            </Button>
          </div>
        ) : query.isFetching || !report ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            <Loader2 className="w-6 h-6 mx-auto mb-2 animate-spin" />
            جاري تحميل الإجماليات...
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <caption className="sr-only">
                  {summaryTitle(report)} — {scope}
                </caption>
                <thead className="bg-muted/60 text-muted-foreground">
                  <tr>
                    {sections.map(s => (
                      <th
                        key={s.name}
                        colSpan={s.count}
                        scope="colgroup"
                        className="px-3 py-2 border-b border-border font-medium"
                      >
                        {s.name}
                      </th>
                    ))}
                  </tr>
                  <tr>
                    {columns.map(col => (
                      <th
                        key={col.key}
                        scope="col"
                        className={`px-3 py-3 font-medium ${col.key === "groupName" ? "text-right min-w-40" : "text-center whitespace-nowrap"}`}
                      >
                        {col.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.rows.length ? (
                    report.rows.map(row => (
                      <tr
                        key={row.groupId ?? "unassigned"}
                        className="border-t border-border/60 hover:bg-muted/20"
                      >
                        {renderCells(row)}
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td
                        colSpan={columns.length}
                        className="p-10 text-center text-muted-foreground"
                      >
                        لا توجد بيانات مطابقة للفلاتر المحددة
                      </td>
                    </tr>
                  )}
                </tbody>
                {report.rows.length > 0 && (
                  <tfoot className="bg-primary/5 border-t-2 border-primary/40 font-bold">
                    <tr>
                      {renderCells({
                        ...report.total,
                        groupId: null,
                        groupName: "الإجمالي العام",
                        groupCode: null,
                      })}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            <div className="p-4 border-t border-border text-xs text-muted-foreground space-y-1">
              <div className="flex justify-between flex-wrap gap-2">
                <span>
                  {report.rows.length} مجموعات ·{" "}
                  {report.total.assetRecords + report.total.custodyRecords}{" "}
                  سجلات
                </span>
                <span>
                  تاريخ التقرير:{" "}
                  {new Date(report.generatedAt).toLocaleString("ar-SA")}
                </span>
              </div>
              <p>{summaryBasis}</p>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
