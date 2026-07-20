"use client";

/**
 * A from–to date range. For deals it also picks WHICH date the range applies to
 * (expected close / created / closed); for tasks the field is fixed (due date), so
 * `fields` is omitted and no picker renders.
 *
 * The two date inputs STAGE locally and commit together on **Apply** (or Enter),
 * via a single `onApply({ from, to })` call — never one at a time. A range is only
 * meaningful once both ends are chosen, so applying after just the `from` was set
 * used to re-query the board into a confusing half-filtered state and read as
 * "the filter isn't working". One atomic commit also means one `router.replace`
 * (the URL is the filter's source of truth), so from+to land in the same history
 * entry instead of two.
 *
 * The field-type select (deals only) stays live — it's a single atomic choice with
 * no half-entered state to confuse.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
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
  onApply,
  label = "Date",
}: {
  fieldValue?: string;
  onFieldChange?: (v: string) => void;
  fields?: DateFieldOption[];
  /** The APPLIED range (from the URL) — seeds the staged inputs and resets them
   *  when the range changes out from under us (Clear, back-button). */
  from: string;
  to: string;
  /** Commit both ends at once. Empty string → null clears that end. */
  onApply: (range: { from: string | null; to: string | null }) => void;
  label?: string;
}) {
  const [pendingFrom, setPendingFrom] = useState(from);
  const [pendingTo, setPendingTo] = useState(to);

  // React 19 "store info from a previous render" pattern (no useEffect+setState):
  // when the APPLIED range changes externally — Clear, navigation, back-button —
  // adopt it into the staged inputs so the fields never show a stale draft.
  const [appliedFrom, setAppliedFrom] = useState(from);
  const [appliedTo, setAppliedTo] = useState(to);
  if (from !== appliedFrom || to !== appliedTo) {
    setAppliedFrom(from);
    setAppliedTo(to);
    setPendingFrom(from);
    setPendingTo(to);
  }

  const dirty = pendingFrom !== from || pendingTo !== to;

  function apply() {
    if (!dirty) return;
    onApply({ from: pendingFrom || null, to: pendingTo || null });
  }

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
        value={pendingFrom}
        max={pendingTo || undefined}
        onChange={(e) => setPendingFrom(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && apply()}
        aria-label={`${label} from`}
      />
      <span className="text-muted-foreground">–</span>
      <Input
        type="date"
        className="w-[9.5rem]"
        value={pendingTo}
        min={pendingFrom || undefined}
        onChange={(e) => setPendingTo(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && apply()}
        aria-label={`${label} to`}
      />
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={apply}
        disabled={!dirty}
        aria-label={`Apply ${label.toLowerCase()} range`}
      >
        Apply
      </Button>
    </div>
  );
}
