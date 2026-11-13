"use client";

import { usePathname } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchApi } from "@/hooks/use-api";
import { DEFAULT_PUBLIC_PERSON_FIELDS, type PublicPersonFields } from "@/lib/person-fields";

/**
 * What the organisation's forms ask about a person (Nov 13, 2026; step 1 of
 * docs/ORG_FIELDS_PLAN.md). One read, shared by every picker on the page and
 * kept for five minutes, as the rest of the app's data is.
 */
const PERSON_FIELDS_KEY = ["person-fields"] as const;
const SPECIALTY_ANSWERS_KEY = ["person-fields", "specialty-settings"] as const;

/**
 * The fields a form shows. While the organisation's own are loading, and if
 * they cannot be read, this is today's lists: a form never loses its picker.
 */
export function usePersonFields(): PublicPersonFields {
  // On an event's public pages (/e/<slug>/...) the list is the event's
  // organisation's, whoever is looking and whatever address serves the page.
  const eventSlug = /^\/e\/([^/]+)/.exec(usePathname() ?? "")?.[1] ?? null;
  const { data } = useQuery({
    queryKey: [...PERSON_FIELDS_KEY, eventSlug],
    queryFn: async () =>
      (await fetchApi<{ fields: PublicPersonFields }>(`/api/public/person-fields${eventSlug ? `?event=${encodeURIComponent(eventSlug)}` : ""}`)).fields,
    placeholderData: DEFAULT_PUBLIC_PERSON_FIELDS,
    retry: 1,
  });
  return data ?? DEFAULT_PUBLIC_PERSON_FIELDS;
}

export interface SpecialtyAnswerRow {
  answer: string;
  retired: boolean;
  /** How many people in the organisation hold this answer. */
  people: number;
}

export interface SpecialtySettings {
  label: string;
  allowOther: boolean;
  answers: SpecialtyAnswerRow[];
}

/** The Specialty list as Settings edits it: every answer, retired ones too, with how many people hold each. */
export function useSpecialtySettings(enabled = true) {
  return useQuery({
    queryKey: SPECIALTY_ANSWERS_KEY,
    queryFn: async () => (await fetchApi<{ specialty: SpecialtySettings }>("/api/organization/person-fields")).specialty,
    enabled,
  });
}

export function useSaveSpecialtySettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { answers: { answer: string; retired: boolean }[]; allowOther: boolean }) =>
      fetchApi<{ specialty: SpecialtySettings }>("/api/organization/person-fields", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specialty: input }),
      }),
    // Both: the list on this screen, and what every picker in the app offers.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PERSON_FIELDS_KEY }),
  });
}
