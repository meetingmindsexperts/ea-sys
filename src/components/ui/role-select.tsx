"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";

export const ROLE_OPTIONS = [
  { value: "ACADEMIA", label: "Academia" },
  { value: "ALLIED_HEALTH", label: "Allied Health" },
  { value: "MEDICAL_DEVICES", label: "Medical Devices" },
  { value: "PHARMA", label: "Pharma" },
  { value: "PHYSICIAN", label: "Physician" },
  { value: "RESIDENT", label: "Resident" },
  { value: "SPEAKER", label: "Speaker" },
  { value: "STUDENT", label: "Student" },
  { value: "OTHERS", label: "Others (Spouse)" },
] as const;

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
      <SelectTrigger>
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
