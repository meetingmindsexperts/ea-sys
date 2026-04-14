export const WEBINAR_HIDDEN_MODULES = [
  "Accommodation",
  "Check-In",
  "Promo Codes",
  "Abstracts",
  "Reviewers",
] as const;

export const WEBINAR_HIDDEN_SETTINGS_TABS = [
  "abstract-themes",
  "review-criteria",
] as const;

export function isWebinar(
  event: { eventType?: string | null } | null | undefined,
): boolean {
  return event?.eventType === "WEBINAR";
}

export function webinarModuleFilter(eventType: string | null | undefined) {
  const isWebinarEvent = eventType === "WEBINAR";
  const hidden = new Set<string>(WEBINAR_HIDDEN_MODULES);
  return (item: { name: string; webinarOnly?: boolean }) => {
    if (isWebinarEvent) {
      return !hidden.has(item.name);
    }
    // Non-webinar event: drop items marked webinarOnly
    return !item.webinarOnly;
  };
}

export type WebinarAutoRecording = "none" | "local" | "cloud";

export interface WebinarSettings {
  autoCreated?: boolean;
  sessionId?: string;
  autoProvisionZoom?: boolean;
  defaultPasscode?: string;
  waitingRoom?: boolean;
  autoRecording?: WebinarAutoRecording;
  automationEnabled?: boolean;
}

export function readWebinarSettings(
  settings: unknown,
): WebinarSettings | null {
  if (!settings || typeof settings !== "object") return null;
  const w = (settings as Record<string, unknown>).webinar;
  if (!w || typeof w !== "object") return null;
  return w as WebinarSettings;
}

// ── Sponsors / exhibitors ─────────────────────────────────────────
// Stored as a JSON array on `Event.settings.sponsors`. No dedicated
// Prisma model — this is the escape hatch for rapid iteration. If
// querying or cross-event aggregation becomes a need later, promote
// to a real table without breaking this shape.

export const SPONSOR_TIERS = [
  "platinum",
  "gold",
  "silver",
  "bronze",
  "partner",
  "exhibitor",
] as const;

export type SponsorTier = (typeof SPONSOR_TIERS)[number];

export interface SponsorEntry {
  id: string;
  name: string;
  logoUrl?: string;
  websiteUrl?: string;
  tier?: SponsorTier;
  description?: string;
  sortOrder: number;
}

/**
 * Read the sponsor list off an event's settings JSON. Returns an empty
 * array (not null) when the field is missing so callers can always map
 * over it without a guard.
 */
export function readSponsors(settings: unknown): SponsorEntry[] {
  if (!settings || typeof settings !== "object") return [];
  const raw = (settings as Record<string, unknown>).sponsors;
  if (!Array.isArray(raw)) return [];
  // Shallow-validate each row; drop anything missing the required fields
  // rather than throwing, since old rows could be malformed.
  return raw
    .filter(
      (r): r is SponsorEntry =>
        Boolean(
          r &&
            typeof r === "object" &&
            typeof (r as SponsorEntry).id === "string" &&
            typeof (r as SponsorEntry).name === "string" &&
            typeof (r as SponsorEntry).sortOrder === "number",
        ),
    )
    .sort((a, b) => a.sortOrder - b.sortOrder);
}
