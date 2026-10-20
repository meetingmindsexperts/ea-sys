"use client";

/**
 * The "what prints on the badge" switches, used twice on the event Settings
 * badge card: once for everyone, once for exhibitors (Oct 20, 2026). One grid
 * so the two sets always offer the same fields under the same names.
 */
import { Switch } from "@/components/ui/switch";
import type { BadgeFields } from "@/lib/badge-layout";

const FIELD_LABELS: { key: keyof BadgeFields; label: string }[] = [
  { key: "border", label: "Cutting border" },
  { key: "name", label: "Name" },
  { key: "organization", label: "Organisation" },
  { key: "country", label: "Country" },
  { key: "barcode", label: "Entry barcode" },
  { key: "registrationNumber", label: "Registration number (reg ID)" },
  { key: "badgeType", label: "Role / badge type" },
];

/** Comma list of the switched-on keys, the form the badge preview link takes. */
export function enabledBadgeFieldKeys(fields: BadgeFields): string {
  return Object.entries(fields)
    .filter(([, on]) => on)
    .map(([k]) => k)
    .join(",");
}

export function BadgeFieldSwitches({
  value,
  onChange,
  omit = [],
}: {
  value: BadgeFields;
  onChange: (next: BadgeFields) => void;
  /** Fields this set does not control, e.g. the border for exhibitors. */
  omit?: (keyof BadgeFields)[];
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 max-w-2xl">
      {FIELD_LABELS.filter(({ key }) => !omit.includes(key)).map(({ key, label }) => (
        <label key={key} className="flex items-center gap-2 text-sm">
          <Switch checked={value[key]} onCheckedChange={(v) => onChange({ ...value, [key]: v })} />
          {label}
        </label>
      ))}
    </div>
  );
}
