"use client";

import { SearchableSelect, type SearchableSelectOption } from "@/components/ui/searchable-select";
import type { ContactFilterOptions } from "@/hooks/use-api";
import { NOT_SET, type ContactFilterParams } from "@/lib/contact-filters";
import { formatAttendeeRole } from "@/lib/schemas";
import { MultiValueFilter, type MultiValueOption } from "./multi-value-filter";

/** The "no filter" choice for Role; never sent to the server. */
const ANY = "__any__";
const NOT_SET_LABEL = "Not recorded";

export interface ContactFieldFilterValues {
  specialty: string[];
  country: string[];
  role: string | null;
}

export const EMPTY_FIELD_FILTERS: ContactFieldFilterValues = { specialty: [], country: [], role: null };

const plain = (v: string) => v;
const role = (v: string) => formatAttendeeRole(v);
const named = (v: string, format: (s: string) => string) => (v === NOT_SET ? NOT_SET_LABEL : format(v));

/** Each value with its count, then Not recorded when some contacts have none. */
function multiOptions(values: { value: string; count: number }[], notSet: number): MultiValueOption[] {
  const options = values.map((v) => ({ value: v.value, label: v.value, count: v.count }));
  if (notSet > 0) options.push({ value: NOT_SET, label: NOT_SET_LABEL, count: notSet });
  return options;
}

function roleOptions(values: { value: string; count: number }[], notSet: number): SearchableSelectOption[] {
  const withCount = (label: string, count: number) => `${label} (${count.toLocaleString()})`;
  const options: SearchableSelectOption[] = [{ value: ANY, label: "All roles" }];
  for (const v of values) options.push({ value: v.value, label: withCount(role(v.value), v.count) });
  if (notSet > 0) options.push({ value: NOT_SET, label: withCount(NOT_SET_LABEL, notSet) });
  return options;
}

/**
 * What the Role button says. A chosen value that has dropped out of the options
 * (its last contact edited away) still shows as itself, never as "All": the list
 * and the export are still filtered by it (review M2, Oct 23, 2026).
 */
function roleLabel(current: string | null, options: SearchableSelectOption[]): string {
  if (!current) return "All roles";
  return options.find((o) => o.value === current)?.label ?? named(current, role);
}

/**
 * Specialty, Country and Role filters for the Contacts page (Oct 23, 2026).
 * Specialty and Country take several values, matched as any-of (so "UAE" and
 * "United Arab Emirates" can be picked together); Role takes one. Each lists
 * the values in use with how many contacts hold them under the page's other
 * filters, so the number beside a choice is what picking it alone would show.
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
  const waiting = loading && !options;
  const roles = roleOptions(options?.roles ?? [], options?.roleNotSet ?? 0);

  return (
    <>
      <MultiValueFilter
        label={waiting ? "Loading choices…" : "All specialties"}
        noun="specialties"
        options={multiOptions(options?.specialties ?? [], options?.specialtyNotSet ?? 0)}
        selected={value.specialty}
        onChange={(specialty) => onChange({ ...value, specialty })}
        labelFor={(v) => named(v, plain)}
        disabled={waiting}
      />
      <MultiValueFilter
        label={waiting ? "Loading choices…" : "All countries"}
        noun="countries"
        options={multiOptions(options?.countries ?? [], options?.countryNotSet ?? 0)}
        selected={value.country}
        onChange={(country) => onChange({ ...value, country })}
        labelFor={(v) => named(v, plain)}
        disabled={waiting}
      />
      <div className="w-60 max-w-full" aria-label="Role">
        <SearchableSelect
          value={value.role ?? ANY}
          displayLabel={waiting ? "Loading choices…" : roleLabel(value.role, roles)}
          onChange={(v) => onChange({ ...value, role: v === ANY ? null : v })}
          options={roles}
          disabled={waiting}
          placeholder="All roles"
          searchPlaceholder="Type to find a role…"
          emptyText="Nothing matches what you typed"
        />
      </div>
      {failed && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          Couldn&rsquo;t load the filter choices. Refresh the page to try again.
        </p>
      )}
    </>
  );
}

/**
 * The one-line help under the filters: what the numbers mean, that Specialty
 * and Country take several, and the two data traps (variant country spellings,
 * roles mostly unrecorded).
 */
export function ContactFieldFiltersHint() {
  return (
    <p className="text-xs text-gray-500 dark:text-gray-400 basis-full">
      You can tick several specialties or countries. The number beside each choice is how many contacts it
      matches. Some countries are spelled more than one way (for example &ldquo;UAE&rdquo; and &ldquo;United
      Arab Emirates&rdquo;): tick every spelling to catch them all. Most contacts have no role recorded: choose
      &ldquo;Not recorded&rdquo; to see them.
    </p>
  );
}

/** One field in words: "Country: India or UAE". */
function describeField(name: string, value: string | string[] | undefined, format: (s: string) => string): string | null {
  const values = (Array.isArray(value) ? value : [value]).filter((v): v is string => !!v);
  if (values.length === 0) return null;
  return `${name}: ${values.map((v) => named(v, format)).join(" or ")}`;
}

/** The page's filters in words, for the export dialog ("Country: India or UAE"). */
export function describeContactFilters(query: ContactFilterParams): string[] {
  const out: string[] = [];
  const search = query.search;
  if (typeof search === "string" && search) out.push(`Search: “${search}”`);
  const tags = query.tags;
  if (typeof tags === "string" && tags) out.push(`Tags: ${tags.split(",").join(", ")}`);
  for (const line of [
    describeField("Specialty", query.specialty, plain),
    describeField("Country", query.country, plain),
    describeField("Role", query.role, role),
  ]) {
    if (line) out.push(line);
  }
  return out;
}
