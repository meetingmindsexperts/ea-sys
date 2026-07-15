"use client";

/**
 * Deal value min–max. STAFF ONLY.
 *
 * The parent decides whether to render this at all (via canViewDealValues), and the
 * SERVER independently ignores value params from a non-finance caller — so this is
 * a convenience, never the security boundary. A redacted value must not become
 * binary-searchable through a filter.
 */
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ValueRangeFilter({
  min,
  max,
  onMinChange,
  onMaxChange,
}: {
  min: string;
  max: string;
  onMinChange: (v: string | null) => void;
  onMaxChange: (v: string | null) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Label className="text-xs text-muted-foreground">Value</Label>
      <Input
        inputMode="numeric"
        className="w-[6.5rem]"
        placeholder="min"
        value={min}
        onChange={(e) => onMinChange(e.target.value || null)}
        aria-label="Minimum value"
      />
      <span className="text-muted-foreground">–</span>
      <Input
        inputMode="numeric"
        className="w-[6.5rem]"
        placeholder="max"
        value={max}
        onChange={(e) => onMaxChange(e.target.value || null)}
        aria-label="Maximum value"
      />
    </div>
  );
}
