/**
 * THE rule for an abstract's presentation types (Nov 24, 2026; plan:
 * docs/ABSTRACT_PRESENTATION_TYPES_PLAN.md).
 *
 * The list belongs to the ORGANISATION (`Organization.settings.presentationTypes`,
 * owner decision D1): an ordered list of `{ key, label, retired }`. Five types
 * are built in and can be renamed and retired, never deleted (D2); the rest are
 * the organisation's own. An abstract stores the KEY, so a rename changes the
 * name everywhere at once and no abstract moves.
 *
 * Each EVENT ticks which types its forms offer
 * (`Event.settings.abstractPresentationTypes`, since July 13, 2026). With
 * nothing ticked it offers the built-in five; a type the organisation added is
 * offered only where it is ticked; a retired type is offered nowhere.
 *
 * Three built-ins carry behaviour, BY KEY, whatever they are called:
 * `ORAL_POSTER` is the author's either-way choice (a reviewer recommends Oral
 * or Poster for it, `recommended-formats.ts`) and `POSTER` decides the poster
 * certificate (`certificates/cert-context.ts`). An organisation's own type has
 * none (D6).
 *
 * **Never keep a list of types or a type's name anywhere else.** A test
 * (`presentation-type-names.test.ts`) refuses a second one: until this day the
 * names lived in four files and had drifted ("Oral Presentation", "Oral",
 * "Oral presentation", "Oral or poster"). The server loads the list with
 * `abstract-presentation-types-server.ts`; a page is sent it by
 * `GET /api/events/{id}/presentation-types` (`usePresentationTypes`).
 *
 * Client-safe: pure, no Prisma import.
 */
import { z } from "zod";

/** The five built-in types, in display order. Their keys are the old enum's values. */
export const BUILT_IN_PRESENTATION_TYPE_KEYS = ["ORAL_POSTER", "ORAL", "POSTER", "VIDEO", "WORKSHOP"] as const;
export type BuiltInPresentationTypeKey = (typeof BUILT_IN_PRESENTATION_TYPE_KEYS)[number];

/** The author's either-way choice: the organiser settles it as Oral or Poster. */
export const EITHER_WAY_TYPE_KEY: BuiltInPresentationTypeKey = "ORAL_POSTER";
/** What the either-way choice stands for when a reviewer recommends a format. */
export const EITHER_WAY_STANDS_FOR: readonly BuiltInPresentationTypeKey[] = ["ORAL", "POSTER"];
/** The type that gets the poster certificate and its tokens. */
export const POSTER_TYPE_KEY: BuiltInPresentationTypeKey = "POSTER";

/** Where the organisation's list is kept (`Organization.settings`). */
export const PRESENTATION_TYPES_SETTING = "presentationTypes";
/**
 * The keys of types the organisation DELETED (`Organization.settings`), never
 * given to a new type (review of 6e04916ec): an event's saved ticks, a row
 * written while the delete ran, or an export may still name a deleted key,
 * and a new type taking it would inherit them.
 */
export const DELETED_PRESENTATION_TYPE_KEYS_SETTING = "presentationTypesDeleted";
/** Where an event's ticks are kept (`Event.settings`). */
export const EVENT_PRESENTATION_TYPES_SETTING = "abstractPresentationTypes";

export const MAX_PRESENTATION_TYPES = 30;
export const MAX_PRESENTATION_TYPE_LABEL = 60;
/** A key: capitals, digits and underscores. Made once from the name, never changed. */
export const PRESENTATION_TYPE_KEY_PATTERN = /^[A-Z0-9][A-Z0-9_]{0,39}$/;
/** Never a type: the reviewer's "Neither" (`recommended-formats.ts`). */
export const RESERVED_PRESENTATION_TYPE_KEYS: readonly string[] = ["NEITHER"];

/**
 * What a door's schema accepts for a type: a key's shape. Whether THIS event
 * offers it is the rule's question (`isPresentationTypeOffered`), asked by the
 * door after parsing, so an organisation's own type needs no schema change.
 */
export const presentationTypeKeySchema = z.string().trim().regex(PRESENTATION_TYPE_KEY_PATTERN, "Not a presentation type");

