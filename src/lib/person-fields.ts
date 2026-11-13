/**
 * The fields about a person whose label and answers belong to the
 * ORGANISATION (Nov 13, 2026; step 1a of docs/ORG_FIELDS_PLAN.md): Title,
 * Role and Specialty.
 *
 * Until now the answers were fixed in source: a list of 44 medical
 * specialties in a client component, the role list typed out in seven files,
 * and five titles. An organisation in another industry cannot use them. This
 * module is the one place that says what an organisation asks:
 *
 *   - `Organization.settings.personFields` holds, for each field, whether it
 *     is asked at all, its label, its answers and whether "Others" with free
 *     text is offered;
 *   - **nothing saved means today's form**: the defaults below are the lists
 *     as they stood, so reading through this module changes nothing for an
 *     organisation that has saved nothing.
 *
 * Wired today (Nov 13, 2026): the Specialty ANSWERS. Settings, Form fields
 * saves them (src/services/person-field-service.ts), and every specialty
 * picker reads the organisation's list (src/hooks/use-person-fields.ts).
 * Not yet: the field's label and its on/off switch are stored and read but no
 * form obeys them, Title and Role still offer their fixed lists, and Role is
 * still a fixed database list (docs/ORG_FIELDS_PLAN.md, the later slices).
 *
 * Pure and client-safe: no database import. The server reads the setting and
 * hands the parsed result to whoever needs it.
 */
import { ATTENDEE_ROLE_LABELS, ATTENDEE_ROLE_ORDER } from "@/lib/schemas";

export const PERSON_FIELDS_SETTING = "personFields";

export const CONFIGURABLE_PERSON_FIELDS = ["title", "role", "specialty"] as const;
export type ConfigurablePersonField = (typeof CONFIGURABLE_PERSON_FIELDS)[number];

/** The answer that asks for free text beside it, where a field allows one. */
export const OTHER_ANSWER = "Others";

export const MAX_PERSON_FIELD_OPTIONS = 200;
export const MAX_PERSON_FIELD_LABEL = 60;
export const MAX_PERSON_FIELD_ANSWER = 100;

export interface PersonFieldOption {
  /** What is stored. It never changes once an answer exists. */
  key: string;
  /** What people see. */
  label: string;
  /** No longer offered; kept so a stored answer still reads correctly. */
  retired: boolean;
}

export interface PersonFieldConfig {
  /** Whether the organisation asks this field at all. */
  enabled: boolean;
  label: string;
  options: PersonFieldOption[];
  /** Offer "Others", which demands the free text beside it. */
  allowOther: boolean;
}

export type PersonFieldsConfig = Record<ConfigurablePersonField, PersonFieldConfig>;

const option = (key: string, label: string): PersonFieldOption => ({ key, label, retired: false });

/** The specialties offered until now, in their order. Stored as the text itself. */
const DEFAULT_SPECIALTIES = [
  "Anesthesia & Pain Medicine",
  "Cardiology",
  "Clinical Simulation",
  "Critical Care",
  "Dental",
  "Dermatology",
  "Diabetes",
  "Emergency Medicine",
  "Endocrinology",
  "Endoscopy",
  "Family Medicine",
  "Gastroenterology",
  "General Practice",
  "Genetics",
  "Health Economics",
  "Hematology",
  "Hepatology",
  "Immunology",
  "Infectious Disease",
  "Internal Medicine",
  "Laboratory",
  "Medical Education",
  "Nephrology",
  "Neurology",
  "Nursing",
  "Obstetrics & Gynecology",
  "Oncology",
  "Ophthalmology",
  "Orthopedics",
  "Otolaryngology",
  "Parenteral Nutrition",
  "Pathology",
  "Pediatrics",
  "Pediatric Rehabilitation",
  "Pharmacy",
  "Preventative Medicine",
  "Psychiatry",
  "Public Health",
  "Radiology",
  "Rheumatology",
  "Respiratory Medicine",
  "Surgery",
  "Thalassemia",
  "Urology",
] as const;

