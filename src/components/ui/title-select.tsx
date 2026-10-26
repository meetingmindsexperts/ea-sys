"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";

export const TITLE_OPTIONS = [
  { value: "DR", label: "Dr." },
  { value: "MR", label: "Mr." },
  { value: "MRS", label: "Mrs." },
  { value: "MS", label: "Ms." },
  { value: "PROF", label: "Prof." },
] as const;

interface TitleSelectProps {
  /** Put on the button you tap, so a <label htmlFor> can point at the picker. */
  id?: string;
  value: string | null | undefined;
  onChange: (title: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function TitleSelect({
  id,
  value,
  onChange,
  disabled = false,
  placeholder = "Title",
}: TitleSelectProps) {
  return (
    // "" rather than undefined when empty: Radix Select (2.x) shows the
    // placeholder for "" and stays controlled, so picking a value no longer
    // logs "changing from uncontrolled to controlled".
    <Select value={value || ""} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} className="w-full">
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
