"use client";

import { SearchableSelect, type SearchableSelectOption } from "@/components/ui/searchable-select";
import { useContactFilterOptions } from "@/hooks/use-api";
import { NOT_SET } from "@/lib/contact-filters";
import { formatAttendeeRole } from "@/lib/schemas";

/** The "no filter" choice; never sent to the server. */
const ANY = "__any__";

export interface ContactFieldFilterValues {
  specialty: string | null;
  country: string | null;
  role: string | null;
}

function withCount(label: string, count: number): string {
  return `${label} (${count.toLocaleString()})`;
}

/** Any, then each value with its count, then Not set when some have none. */
function buildOptions(
  anyLabel: string,
  values: { value: string; count: number }[],
  notSet: number,
  format: (v: string) => string = (v) => v,
): SearchableSelectOption[] {
  const options: SearchableSelectOption[] = [{ value: ANY, label: anyLabel }];
  for (const v of values) options.push({ value: v.value, label: withCount(format(v.value), v.count) });
  if (notSet > 0) options.push({ value: NOT_SET, label: withCount("Not set", notSet) });
  return options;
}

/**
 * Specialty, Country and Role filters for the Contacts page (Oct 23, 2026).
 * Each lists the values in use with how many contacts hold them, so a choice
 * that would return nobody is never offered.
 */
export function ContactFieldFilters({
  value,
  onChange,
}: {
  value: ContactFieldFilterValues;
  onChange: (next: ContactFieldFilterValues) => void;
}) {
  const { data } = useContactFilterOptions();

  const fields: {
    key: keyof ContactFieldFilterValues;
    anyLabel: string;
    search: string;
    options: SearchableSelectOption[];
  }[] = [
    {
      key: "specialty",
      anyLabel: "All specialties",
      search: "Search specialties…",
      options: buildOptions("All specialties", data?.specialties ?? [], data?.specialtyNotSet ?? 0),
    },
    {
      key: "country",
      anyLabel: "All countries",
      search: "Search countries…",
      options: buildOptions("All countries", data?.countries ?? [], data?.countryNotSet ?? 0),
    },
    {
      key: "role",
      anyLabel: "All roles",
      search: "Search roles…",
      options: buildOptions("All roles", data?.roles ?? [], data?.roleNotSet ?? 0, formatAttendeeRole),
    },
  ];

  return (
    <>
      {fields.map((f) => {
        const current = value[f.key];
        const label = f.options.find((o) => o.value === current)?.label;
        return (
          <div key={f.key} className="w-48">
            <SearchableSelect
              value={current ?? ANY}
              displayLabel={label ?? f.anyLabel}
              onChange={(v) => onChange({ ...value, [f.key]: v === ANY ? null : v })}
              options={f.options}
              placeholder={f.anyLabel}
              searchPlaceholder={f.search}
              emptyText="No match"
            />
          </div>
        );
      })}
    </>
  );
}
