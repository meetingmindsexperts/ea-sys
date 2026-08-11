import { describe, it, expect } from "vitest";
import {
  EVENT_LIST_SELECT,
  EVENT_LIST_COUNT_SELECT,
  RESTRICTED_EVENT_DETAIL_SELECT,
  RESTRICTED_SETTINGS_KEYS,
  eventListSelect,
  pickRestrictedSettings,
} from "@/lib/event-visibility";
import { TEAM_ROLES } from "@/lib/auth-guards";

/**
 * The events list and the event detail are shared by organisers and by org-null
 * roles (reviewer / submitter / registrant). Both used to query with a bare
 * `include`, so everyone received the organiser payload: headcounts, the
 * settings JSON, the internal CC list, badge and seat configuration.
 *
 * These assert on the SELECT, not on rendering, because the fix is that the
 * data is never fetched. Hiding a column in CSS would leave it in the payload.
 */
describe("event field visibility", () => {
  it("every team role gets the headcounts", () => {
    for (const role of TEAM_ROLES) {
      expect(eventListSelect(role)).toHaveProperty("_count");
    }
  });

  it.each(["REVIEWER", "SUBMITTER", "REGISTRANT", null, undefined])(
    "an org-null role (%s) gets NO headcounts",
    (role) => {
      expect(eventListSelect(role as string | null | undefined)).not.toHaveProperty("_count");
    },
  );

  it("fails closed: an unrecognised role is treated as untrusted", () => {
    // The default matters more than the listed cases. A role added later and
    // forgotten here must lose the counts, not inherit them.
    expect(eventListSelect("FUTURE_ROLE")).toEqual(EVENT_LIST_SELECT);
  });

  it("the detail view is the list view plus guidance, never a second hand-written list", () => {
    // Derivation is the point: if these ever diverge, someone has re-typed the
    // column set and the two views can drift.
    for (const key of Object.keys(EVENT_LIST_SELECT)) {
      expect(RESTRICTED_EVENT_DETAIL_SELECT).toHaveProperty(key);
    }
    expect(Object.keys(RESTRICTED_EVENT_DETAIL_SELECT).length).toBeGreaterThan(
      Object.keys(EVENT_LIST_SELECT).length,
    );
  });

  it("selects only event facts in the list", () => {
    // `eventType` joined on Aug 10, 2026: the list has to know a row's type to
    // send the WEBINARS role to the right landing page. Not sensitive — the
    // public event API already returns it.
    expect(Object.keys(EVENT_LIST_SELECT).sort()).toEqual([
      "description", "endDate", "eventType", "id", "name", "slug", "startDate",
      "status", "timezone", "venue",
    ]);
    expect(EVENT_LIST_SELECT).not.toHaveProperty("_count");
  });

  it("keeps the count select separate so it can be withheld", () => {
    expect(EVENT_LIST_COUNT_SELECT).toEqual({
      _count: { select: { registrations: true, speakers: true } },
    });
  });

  it("the detail view selects no finance, branding or operational columns", () => {
    for (const column of [
      "bankDetails", "taxRate", "taxLabel", "emailCcAddresses", "emailFooterHtml",
      "surveyConfig", "badgeVerticalOffset", "requiresDtcmBarcode", "maxAttendees",
      "seatCount", "speakerAgreementTemplate", "registrationTermsHtml",
    ]) {
      expect(RESTRICTED_EVENT_DETAIL_SELECT).not.toHaveProperty(column);
    }
  });
});

