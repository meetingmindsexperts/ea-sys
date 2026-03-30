"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";

export const TITLE_OPTIONS = [
  { value: "DR", label: "Dr" },
  { value: "MR", label: "Mr" },
  { value: "MRS", label: "Mrs" },
  { value: "MS", label: "Ms" },
  { value: "PROF", label: "Prof" },
] as const;

interface TitleSelectProps {
  value: string | null | undefined;
  onChange: (title: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function TitleSelect({
  value,
  onChange,
  disabled = false,
  placeholder = "Title",
}: TitleSelectProps) {
  return (
    <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {TITLE_OPTIONS.map((t) => (
          <SelectItem key={t.value} value={t.value}>
            {t.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
