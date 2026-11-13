"use client";

import { SearchableSelect } from "./searchable-select";
import { usePersonFields } from "@/hooks/use-person-fields";


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