export interface PresentationTypeDef {
  key: string;
  /** The one name, shown everywhere: forms, lists, emails, exports, certificates. */
  label: string;
  /** Offered on no event; an abstract that holds it keeps it. */
  retired: boolean;
  builtIn: boolean;
}

const BUILT_IN_LABELS: Record<BuiltInPresentationTypeKey, string> = {
  ORAL_POSTER: "Oral or Poster",
  ORAL: "Oral",
  POSTER: "Poster",
  VIDEO: "Video",
  WORKSHOP: "Workshop",
};

const BUILT_IN_KEYS = new Set<string>(BUILT_IN_PRESENTATION_TYPE_KEYS);

export function isBuiltInPresentationType(key: string): key is BuiltInPresentationTypeKey {
  return BUILT_IN_KEYS.has(key);
}

/** The list of an organisation that has never edited it: the five, by their usual names. */
export function defaultPresentationTypes(): PresentationTypeDef[] {
  return BUILT_IN_PRESENTATION_TYPE_KEYS.map((key) => ({ key, label: BUILT_IN_LABELS[key], retired: false, builtIn: true }));
}

/** The deleted keys an organisation keeps (`DELETED_PRESENTATION_TYPE_KEYS_SETTING`); anything malformed is dropped. */
export function readDeletedPresentationTypeKeys(orgSettings: unknown): string[] {
  const raw = orgSettings && typeof orgSettings === "object" ? (orgSettings as Record<string, unknown>)[DELETED_PRESENTATION_TYPE_KEYS_SETTING] : null;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((k): k is string => typeof k === "string" && PRESENTATION_TYPE_KEY_PATTERN.test(k)))];
}

/** A name as stored: trimmed, inner whitespace collapsed. Empty or too long is no name. */
export function cleanPresentationTypeLabel(written: unknown): string | null {
  if (typeof written !== "string") return null;
  const label = written.replace(/\s+/g, " ").trim();
  if (!label || label.length > MAX_PRESENTATION_TYPE_LABEL) return null;
  return label;
}

interface StoredType {
  key: string;
  label: string;
  retired: boolean;
}

function storedTypes(orgSettings: unknown): StoredType[] {
  if (!orgSettings || typeof orgSettings !== "object") return [];
  const raw = (orgSettings as Record<string, unknown>)[PRESENTATION_TYPES_SETTING];
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: StoredType[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { key, label, retired } = item as Record<string, unknown>;
    if (typeof key !== "string" || !PRESENTATION_TYPE_KEY_PATTERN.test(key)) continue;
    if (RESERVED_PRESENTATION_TYPE_KEYS.includes(key) || seen.has(key)) continue;
    const name = cleanPresentationTypeLabel(label);
    if (!name) continue;
    seen.add(key);
    out.push({ key, label: name, retired: retired === true });
  }
  return out;
}

/**
 * The organisation's list, from its `settings` JSON. Never throws and never
 * returns less than the five: a built-in the stored list lost is put back by
 * its usual name, and anything malformed is dropped. Built-ins come first, in
 * their fixed order, then the organisation's own in the order they were added
 * (owner decision D4: no reordering).
 */
export function readPresentationTypes(orgSettings: unknown): PresentationTypeDef[] {
  const stored = storedTypes(orgSettings);
  const byKey = new Map(stored.map((t) => [t.key, t]));
  const builtIns = defaultPresentationTypes().map((def) => {
    const saved = byKey.get(def.key);
    return saved ? { ...def, label: saved.label, retired: saved.retired } : def;
  });
  const own = stored
    .filter((t) => !BUILT_IN_KEYS.has(t.key))
    .slice(0, MAX_PRESENTATION_TYPES - builtIns.length)
    .map((t) => ({ ...t, builtIn: false }));
  return [...builtIns, ...own];
}

/**
 * The name to show for a stored key. A built-in the list does not hold (a page
 * whose list is still loading) shows by its usual name; any other unknown key
 * (a deleted type, a value written by hand) shows as itself: a screen never
 * hides what an abstract holds, and never flashes a raw key while it loads.
 */
