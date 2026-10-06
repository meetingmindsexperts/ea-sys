export const WEBINAR_HIDDEN_MODULES = [
  "Accommodation",
  "Check-In",
  "Promo Codes",
  "Abstracts",
  "Session Proposals",
  "Reviewers",
] as const;

export const WEBINAR_HIDDEN_SETTINGS_TABS = [
  "abstract-themes",
  "review-criteria",
] as const;

/**
 * Modules hidden from the WEBINARS *role*, whatever the event type.
 *
 * Distinct from WEBINAR_HIDDEN_MODULES above, which is about the event: that
 * list drops Accommodation from a webinar because a webinar has no hotel. This
 * one drops a module the ROLE is not permitted to use at all.
 *
 * The AI Agent is the case in point. `POST /events/[id]/agent/execute` admits
 * only SUPER_ADMIN / ADMIN / ORGANIZER / MEMBER, so a WEBINARS user reaching
 * the page got the full console, suggested commands and all, and a 403 on the
 * first send. The API was right; the nav simply never asked.
 */
export const WEBINARS_ROLE_HIDDEN_MODULES = ["AI Agent"] as const;

export function isWebinar(
  event: { eventType?: string | null } | null | undefined,
): boolean {
  return event?.eventType === "WEBINAR";
}

/**
 * Whether the public call for abstracts is open. A webinar never takes
 * abstracts (its Abstracts module is hidden above), even when the setting is
 * on, e.g. carried over from a cloned conference. ONE rule for the public
 * event payload (the register and login cards) and the submitter signup gate.
 */
export function abstractSubmissionsOpen(event: {
  eventType?: string | null;
  settings?: unknown;
}): boolean {
  if (isWebinar(event)) return false;
  const settings = (event.settings ?? {}) as Record<string, unknown>;
  return settings.allowAbstractSubmissions === true;
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

/**
 * How registered attendees watch the live webinar on our public session page.
 * `zoom` = Zoom Meeting SDK embed (interactive, native Q&A/chat);
 * `hls`  = one-way custom HLS stream via the LivePlayer (scales to 5k via CDN).
 */
export type WebinarViewingMode = "zoom" | "hls";

export interface WebinarSettings {
  autoCreated?: boolean;
  sessionId?: string;
  autoProvisionZoom?: boolean;
  defaultPasscode?: string;
  waitingRoom?: boolean;
  autoRecording?: WebinarAutoRecording;
  automationEnabled?: boolean;
  // ── Waiting room / lobby ────────────────────────────────────────
  /** Which on-page renderer attendees get once the room is opened. */
  viewingMode?: WebinarViewingMode;
  /** YouTube/Vimeo URL looped in the waiting room before the room opens. */
  lobbyVideoUrl?: string;
  /** Custom waiting-room image (uploaded), shown behind the countdown when
   *  no holding video is set. Falls back to the event banner when absent. */
  lobbyImageUrl?: string;
  // ── Attendee page branding (owner, Oct 6, 2026) ─────────────────
  /** Logo shown at the top of the webinar attendee page (replaces the banner). */
  pageLogoUrl?: string;
  /** Full-page background image behind the attendee page and waiting room. */
  pageBackgroundUrl?: string;
  /** Full-width image under the video area (sponsor strip, sign-off). */
  pageFooterImageUrl?: string;
  /** The survey that pops up on the attendee page when the webinar ends, and
   *  whose link goes into the thank-you email (step 4/5 of several surveys). */
  endSurveyId?: string;
  /** Whether the thank-you email carries the end-of-webinar survey link. The
   *  organiser's switch in the Webinar Console; unset means yes, so choosing a
   *  survey sends it unless they turn it off (Oct 6, 2026). */
  thankYouSurveyLink?: boolean;
  /** Attendees may upvote the questions shown to everyone (Oct 6, 2026);
   *  unset means yes. The Webinar Console's Q&A switch. */
  qaUpvote?: boolean;
  /** Files for attendees, in display order (Oct 6, 2026); see
   *  src/lib/webinar/handouts.ts. Written only by the handouts routes. */
  handouts?: import("./webinar/handouts").WebinarHandout[];
  /** Short message shown in the waiting room (e.g. "We'll begin shortly"). */
  lobbyMessage?: string;
  /** ISO time the producer last opened the room. The auto-close job only
   *  trusts a Zoom "ended" time later than this, so an earlier practice run
   *  of the same Zoom webinar can never close today's room (Oct 1, 2026). */
  roomOpenedAt?: string;
}

export function readWebinarSettings(
  settings: unknown,
): WebinarSettings | null {
  if (!settings || typeof settings !== "object") return null;
  const w = (settings as Record<string, unknown>).webinar;
  if (!w || typeof w !== "object") return null;
  return w as WebinarSettings;
}

export interface WebinarPageBranding {
  logoUrl: string | null;
  backgroundUrl: string | null;
  footerImageUrl: string | null;
}

/** An uploaded file (/uploads/…) or an https address: the only image URLs the
 *  webinar settings accept. Shared by the settings save and the public read. */
export function isUploadOrHttpsUrl(value: string): boolean {
  return value.startsWith("/uploads/") || value.startsWith("https://");
}

/**
 * The attendee-page images. A cleared upload (empty string) reads as null, and
 * so does anything that is not an upload or https URL: the general event
 * settings save and clone can write settings.webinar without the webinar
 * route's validation, so the public read checks again (code review, Oct 6).
 */
export function readWebinarPageBranding(settings: unknown): WebinarPageBranding {
  const w = readWebinarSettings(settings);
  const safe = (v: unknown) => (typeof v === "string" && isUploadOrHttpsUrl(v) ? v : null);
  return {
    logoUrl: safe(w?.pageLogoUrl),
    backgroundUrl: safe(w?.pageBackgroundUrl),
    footerImageUrl: safe(w?.pageFooterImageUrl),
  };
}

/**
 * WEBINAR events run in ONE Zoom room (owner decision, Aug 4 2026): every
 * attendee link, the console's Open-the-room, panelists, attendance and the
 * stream are bound to the ANCHOR session. Returns the anchor session id when
 * creating a Zoom meeting on `sessionId` would mint a SECOND room (i.e. the
 * event is a WEBINAR with an anchor that isn't this session) — callers refuse
 * with WEBINAR_ANCHOR_ONLY. Returns null when creation is fine (anchor
 * itself, no anchor yet, or a non-webinar event).
 *
 * ONE implementation for BOTH the REST zoom POST and the MCP
 * create_zoom_meeting executor (the no-cross-caller-duplication rule) — the
 * original guard shipped REST-only and the agent path bypassed it.
 */
export function webinarSecondRoomViolation(
  eventType: string | null | undefined,
  settings: unknown,
  sessionId: string,
): string | null {
  if (eventType !== "WEBINAR") return null;
  const anchorSessionId = readWebinarSettings(settings)?.sessionId;
  return anchorSessionId && anchorSessionId !== sessionId ? anchorSessionId : null;
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
