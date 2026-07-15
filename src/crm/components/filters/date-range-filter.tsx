"use client";

/**
 * A from–to date range. For deals it also picks WHICH date the range applies to
 * (expected close / created / closed); for tasks the field is fixed (due date), so
 * `fields` is omitted and no picker renders.
 */
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface DateFieldOption {
  value: string;
  label: string;
}

export function DateRangeFilter({
  fieldValue,
  onFieldChange,
  fields,
  from,
  to,
  onFromChange,
  onToChange,
  label = "Date",
}: {
  fieldValue?: string;
  onFieldChange?: (v: string) => void;
  fields?: DateFieldOption[];
  from: string;
  to: string;
  onFromChange: (v: string | null) => void;
  onToChange: (v: string | null) => void;
  label?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      {fields && fields.length > 0 && onFieldChange ? (
        <Select value={fieldValue || fields[0]!.value} onValueChange={onFieldChange}>
          <SelectTrigger className="w-[10rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {fields.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Label className="text-xs text-muted-foreground">{label}</Label>
      )}
      <Input
        type="date"
        className="w-[9.5rem]"
        value={from}
        max={to || undefined}
        onChange={(e) => onFromChange(e.target.value || null)}
        aria-label={`${label} from`}
      />
      <span className="text-muted-foreground">–</span>
      <Input
        type="date"
        className="w-[9.5rem]"
        value={to}
        min={from || undefined}
        onChange={(e) => onToChange(e.target.value || null)}
        aria-label={`${label} to`}
      />
    </div>
  );
}
