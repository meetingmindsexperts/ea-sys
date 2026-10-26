"use client";

import { countries } from "@/lib/countries";
import { SearchableSelect } from "./searchable-select";

interface CountrySelectProps {
  /** Put on the button you tap, so a <label htmlFor> can point at the picker. */
  id?: string;
  value: string | null | undefined;
  onChange: (country: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

/** Searchable country picker (ISO 3166-1, 196 countries). Stores the country
 *  NAME (legacy rows may hold a code — resolved for display either way). */
export function CountrySelect({
  id,
  value,
  onChange,
  disabled = false,
  placeholder = "Select country",
}: CountrySelectProps) {
  const selected = countries.find((c) => c.code === value || c.name === value);

  return (
    <SearchableSelect
      id={id}
      value={value}
      displayLabel={selected?.name}
      onChange={onChange}
      options={countries.map((c) => ({ value: c.name, label: c.name }))}
      disabled={disabled}
      placeholder={placeholder}
      searchPlaceholder="Search countries..."
      emptyText="No countries found"
    />
  );
}
