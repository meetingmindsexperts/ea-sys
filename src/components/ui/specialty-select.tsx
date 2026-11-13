"use client";

import { SearchableSelect } from "./searchable-select";
import { defaultPersonFields, offeredAnswers } from "@/lib/person-fields";
import { usePersonFields } from "@/hooks/use-person-fields";

/**
 * The specialties offered when an organisation has saved none of its own,
 * "Others" last: one copy, in src/lib/person-fields.ts. The picker below does
 * NOT read this: it offers the organisation's list (Settings, Form fields).
 */
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
  // The organisation's own answers (Nov 13, 2026); today's list until they
  // load. A stored answer that is retired or was never on the list still shows
  // on the button: the picker displays the value itself.
  const { specialty } = usePersonFields();
  return (
    <SearchableSelect
      id={id}
      value={value}
      onChange={onChange}
      options={specialty.answers.map((a) => ({ value: a.key, label: a.label }))}
      disabled={disabled}
      placeholder={placeholder}
      searchPlaceholder="Search specialties..."
      emptyText="No specialties found"
    />
  );
}
