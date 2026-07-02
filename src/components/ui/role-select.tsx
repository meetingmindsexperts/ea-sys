"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";
import { ATTENDEE_ROLE_ORDER, ATTENDEE_ROLE_LABELS } from "@/lib/schemas";

// Derived from the single source of truth in src/lib/schemas.ts so the picker,
// tables, and CSV/label rendering can never drift.
export const ROLE_OPTIONS = ATTENDEE_ROLE_ORDER.map((value) => ({
  value,
  label: ATTENDEE_ROLE_LABELS[value],
}));

interface RoleSelectProps {
  value: string | null | undefined;
  onChange: (role: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function RoleSelect({
  value,
  onChange,
  disabled = false,
  placeholder = "Select role",
}: RoleSelectProps) {
  return (
    <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {ROLE_OPTIONS.map((r) => (
          <SelectItem key={r.value} value={r.value}>
            {r.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