export function presentationTypeLabel(types: readonly PresentationTypeDef[], key: string | null | undefined): string {
  if (!key) return "";
  const known = types.find((t) => t.key === key)?.label;
  if (known) return known;
  return isBuiltInPresentationType(key) ? BUILT_IN_LABELS[key] : key;
}

/** Every type's name by its key, retired ones included: for a screen that only shows what is stored. */
export function presentationTypeLabels(types: readonly PresentationTypeDef[]): Record<string, string> {
  return Object.fromEntries(types.map((t) => [t.key, t.label]));
}

function tickedKeys(eventSettings: unknown): string[] | null {
  const raw = (eventSettings as Record<string, unknown> | null | undefined)?.[EVENT_PRESENTATION_TYPES_SETTING];
  if (!Array.isArray(raw)) return null;
  return raw.filter((v): v is string => typeof v === "string");
}

/**
 * The types this event's forms offer, in the list's order:
 *  1. the ones ticked on the event, less any that are retired or gone;
 *  2. with nothing ticked (or nothing ticked that still exists): the built-in
 *     five that are not retired. A type the organisation added is never
 *     offered by default;
 *  3. never empty while any type is live, because the type is required to submit:
 *     with every built-in retired, the live types the organisation added.
 */
export function offeredPresentationTypes(eventSettings: unknown, types: readonly PresentationTypeDef[]): PresentationTypeDef[] {
  const live = types.filter((t) => !t.retired);
  const ticked = tickedKeys(eventSettings);
  if (ticked) {
    const chosen = new Set(ticked);
    const offered = live.filter((t) => chosen.has(t.key));
    if (offered.length > 0) return offered;
  }
  const liveBuiltIns = live.filter((t) => t.builtIn);
  return liveBuiltIns.length > 0 ? liveBuiltIns : live;
}

/** May `key` be newly chosen on this event? (An abstract may always keep the type it has.) */
export function isPresentationTypeOffered(eventSettings: unknown, types: readonly PresentationTypeDef[], key: string): boolean {
  return offeredPresentationTypes(eventSettings, types).some((t) => t.key === key);
}

/** The offered names, for a refusal that tells the caller what it may send. */
export function offeredPresentationTypeNames(eventSettings: unknown, types: readonly PresentationTypeDef[]): string {
  return offeredPresentationTypes(eventSettings, types)
    .map((t) => `${t.label} (${t.key})`)
    .join(", ");
}

export interface PresentationTypeChoice {
  value: string;
  label: string;
}

/**
 * What a form's dropdown lists: the offered types, plus the type the abstract
 * already holds when the event no longer offers it, marked so. Narrowing the
 * offering must never force an unrelated edit to change the type.
 */
export function presentationTypeChoices(
  offered: readonly PresentationTypeDef[],
  types: readonly PresentationTypeDef[],
  current?: string | null,
): PresentationTypeChoice[] {
  // A list still loading (or that failed) offers nothing, rather than marking
  // the abstract's own type "no longer offered".
  if (types.length === 0) return [];
  const choices = offered.map((t) => ({ value: t.key, label: t.label }));
  if (current && !offered.some((t) => t.key === current)) {
    choices.push({ value: current, label: `${presentationTypeLabel(types, current)} (no longer offered)` });
  }
  return choices;
}

/**
 * The list in DECISION order, for a count of what was decided (the Accepted
 * card, the type filter): the either-way choice moves after the last of the
 * two types it stands for, since it counts the abstracts still to be settled
 * one way or the other (owner, Nov 20, 2026: "how many accepted as oral and
 * how many accepted as poster"). Every other surface keeps the list's order.
 */
export function inDecisionOrder(types: readonly PresentationTypeDef[]): PresentationTypeDef[] {
  const either = types.find((t) => t.key === EITHER_WAY_TYPE_KEY);
  if (!either) return [...types];
  const rest = types.filter((t) => t.key !== EITHER_WAY_TYPE_KEY);
  const lastPart = Math.max(...EITHER_WAY_STANDS_FOR.map((k) => rest.findIndex((t) => t.key === k)));
  rest.splice(lastPart + 1, 0, either);
  return rest;
}

