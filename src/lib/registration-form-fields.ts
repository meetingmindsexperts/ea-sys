/**
 * The optional attendee fields an organiser can leave off the registration
 * form (Oct 26 2026): State, Zip and dietary requirements. Each is shown
 * unless the event's `settings.formFields.<key>` is exactly `false`, so every
 * event saved before this existed keeps its form as it was.
 *
 * Applies to the forms attendees fill in (public registration, complete
 * registration, the self-service edit). Staff forms in the dashboard keep
 * every field: the desk may still need to record a dietary note. The billing
 * State and Zip in the payment step are a separate pair and stay.
 *
 * Pure and dependency-free, so client pages and server routes share it.
 */

export const OPTIONAL_FORM_FIELDS = [
  { key: "state", label: "State / Province" },
  { key: "zipCode", label: "Zip / Postal code" },
  { key: "dietaryReqs", label: "Dietary requirements" },
] as const;

export type OptionalFormField = (typeof OPTIONAL_FORM_FIELDS)[number]["key"];
export type FormFieldVisibility = Record<OptionalFormField, boolean>;

export const ALL_FORM_FIELDS_SHOWN: FormFieldVisibility = { state: true, zipCode: true, dietaryReqs: true };

/** Which optional fields the event's attendee forms show; anything unset or malformed counts as shown. */
export function readFormFields(settings: unknown): FormFieldVisibility {
  const s = settings && typeof settings === "object" ? (settings as Record<string, unknown>) : {};
  const raw = s.formFields && typeof s.formFields === "object" ? (s.formFields as Record<string, unknown>) : {};
  const out = { ...ALL_FORM_FIELDS_SHOWN };
  for (const { key } of OPTIONAL_FORM_FIELDS) out[key] = raw[key] !== false;
  return out;
}

/**
 * Whether the form shows a field, for a page that may hold an older response
 * without `formFields` (shown, as before).
 */
export function showsField(fields: Partial<FormFieldVisibility> | null | undefined, key: OptionalFormField): boolean {
  return fields?.[key] !== false;
}