describe("the settings a restricted role receives", () => {
  /**
   * An exact list, not a minimum: adding a key here is a decision to show an
   * org-null role something, so it should be a deliberate edit to this test
   * rather than something that slips in. `abstractLimits` was added Aug 11,
   * 2026 after a real bug (see the consumer-side block at the bottom of this
   * file).
   */
  it("keeps only the keys their forms read", () => {
    expect([...RESTRICTED_SETTINGS_KEYS].sort()).toEqual([
      "abstractLimits",
      "abstractPresentationTypes",
      "sessionProposalDeadline",
    ]);
  });

  it("drops organiser configuration, including the pointed ones", () => {
    const picked = pickRestrictedSettings({
      abstractPresentationTypes: ["ORAL"],
      sessionProposalDeadline: "2026-09-01T00:00:00.000Z",
      // Who is scoring this submitter's work.
      reviewerUserIds: ["user_reviewer_1"],
      onsiteUserIds: ["user_desk_1"],
      // A live token.
      surveyShareLink: { token: "secret-token", expiresAt: "2026-12-01" },
      sponsors: [{ name: "Acme", tier: "gold" }],
      webinar: { sessionId: "sess_1" },
      groupRegistration: { enabled: true, max: 50 },
    });

    expect(picked).toEqual({
      abstractPresentationTypes: ["ORAL"],
      sessionProposalDeadline: "2026-09-01T00:00:00.000Z",
    });
  });

  it("is a whitelist, so a key added later is invisible by default", () => {
    expect(pickRestrictedSettings({ somethingAddedNextYear: "value" })).toBeNull();
  });

  it("returns null for absent or malformed settings", () => {
    expect(pickRestrictedSettings(null)).toBeNull();
    expect(pickRestrictedSettings(undefined)).toBeNull();
    expect(pickRestrictedSettings("not-an-object")).toBeNull();
    expect(pickRestrictedSettings([])).toBeNull();
  });
});

/**
 * The settings whitelist has to carry every key a submitter-facing form reads
 * (Aug 11, 2026, organizer-reported).
 *
 * THE BUG: `abstractLimits` was missing. The whitelist did exactly what it was
 * built to do, which is withhold a key nobody had explicitly allowed, and that
 * was wrong for this one: the limits are the RULES the submitter must follow,
 * and the API enforces them. So a form fell back to the defaults and let
 * someone add 20 co-authors on an event capped at 5, and the save then 400'd.
 * A form that permits what the API refuses is worse than one showing a stale
 * number.
 *
 * The general shape is a guard that is correct by default and wrong for a
 * specific case, which no test of the guard itself can catch. So this test
 * asserts from the CONSUMER side: it lists the accessors a submitter page
 * calls against `event.settings` and checks each one's key is allowed. Add an
 * accessor to a submitter form, add it here.
 */
describe("RESTRICTED_SETTINGS_KEYS covers what submitter forms read", () => {
  /**
   * Every `readX(event?.settings)` on a page an org-null role can open, with
   * the settings key it looks for.
   */
  const SUBMITTER_FORM_READS: { key: string; why: string }[] = [
    { key: "abstractPresentationTypes", why: "presentation-type picker on the abstract form" },
    { key: "abstractLimits", why: "word + co-author counters and the submit guard" },
    { key: "sessionProposalDeadline", why: "client-side deadline gate on the proposal form" },
  ];

  it.each(SUBMITTER_FORM_READS)("allows $key ($why)", ({ key }) => {
    expect(RESTRICTED_SETTINGS_KEYS as readonly string[]).toContain(key);
  });

  it("passes the limits through so the form agrees with the API", () => {
    const picked = pickRestrictedSettings({
      abstractLimits: { maxCoAuthors: 5, maxTitleWords: 12 },
      reviewerUserIds: ["u1"],
      surveyShareLink: { token: "secret" },
    });
    expect(picked?.abstractLimits).toEqual({ maxCoAuthors: 5, maxTitleWords: 12 });
  });

  /** The two pointed exclusions the whitelist exists for, still excluded. */
  it("still withholds reviewer identities and the survey token", () => {
    const picked = pickRestrictedSettings({
      abstractLimits: { maxCoAuthors: 5 },
      reviewerUserIds: ["u1"],
      surveyShareLink: { token: "secret" },
      emailCcAddresses: ["internal@x.com"],
    });
    expect(picked).not.toHaveProperty("reviewerUserIds");
    expect(picked).not.toHaveProperty("surveyShareLink");
    expect(picked).not.toHaveProperty("emailCcAddresses");
  });
});