/**
 * Which of these types a written name or key means: ONE rule for the CSV import
 * and the assistant (review of 33d5aa63f). In order:
 *   1. a key exactly as written ("CASE_REPORT", what the CSV export writes);
 *   2. a name, ignoring case, spacing and accents (as the editor compares names);
 *   3. the key a written name would have ("case report" for CASE_REPORT), only
 *      when no name matches.
 * A key keeps the name its type was made with, so after a rename the old name
 * may belong to a newer type: where a name and a made key point at different
 * types the text is ambiguous and matches nothing, so the caller refuses it
 * with the list instead of storing the wrong type.
 */
export function matchWrittenPresentationType(written: string, types: readonly PresentationTypeDef[]): PresentationTypeDef | null {
  const text = written.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const exact = types.find((t) => t.key === text);
  if (exact) return exact;
  const byName = types.find((t) => sameName(t.label, text));
  const madeKey = text.toUpperCase().replace(/[\s-]+/g, "_");
  const byMadeKey = types.find((t) => t.key === madeKey);
  if (byName && byMadeKey && byName.key !== byMadeKey.key) return null;
  return byName ?? byMadeKey ?? null;
}

/**
 * The type a written cell names (a CSV import), among the types an event
 * offers, by `matchWrittenPresentationType`. An empty cell is no type; a cell
 * naming a type the event does not offer is refused, never dropped (review of
 * 6e04916ec: the import dropped an organisation's own type without a word, and
 * took a retired one).
 */
export function resolveWrittenPresentationType(
  cell: string | null | undefined,
  offered: readonly PresentationTypeDef[],
): { key: string | null } | { refused: string } {
  const written = cell?.replace(/\s+/g, " ").trim();
  if (!written) return { key: null };
  const match = matchWrittenPresentationType(written, offered);
  return match ? { key: match.key } : { refused: written };
}

/** What `GET /api/events/{id}/presentation-types` sends a page: the whole list, each type marked offered or not. */
export interface EventPresentationType extends PresentationTypeDef {
  offered: boolean;
}

export function eventPresentationTypes(eventSettings: unknown, types: readonly PresentationTypeDef[]): EventPresentationType[] {
  const offered = new Set(offeredPresentationTypes(eventSettings, types).map((t) => t.key));
  return types.map((t) => ({ ...t, offered: offered.has(t.key) }));
}

// ── Changing the list (step 3, Nov 24, 2026) ────────────────────────────────

/** A type as the editor shows it: with how many abstracts and reviews hold it (a type held is retired, never deleted). */
export type PresentationTypeWithUse = PresentationTypeDef & { inUse: number };
// Pure: the service runs one of these on the list it read under the row lock
// and stores what comes back (`storedPresentationTypes`).

export type PresentationTypeChange =
  | { action: "add"; label: string }
  | { action: "rename"; key: string; label: string }
  | { action: "retire"; key: string }
  | { action: "restore"; key: string }
  | { action: "delete"; key: string };

export type PresentationTypeChangeRefusal =
  | "LABEL_INVALID"
  | "LABEL_TAKEN"
  | "TOO_MANY"
  | "NOT_FOUND"
  | "BUILT_IN_NOT_DELETABLE"
  | "IN_USE"
  | "LAST_LIVE_TYPE"
  | "NO_CHANGE";

export type PresentationTypeChangeResult =
  | { ok: true; types: PresentationTypeDef[]; key: string }
  | { ok: false; code: PresentationTypeChangeRefusal; message: string };

/** Two names that read the same: case, accents and spacing are ignored. */
function sameName(a: string, b: string): boolean {
  const fold = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  return fold(a) === fold(b);
}

/**
 * The key a new type gets, made once from its name and never changed: capitals,
 * digits and underscores, no longer than 40, never a built-in's, never NEITHER,
 * never one the list holds, and never a deleted type's (`deletedKeys`).
 */
