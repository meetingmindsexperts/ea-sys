"use client";

import { SearchableSelect } from "./searchable-select";
import { defaultPersonFields, offeredAnswers } from "@/lib/person-fields";

/** The specialties a form offers by default, "Others" last: one copy, in src/lib/person-fields.ts. */
export const SPECIALTIES: string[] = offeredAnswers(defaultPersonFields().specialty).map((o) => o.key);

interface SpecialtySelectProps {
  /** Put on the button you tap, so a <label htmlFor> can point at the picker. */
  id?: string;
  value: string | null | undefined;
  onChange: (specialty: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function SpecialtySelect({
  id,
  value,
  onChange,
  disabled = false,
  placeholder = "Select specialty",
}: SpecialtySelectProps) {
  return (
    <SearchableSelect
      id={id}
      value={value}
      onChange={onChange}
      options={SPECIALTIES.map((s) => ({ value: s, label: s }))}
      disabled={disabled}
      placeholder={placeholder}
      searchPlaceholder="Search specialties..."
      emptyText="No specialties found"
    />
  );
}
