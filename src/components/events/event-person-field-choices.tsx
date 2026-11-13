"use client";

import Link from "next/link";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePersonFields } from "@/hooks/use-person-fields";
import {
  CONFIGURABLE_PERSON_FIELDS,
  type ConfigurablePersonField,
  type EventPersonFieldChoice,
  type EventPersonFieldChoices,
  type PublicPersonField,
} from "@/lib/person-fields";

/**
 * What ONE EVENT does with Title, Role and Specialty (Nov 13, 2026; step 2 of
 * docs/ORG_FIELDS_PLAN.md, the event part). The organisation decides whether a
 * field is asked at all and is the ceiling: a field it switched off cannot be
 * asked here. Where it does ask a field, the event may leave it as the
 * organisation has it, not ask it, or ask it as optional or required. Title is
 * on or off only.
 *
 * Controlled: the event settings page holds the choices and saves them with
 * the rest of the Registration tab (`Event.settings.personFieldChoices`).
 */

/** The picker's value for "no choice of its own": Radix has no empty value. */
const AS_ORGANISATION = "follow";

const NAMES: Record<ConfigurablePersonField, string> = { title: "Title", role: "Role", specialty: "Specialty" };

/** What "as the organisation" means today, so the choice is never a blind one. */
function organisationSays(field: ConfigurablePersonField, org: PublicPersonField): string {
  if (field === "title") return "asked";
  return org.required ? "required" : "optional";
}

/** The choices on offer for a field: Title is asked or not, the other two also say required or not. */
function choicesFor(field: ConfigurablePersonField): { value: EventPersonFieldChoice; label: string }[] {
  const off = { value: "off" as const, label: "Not asked on this event" };
  if (field === "title") return [off];
  return [off, { value: "optional", label: "Optional on this event" }, { value: "required", label: "Required on this event" }];
}

export function EventPersonFieldChoicesEditor({
  value,
  onChange,
  disabled,
}: {
  value: EventPersonFieldChoices;
  onChange: (next: EventPersonFieldChoices) => void;
  disabled?: boolean;
}) {
  // The ORGANISATION's own switches: what this event is choosing over.
  const organisation = usePersonFields({ organisationOnly: true });

  const set = (field: ConfigurablePersonField, picked: string) => {
    const next = { ...value };
    if (picked === AS_ORGANISATION) delete next[field];
    else next[field] = picked as EventPersonFieldChoice;
    onChange(next);
  };

  return (
    <div className="space-y-3">
      {CONFIGURABLE_PERSON_FIELDS.map((field) => {
        const org = organisation[field];
        const id = `event-person-field-${field}`;
        return (
          <div key={field} className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <Label htmlFor={id} className="w-24 font-normal">
              {NAMES[field]}
            </Label>
            {org.enabled ? (
              <Select value={value[field] ?? AS_ORGANISATION} onValueChange={(picked) => set(field, picked)} disabled={disabled}>
                <SelectTrigger id={id} className="w-72">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AS_ORGANISATION}>As the organisation ({organisationSays(field, org)})</SelectItem>
                  {choicesFor(field).map((choice) => (
                    <SelectItem key={choice.value} value={choice.value}>
                      {choice.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p id={id} className="text-sm text-muted-foreground">
                Not asked: switched off for the whole organisation.
              </p>
            )}
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">
        The organisation-wide switches and the Specialty answers are in{" "}
        <Link href="/settings?tab=form-fields" className="underline underline-offset-2">
          Settings, Form fields
        </Link>
        .
      </p>
    </div>
  );
}
