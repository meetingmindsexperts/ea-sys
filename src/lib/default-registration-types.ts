/**
 * The registration types a new event starts with, set PER ORGANISATION in
 * `Organization.settings.defaultRegistrationTypes` (an ordered list of names)
 * and edited on Settings → General. A missing or empty list means a new event
 * starts with none: the names are one customer's (medical) vocabulary, not a
 * platform default.
 *
 * Read only by `event-service.createEvent()`, at the moment an event is
 * created. Existing events and the public registration form never read it.
 * Migration 20261008120000 wrote LEGACY_DEFAULT_REG_TYPE_NAMES into every org
 * that existed then, so MM Group kept the list it had when it was hard-coded.
 */
import { z } from "zod";

export const DEFAULT_REG_TYPES_SETTING = "defaultRegistrationTypes";

export const MAX_DEFAULT_REG_TYPES = 20;
export const MAX_DEFAULT_REG_TYPE_NAME = 100;

/** The list that was hard-coded until Oct 8, 2026; the migration's value. */
export const LEGACY_DEFAULT_REG_TYPE_NAMES = ["Physician", "Allied Health", "Student", "Resident", "Member"];

export const defaultRegistrationTypesSchema = z
  .array(z.string().trim().min(1, "A name cannot be blank").max(MAX_DEFAULT_REG_TYPE_NAME))
  .max(MAX_DEFAULT_REG_TYPES)
  .refine((names) => new Set(names.map((n) => n.toLowerCase())).size === names.length, {
    message: "Each name may appear only once",
  });

/** The org's list from its settings JSON; anything malformed reads as none. */
export function readDefaultRegistrationTypes(settings: unknown): string[] {
  if (!settings || typeof settings !== "object") return [];
  const parsed = defaultRegistrationTypesSchema.safeParse(
    (settings as Record<string, unknown>)[DEFAULT_REG_TYPES_SETTING],
  );
  return parsed.success ? parsed.data : [];
}
