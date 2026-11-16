"use client";

import { useMemo } from "react";
import { usePathname } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchApi } from "@/hooks/use-api";
import { DEFAULT_PUBLIC_PERSON_FIELDS, personFieldRules, storedAnswerLabel, type ConfigurablePersonField, type PersonFieldRules, type PublicPersonFields } from "@/lib/person-fields";

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
  return usePersonFieldsState(opts).fields;
}

/**
 * The same, and whether they are the organisation's REAL list (`ready`), not
 * today's lists shown while it loads or after a failed read (step 1d). A
 * picker must not judge a stored answer "no longer offered", or drop it,
 * against a list that is not the organisation's.
 *
 * `ready` means "a list the server sent", not "the newest list": a list kept
 * in the cache (five minutes) counts, so a page opened just after a Settings
 * save may judge against the list from before it until the refetch lands
 * (review of bef0c980). The server door is the final word either way.
 */
export function usePersonFieldsState(opts: { organisationOnly?: boolean } = {}): { fields: PublicPersonFields; ready: boolean } {
  // On an event's pages the list is the event's organisation's, whoever is
  // looking and whatever address serves the page, with the event's own choice.
  const pathname = usePathname() ?? "";
  const event = opts.organisationOnly ? null : eventOfPage(pathname);
  const { data, isPlaceholderData, isSuccess } = useQuery({
    queryKey: [...PUBLIC_FIELDS_KEY, event],
    queryFn: async () => (await fetchApi<{ fields: PublicPersonFields }>(`/api/public/person-fields${event ? `?event=${encodeURIComponent(event)}` : ""}`)).fields,
    placeholderData: DEFAULT_PUBLIC_PERSON_FIELDS,
    retry: 1,
    // The page works without it: not a fault to report (see providers.tsx).
    meta: { optional: true },
  });
  return { fields: data ?? DEFAULT_PUBLIC_PERSON_FIELDS, ready: isSuccess && !isPlaceholderData };
}

/**
 * How a screen shows one field (step 1c): its caption, the organisation's own
 * label for it, and a stored answer by the organisation's label for it,
 * retired answers included. Never a fixed list: an organisation's own Role
 * answer would otherwise show as its key.
 */
export function usePersonFieldLabel(field: ConfigurablePersonField): {
  caption: string;
  of: (stored: string | null | undefined, fallback?: string) => string;
} {
  const fields = usePersonFields();
  return useMemo(
    () => ({ caption: fields[field].label, of: (stored, fallback = "") => storedAnswerLabel(fields[field], stored, fallback) }),
    [fields, field],
  );
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

/** One Role answer as Settings edits it (step 1d): a key that never changes, a label that may. */
export interface RoleAnswerRow {
  /** Absent on an answer added on this screen and not saved yet. */
  key?: string;
  label: string;
  retired: boolean;
  /** How many records in the organisation hold this answer. */
  records: number;
}

export interface RoleSettings {
  label: string;
  /** False while the contacts feed (Mailchimp) is connected: answers can be added and retired, not renamed. */
  renameAllowed: boolean;
  answers: (RoleAnswerRow & { key: string })[];
}

/** The names of Role and Specialty as every form shows them (step 1d). */
export interface FieldLabels {
  role: string;
  specialty: string;
}

interface FormFieldSettings {
  fields: FieldSwitches;
  specialty: SpecialtySettings;
  role: RoleSettings;
  labels: FieldLabels;
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

/** The Role answers as Settings edits them: every answer, retired ones too, with how many records hold each. */
export function useRoleSettings() {
  const query = useFormFieldSettings();
  return { ...query, data: query.data?.role };
}

export function useSaveRoleAnswers() {
  const queryClient = useQueryClient();
  return useMutation({
    // `expected` is the list the edit started from: a save made from an older copy is refused.
    mutationFn: (input: { answers: { key?: string; label: string; retired: boolean }[]; expected: { answers: { key: string; label: string; retired: boolean }[] } }) =>
      fetchApi<FormFieldSettings>("/api/organization/person-fields", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: input }),
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(SPECIALTY_SETTINGS_KEY, saved);
      queryClient.invalidateQueries({ queryKey: PUBLIC_FIELDS_KEY });
    },
  });
}

/** The names of Role and Specialty as Settings edits them. */
export function useFieldLabels() {
  const query = useFormFieldSettings();
  return { ...query, data: query.data?.labels };
}

export function useSaveFieldLabels() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { labels: FieldLabels; expected: FieldLabels }) =>
      fetchApi<FormFieldSettings>("/api/organization/person-fields", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labels: input }),
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(SPECIALTY_SETTINGS_KEY, saved);
      queryClient.invalidateQueries({ queryKey: PUBLIC_FIELDS_KEY });
    },
  });
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