export function newPresentationTypeKey(label: string, types: readonly PresentationTypeDef[], deletedKeys: readonly string[] = []): string {
  const base =
    label
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 36) || "TYPE";
  const start = /^[A-Z0-9]/.test(base) ? base : `T_${base}`.slice(0, 36);
  const taken = new Set<string>([...types.map((t) => t.key), ...deletedKeys, ...BUILT_IN_PRESENTATION_TYPE_KEYS, ...RESERVED_PRESENTATION_TYPE_KEYS]);
  if (!taken.has(start)) return start;
  for (let n = 2; ; n += 1) {
    const candidate = `${start}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * One change to the list. `inUse` is how many abstracts and reviews hold the
 * key, asked only for a delete: a type that anything holds is retired, never
 * deleted, so no abstract loses its type (owner decision D2).
 */
export function applyPresentationTypeChange(
  types: readonly PresentationTypeDef[],
  change: PresentationTypeChange,
  inUse = 0,
  deletedKeys: readonly string[] = [],
): PresentationTypeChangeResult {
  const refuse = (code: PresentationTypeChangeRefusal, message: string): PresentationTypeChangeResult => ({ ok: false, code, message });
  if (change.action === "add" || change.action === "rename") {
    const label = cleanPresentationTypeLabel(change.label);
    if (!label) return refuse("LABEL_INVALID", `A name is 1 to ${MAX_PRESENTATION_TYPE_LABEL} characters.`);
    const clash = types.find((t) => sameName(t.label, label) && !(change.action === "rename" && t.key === change.key));
    if (clash) return refuse("LABEL_TAKEN", `"${clash.label}" is already a presentation type${clash.retired ? " (retired: restore it instead)" : ""}.`);
    if (change.action === "add") {
      if (types.length >= MAX_PRESENTATION_TYPES) return refuse("TOO_MANY", `An organisation has at most ${MAX_PRESENTATION_TYPES} presentation types.`);
      const key = newPresentationTypeKey(label, types, deletedKeys);
      return { ok: true, key, types: [...types, { key, label, retired: false, builtIn: false }] };
    }
    const target = types.find((t) => t.key === change.key);
    if (!target) return refuse("NOT_FOUND", "That presentation type no longer exists.");
    if (target.label === label) return refuse("NO_CHANGE", "That is already its name.");
    return { ok: true, key: target.key, types: types.map((t) => (t.key === target.key ? { ...t, label } : t)) };
  }

  const target = types.find((t) => t.key === change.key);
  if (!target) return refuse("NOT_FOUND", "That presentation type no longer exists.");
  if (change.action === "restore") {
    if (!target.retired) return refuse("NO_CHANGE", "That presentation type is not retired.");
    return { ok: true, key: target.key, types: types.map((t) => (t.key === target.key ? { ...t, retired: false } : t)) };
  }
  if (change.action === "retire") {
    if (target.retired) return refuse("NO_CHANGE", "That presentation type is already retired.");
    if (types.filter((t) => !t.retired).length <= 1) {
      return refuse("LAST_LIVE_TYPE", "Keep at least one presentation type: authors must choose one to submit.");
    }
    return { ok: true, key: target.key, types: types.map((t) => (t.key === target.key ? { ...t, retired: true } : t)) };
  }
  // delete
  if (target.builtIn) return refuse("BUILT_IN_NOT_DELETABLE", "A built-in presentation type can be renamed or retired, never deleted.");
  if (inUse > 0) {
    return refuse("IN_USE", `${inUse} abstract${inUse === 1 ? "" : "s"} or review${inUse === 1 ? "" : "s"} hold this type. Retire it instead: they keep it, and no event offers it any more.`);
  }
  if (!target.retired && types.filter((t) => !t.retired).length <= 1) {
    return refuse("LAST_LIVE_TYPE", "Keep at least one presentation type: authors must choose one to submit.");
  }
  return { ok: true, key: target.key, types: types.filter((t) => t.key !== target.key) };
}

/** What `Organization.settings.presentationTypes` stores: every type, built-ins included, in order. */
export function storedPresentationTypes(types: readonly PresentationTypeDef[]): Array<{ key: string; label: string; retired: boolean }> {
  return types.map(({ key, label, retired }) => ({ key, label, retired }));
}
