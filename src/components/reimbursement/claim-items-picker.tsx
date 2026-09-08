"use client";

/**
 * The five reimbursement-type checkboxes (Honorarium / Flights / Hotel /
 * Transport / Other), used three times: the event default on the
 * reimbursements console, and the per-speaker override on the console's row
 * detail and on the speaker profile's Reimbursement card. One component so
 * the label set, the at-least-one rule and the "use event default" switch
 * cannot drift between the three.
 */
import { CLAIM_ITEMS, type ClaimItemKey } from "@/lib/reimbursement/constants";
import { Checkbox } from "@/components/ui/checkbox";

export function ClaimItemsPicker({
  value,
  onChange,
  disabled,
}: {
  value: ClaimItemKey[];
  onChange: (next: ClaimItemKey[]) => void;
  disabled?: boolean;
}) {
  const toggle = (key: ClaimItemKey, on: boolean) => {
    const next = on ? [...value, key] : value.filter((k) => k !== key);
    // At least one type must stay offered; an empty set would make every
    // form say "nothing to claim" with no way for the speaker to tell why.
    if (next.length === 0) return;
    onChange(CLAIM_ITEMS.map((c) => c.key).filter((k) => next.includes(k)));
  };
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {CLAIM_ITEMS.map((item) => {
        const checked = value.includes(item.key);
        return (
          <label
            key={item.key}
            className={`flex items-center gap-2.5 rounded-md border px-3 py-2 text-sm ${
              disabled ? "opacity-60" : "cursor-pointer hover:bg-muted/40"
            } ${checked ? "border-primary/40 bg-primary/[0.04]" : "border-border"}`}
          >
            <Checkbox
              checked={checked}
              disabled={disabled}
              onCheckedChange={(v) => toggle(item.key, Boolean(v))}
            />
            <span>{item.label}</span>
          </label>
        );
      })}
    </div>
  );
}

/** "Flights, Hotel, Other" for a list of keys, in canonical order. */
export function claimItemsSummary(keys: readonly ClaimItemKey[]): string {
  return CLAIM_ITEMS.filter((c) => keys.includes(c.key))
    .map((c) => c.label)
    .join(", ");
}
