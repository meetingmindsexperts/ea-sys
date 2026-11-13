"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";
import { defaultPersonFields, offeredAnswers } from "@/lib/person-fields";

/** The titles a form offers by default: one copy, in src/lib/person-fields.ts. */
export const TITLE_OPTIONS = offeredAnswers(defaultPersonFields().title).map((o) => ({ value: o.key, label: o.label }));

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
