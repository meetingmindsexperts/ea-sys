"use client";

import { SearchableSelect, type SearchableSelectOption } from "@/components/ui/searchable-select";
import type { ContactFilterOptions } from "@/hooks/use-api";
import { NOT_SET } from "@/lib/contact-filters";
import { formatAttendeeRole } from "@/lib/schemas";

/** The "no filter" choice; never sent to the server. */
const ANY = "__any__";
const NOT_SET_LABEL = "Not recorded";

export interface ContactFieldFilterValues {
  specialty: string | null;
  country: string | null;
  role: string | null;
}

export const EMPTY_FIELD_FILTERS: ContactFieldFilterValues = { specialty: null, country: null, role: null };

function withCount(label: string, count: number): string {
  return `${label} (${count.toLocaleString()})`;
}

/** Any, then each value with its count, then Not recorded when some have none. */
function buildOptions(
  anyLabel: string,
  values: { value: string; count: number }[],
  notSet: number,
  format: (v: string) => string,
): SearchableSelectOption[] {
  const options: SearchableSelectOption[] = [{ value: ANY, label: anyLabel }];
  for (const v of values) options.push({ value: v.value, label: withCount(format(v.value), v.count) });
  if (notSet > 0) options.push({ value: NOT_SET, label: withCount(NOT_SET_LABEL, notSet) });
  return options;
}

/**
 * What the picker's button says. A chosen value that has dropped out of the
 * options (its last contact edited away) still shows as itself, never as "All":
 * the list and the export are still filtered by it (review M2, Oct 23, 2026).
 */
function chosenLabel(current: string | null, options: SearchableSelectOption[], anyLabel: string, format: (v: string) => string): string {
  if (!current) return anyLabel;
  const listed = options.find((o) => o.value === current)?.label;
  if (listed) return listed;
  return current === NOT_SET ? NOT_SET_LABEL : format(current);
}

const plain = (v: string) => v;
const role = (v: string) => formatAttendeeRole(v);

/**
 * Specialty, Country and Role filters for the Contacts page (Oct 23, 2026).
 * Each lists the values in use with how many contacts hold them under the
 * page's other filters, so the number beside a choice is what picking it shows.
 */
export function ContactFieldFilters({
  value,
  onChange,
  options,
  loading,
  failed,
}: {
  value: ContactFieldFilterValues;
  onChange: (next: ContactFieldFilterValues) => void;
  options: ContactFilterOptions | undefined;
  loading: boolean;
  failed: boolean;
}) {
  const fields: {
    key: keyof ContactFieldFilterValues;
    anyLabel: string;
    search: string;
    format: (v: string) => string;
    options: SearchableSelectOption[];
  }[] = [
    {
      key: "specialty",
      anyLabel: "All specialties",
      search: "Type to find a specialty…",
      format: plain,
      options: buildOptions("All specialties", options?.specialties ?? [], options?.specialtyNotSet ?? 0, plain),
    },
    {
      key: "country",
      anyLabel: "All countries",
      search: "Type to find a country…",
      format: plain,
      options: buildOptions("All countries", options?.countries ?? [], options?.countryNotSet ?? 0, plain),
    },
    {
      key: "role",
      anyLabel: "All roles",
      search: "Type to find a role…",
      format: role,
      options: buildOptions("All roles", options?.roles ?? [], options?.roleNotSet ?? 0, role),
    },
  ];

  const waiting = loading && !options;

  return (
    <>
      {fields.map((f) => {
        const current = value[f.key];
        return (
          <div key={f.key} className="w-60 max-w-full" aria-label={f.anyLabel}>
            <SearchableSelect
              value={current ?? ANY}
              displayLabel={waiting ? "Loading choices…" : chosenLabel(current, f.options, f.anyLabel, f.format)}
              onChange={(v) => onChange({ ...value, [f.key]: v === ANY ? null : v })}
              options={f.options}
              disabled={waiting}
              placeholder={f.anyLabel}
              searchPlaceholder={f.search}
              emptyText="Nothing matches what you typed"
            />
          </div>
        );
      })}
      {failed && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          Couldn&rsquo;t load the filter choices. Refresh the page to try again.
        </p>
      )}
    </>
  );
}

/**
 * The one-line help under the filters: what the numbers mean and the two data
 * traps (variant country spellings, roles mostly unrecorded).
 */
export function ContactFieldFiltersHint() {
  return (
    <p className="text-xs text-gray-500 dark:text-gray-400 basis-full">
      The number beside each choice is how many contacts you would see. Some countries are spelled more than
      one way (for example &ldquo;UAE&rdquo; and &ldquo;United Arab Emirates&rdquo;), so check the list for
      other spellings. Most contacts have no role recorded: choose &ldquo;Not recorded&rdquo; to see them.
    </p>
  );
}

/** The page's filters in words, for the export dialog ("Country: India"). */
export function describeContactFilters(query: Record<string, string>): string[] {
  const out: string[] = [];
  const named = (v: string, format: (s: string) => string) => (v === NOT_SET ? NOT_SET_LABEL : format(v));
  if (query.search) out.push(`Search: “${query.search}”`);
  if (query.tags) out.push(`Tags: ${query.tags.split(",").join(", ")}`);
  if (query.specialty) out.push(`Specialty: ${named(query.specialty, plain)}`);
  if (query.country) out.push(`Country: ${named(query.country, plain)}`);
  if (query.role) out.push(`Role: ${named(query.role, role)}`);
  return out;
}
