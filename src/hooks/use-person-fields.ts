"use client";

import { useMemo } from "react";
import { usePathname } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchApi } from "@/hooks/use-api";
import { DEFAULT_PUBLIC_PERSON_FIELDS, personFieldRules, type ConfigurablePersonField, type PersonFieldRules, type PublicPersonFields } from "@/lib/person-fields";

/**
 * What the organisation's forms ask about a person (Nov 13, 2026; step 1 of
 * docs/ORG_FIELDS_PLAN.md). One read, shared by every picker on the page and
 * kept for five minutes, as the rest of the app's data is.
 *
 * Two different shapes live under these keys, so they never share a prefix
 * with a value a person can choose: an event's slug is one.
 */
export const PUBLIC_FIELDS_KEY = ["person-fields", "public"] as const;
const SPECIALTY_SETTINGS_KEY = ["person-fields", "settings"] as const;

/**
 * Which event a page belongs to, from its address: `/e/<slug>/...` for the
 * public pages and `/events/<id>/...` for the dashboard's. The fields a form
 * shows on those pages are the organisation's AS THAT EVENT ASKS THEM (its own
 * choice laid over the organisation's switches). Elsewhere, and where a
 * caller asks for the organisation's own (the event settings card, which shows
 * what the event is choosing over), there is no event.
 */
export function eventOfPage(pathname: string): string | null {
  // The route takes a slug or an id in the same parameter, as the public pages do.
  const slug = /^\/e\/([^/]+)/.exec(pathname)?.[1];
  const id = /^\/events\/([^/]+)/.exec(pathname)?.[1];
  // "/events/new" is the creation page, not an event (an event's SLUG may be "new").
  const ref = slug ?? (id === "new" ? undefined : id);
  if (!ref) return null;
  // The address holds the segment encoded; the caller encodes it once for the query.
  try {
    return decodeURIComponent(ref);
  } catch {
    return ref;
  }
}

/**
 * The fields a form shows. While the organisation's own are loading, and if
 * they cannot be read, this is today's lists: a form never loses its picker.
 */
export function usePersonFields(opts: { organisationOnly?: boolean } = {}): PublicPersonFields {
  // On an event's pages the list is the event's organisation's, whoever is
  // looking and whatever address serves the page, with the event's own choice.
  const pathname = usePathname() ?? "";
  const event = opts.organisationOnly ? null : eventOfPage(pathname);
  const { data } = useQuery({
    queryKey: [...PUBLIC_FIELDS_KEY, event],
    queryFn: async () => (await fetchApi<{ fields: PublicPersonFields }>(`/api/public/person-fields${event ? `?event=${encodeURIComponent(event)}` : ""}`)).fields,
    placeholderData: DEFAULT_PUBLIC_PERSON_FIELDS,
    retry: 1,
    // The page works without it: not a fault to report (see providers.tsx).
    meta: { optional: true },
  });
  return data ?? DEFAULT_PUBLIC_PERSON_FIELDS;
}

/**
 * What the form on this page does with Title, Role and Specialty: show or
 * not, demand or not. The same rule its route applies (person-field-check.ts).
 */
export function usePersonFieldRules(): PersonFieldRules {
  const fields = usePersonFields();
  // One object for as long as the fields are the same read: forms build their
  // schema from it, and a new object every render would rebuild that each time.
  return useMemo(() => personFieldRules(fields), [fields]);
}

export interface SpecialtyAnswerRow {
  answer: string;
  retired: boolean;
  /** How many records in the organisation store this answer (one person can be several). */
  records: number;
}

export interface SpecialtySettings {
  label: string;
  allowOther: boolean;
  answers: SpecialtyAnswerRow[];
}

export interface SpecialtyListInput {
  answers: { answer: string; retired: boolean }[];
  allowOther: boolean;
}

/** Asked or not, and demanded or not, for each of the three fields. */
export type FieldSwitches = Record<ConfigurablePersonField, { enabled: boolean; required: boolean }>;

interface FormFieldSettings {
  fields: FieldSwitches;
  specialty: SpecialtySettings;
}

/** Everything Settings, Form fields edits, in one read. */
function useFormFieldSettings() {
  return useQuery({
    queryKey: SPECIALTY_SETTINGS_KEY,
    queryFn: () => fetchApi<FormFieldSettings>("/api/organization/person-fields"),
  });
}

/** The Specialty list as Settings edits it: every answer, retired ones too, with how many records store each. */
export function useSpecialtySettings() {
  const query = useFormFieldSettings();
  return { ...query, data: query.data?.specialty };
}

/** The three fields' switches as Settings edits them. */
export function useFieldSwitches() {
  const query = useFormFieldSettings();
  return { ...query, data: query.data?.fields };
}

export function useSaveFieldSwitches() {
  const queryClient = useQueryClient();
  return useMutation({
    // `expected` is what the screen loaded: a save made from older switches is refused.
    mutationFn: (input: { switches: FieldSwitches; expected: FieldSwitches }) =>
      fetchApi<FormFieldSettings>("/api/organization/person-fields", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: input }),
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(SPECIALTY_SETTINGS_KEY, saved);
      queryClient.invalidateQueries({ queryKey: PUBLIC_FIELDS_KEY });
    },
  });
}

export function useSaveSpecialtySettings() {
  const queryClient = useQueryClient();
  return useMutation({
    // `expected` is the list the edit started from: a save made from an older
    // copy is refused by the server, never applied over someone else's change.
    mutationFn: (input: SpecialtyListInput & { expected: SpecialtyListInput }) =>
      fetchApi<FormFieldSettings>("/api/organization/person-fields", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specialty: input }),
      }),
    onSuccess: (saved) => {
      // The answer carries the saved list with its counts: no second read.
      queryClient.setQueryData(SPECIALTY_SETTINGS_KEY, saved);
      // What every picker in this browser offers.
      queryClient.invalidateQueries({ queryKey: PUBLIC_FIELDS_KEY });
    },
  });
}