/** Today's form: what every organisation gets until it saves its own. */
export function defaultPersonFields(): PersonFieldsConfig {
  return {
    title: {
      enabled: true,
      label: "Title",
      options: [option("DR", "Dr."), option("MR", "Mr."), option("MRS", "Mrs."), option("MS", "Ms."), option("PROF", "Prof.")],
      allowOther: false,
    },
    role: {
      enabled: true,
      label: "Role",
      options: ATTENDEE_ROLE_ORDER.map((key) => option(key, ATTENDEE_ROLE_LABELS[key])),
      allowOther: false,
    },
    specialty: {
      enabled: true,
      label: "Specialty",
      options: DEFAULT_SPECIALTIES.map((text) => option(text, text)),
      allowOther: true,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One saved answer, or null when it is not one. Keys and labels are trimmed; a blank or oversized one is refused. */
function readOption(raw: unknown): PersonFieldOption | null {
  if (!isRecord(raw)) return null;
  const key = typeof raw.key === "string" ? raw.key.trim() : "";
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  if (!key || !label || key.length > MAX_PERSON_FIELD_ANSWER || label.length > MAX_PERSON_FIELD_ANSWER) return null;
  return { key, label, retired: raw.retired === true };
}

/**
 * One field as the organisation saved it, or the default when what is saved
 * is not usable. A field is all or nothing: a half-readable setting falls back
 * whole, so a form never shows a list missing the answers that failed to read.
 */
function readField(raw: unknown, fallback: PersonFieldConfig): PersonFieldConfig {
  if (!isRecord(raw)) return fallback;
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  if (!label || label.length > MAX_PERSON_FIELD_LABEL) return fallback;
  if (!Array.isArray(raw.options) || raw.options.length > MAX_PERSON_FIELD_OPTIONS) return fallback;
  const options = raw.options.map(readOption);
  if (options.some((o) => o === null)) return fallback;
  const read = options as PersonFieldOption[];
  if (new Set(read.map((o) => o.key)).size !== read.length) return fallback;
  return { enabled: raw.enabled !== false, label, options: read, allowOther: raw.allowOther === true };
}

/** What the organisation asks about a person. Nothing saved, or nothing readable, is today's form. */
export function readPersonFields(orgSettings: unknown): PersonFieldsConfig {
  const defaults = defaultPersonFields();
  const saved = isRecord(orgSettings) && isRecord(orgSettings[PERSON_FIELDS_SETTING]) ? orgSettings[PERSON_FIELDS_SETTING] : {};
  return {
    title: readField(saved.title, defaults.title),
    role: readField(saved.role, defaults.role),
    specialty: readField(saved.specialty, defaults.specialty),
  };
}

/** The answers a form offers now: retired ones left out, "Others" last where the field allows it. */
export function offeredAnswers(field: PersonFieldConfig): PersonFieldOption[] {
  const live = field.options.filter((o) => !o.retired);
  return field.allowOther ? [...live, option(OTHER_ANSWER, OTHER_ANSWER)] : live;
}

/**
 * What to show for a stored answer: its label, retired or not. A value that is
 * not on the list is shown as it is: Specialty was never checked against its
 * list, and the contacts hold more specialties than the list ever offered.
 */
export function answerLabel(field: PersonFieldConfig, stored: string | null | undefined): string {
  if (!stored) return "";
  return field.options.find((o) => o.key === stored)?.label ?? stored;
}

/**
 * What a form needs of a field, and nothing more: safe to hand to a public
 * page. Retired answers are left out; "Others" is the last answer where the
 * field allows it.
 */
export interface PublicPersonField {
  enabled: boolean;
  label: string;
  answers: { key: string; label: string }[];
}
export type PublicPersonFields = Record<ConfigurablePersonField, PublicPersonField>;

export function publicPersonFields(config: PersonFieldsConfig): PublicPersonFields {
  const one = (field: PersonFieldConfig): PublicPersonField => ({
    enabled: field.enabled,
    label: field.label,
    answers: offeredAnswers(field).map(({ key, label }) => ({ key, label })),
  });
  return { title: one(config.title), role: one(config.role), specialty: one(config.specialty) };
}

/** Today's form, as a public page gets it while the organisation's own is loading or cannot be read. */
export const DEFAULT_PUBLIC_PERSON_FIELDS: PublicPersonFields = publicPersonFields(defaultPersonFields());

/** Whether a NEWLY chosen answer is one the field offers. A stored answer is never judged by this. */
export function isOfferedAnswer(field: PersonFieldConfig, chosen: string): boolean {
  return offeredAnswers(field).some((o) => o.key === chosen);
}
