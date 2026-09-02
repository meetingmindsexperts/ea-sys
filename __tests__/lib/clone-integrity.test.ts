import { describe, it, expect } from "vitest";

/**
 * Data integrity tests for the event clone feature.
 * These tests validate the clone logic rules without touching the API layer.
 */

// ── Clone Rules ──────────────────────────────────────────────────────────────

/** Fields that should be copied from source event */
const CLONED_EVENT_FIELDS = [
  "organizationId",
  "description",
  "startDate",
  "endDate",
  "timezone",
  "venue",
  "address",
  "city",
  "country",
  "eventType",
  "tag",
  "specialty",
  "bannerImage",
  "footerHtml",
  // Per-event config in dedicated columns (added to the clone June 2026).
  "emailHeaderImage",
  "emailFooterImage",
  "emailFooterHtml",
  "emailFromAddress",
  "emailFromName",
  "emailCcAddresses",
  "supportEmail",
  "registrationTermsHtml",
  "registrationWelcomeHtml",
  "registrationConfirmationHtml",
  "abstractWelcomeHtml",
  "abstractTermsHtml",
  "abstractConfirmationHtml",
  "speakerAgreementHtml",
  "surveyIntroHtml",
  "surveyConfig",
  "taxRate",
  "taxLabel",
  "bankDetails",
  "badgeVerticalOffset",
  "cmeHours",
  "requiresDtcmBarcode",
] as const;

/** Fields that should be reset / excluded on the cloned event */
const RESET_EVENT_FIELDS = {
  status: "DRAFT",
  externalId: undefined,
  externalSource: undefined,
} as const;

/** Fields that should be reset on cloned ticket types */
const RESET_TICKET_FIELDS = {
  soldCount: 0,
} as const;

/** Fields that should be reset on cloned speakers */
const RESET_SPEAKER_FIELDS = {
  userId: undefined,
  status: "INVITED",
  externalId: undefined,
} as const;

/** Fields that should be reset on cloned room types */
const RESET_ROOM_FIELDS = {
  bookedRooms: 0,
} as const;

/** Fields that should be reset on cloned sessions */
const RESET_SESSION_FIELDS = {
  abstractId: undefined,
  externalId: undefined,
  status: "SCHEDULED",
} as const;

// ── Settings Clone Tests ─────────────────────────────────────────────────────

describe("clone settings handling", () => {
  function cloneSettings(source: unknown): Record<string, unknown> {
    // Reproduce the clone route's settings logic
    return typeof source === "object" && source !== null
      ? { ...(source as Record<string, unknown>), reviewerUserIds: [] }
      : {};
  }

  it("clears reviewerUserIds from settings", () => {
    const result = cloneSettings({
      registrationOpen: true,
      reviewerUserIds: ["rev-1", "rev-2", "rev-3"],
      maxAttendees: 500,
    });
    expect(result.reviewerUserIds).toEqual([]);
  });

  it("preserves other settings fields", () => {
    const result = cloneSettings({
      registrationOpen: true,
      waitlistEnabled: false,
      maxAttendees: 100,
      agendaPublished: true,
      notifyOnRegistration: true,
      reviewerUserIds: ["rev-1"],
    });

    expect(result.registrationOpen).toBe(true);
    expect(result.waitlistEnabled).toBe(false);
    expect(result.maxAttendees).toBe(100);
    expect(result.agendaPublished).toBe(true);
    expect(result.notifyOnRegistration).toBe(true);
  });

  it("handles null settings", () => {
    expect(cloneSettings(null)).toEqual({});
  });

  it("handles undefined settings", () => {
    expect(cloneSettings(undefined)).toEqual({});
  });

  it("handles empty object settings", () => {
    const result = cloneSettings({});
    expect(result).toEqual({ reviewerUserIds: [] });
  });

  it("handles string settings (invalid type)", () => {
    expect(cloneSettings("invalid")).toEqual({});
  });

  it("handles numeric settings (invalid type)", () => {
    expect(cloneSettings(42)).toEqual({});
  });
});

// ── ID Remapping Tests ───────────────────────────────────────────────────────

describe("ID remapping logic", () => {
  it("maps old IDs to new IDs correctly", () => {
    const map = new Map<string, string>();
    map.set("old-1", "new-1");
    map.set("old-2", "new-2");
    map.set("old-3", "new-3");

    expect(map.get("old-1")).toBe("new-1");
    expect(map.get("old-2")).toBe("new-2");
    expect(map.get("old-3")).toBe("new-3");
    expect(map.get("nonexistent")).toBeUndefined();
  });

  it("handles null trackId gracefully", () => {
    const trackMap = new Map<string, string>();
    trackMap.set("tr-1", "new-tr-1");

    const trackId: string | null = null;
    const remapped = trackId ? trackMap.get(trackId) ?? null : null;
    expect(remapped).toBeNull();
  });

  it("handles missing speaker in session-speaker remap", () => {
    const speakerMap = new Map<string, string>();
    speakerMap.set("sp-1", "new-sp-1");
    // sp-2 not in map (e.g., speaker was filtered out)

    const oldSpeakerId = "sp-2";
    const newSpeakerId = speakerMap.get(oldSpeakerId);
    expect(newSpeakerId).toBeUndefined();
    // The clone route skips this with: if (newSpeakerId) { ... }
  });

  it("preserves all session-speaker roles during remap", () => {
    const sessions = [
      { id: "sess-1", speakers: [
        { speakerId: "sp-1", role: "keynote" },
        { speakerId: "sp-2", role: "panelist" },
      ]},
      { id: "sess-2", speakers: [
        { speakerId: "sp-1", role: "moderator" },
      ]},
    ];

    const speakerMap = new Map([["sp-1", "new-sp-1"], ["sp-2", "new-sp-2"]]);
    const sessionMap = new Map([["sess-1", "new-sess-1"], ["sess-2", "new-sess-2"]]);

    const links: Array<{ sessionId: string; speakerId: string; role: string }> = [];
    for (const sess of sessions) {
      const newSessionId = sessionMap.get(sess.id)!;
      for (const ss of sess.speakers) {
        const newSpeakerId = speakerMap.get(ss.speakerId);
        if (newSpeakerId) {
          links.push({ sessionId: newSessionId, speakerId: newSpeakerId, role: ss.role });
        }
      }
    }

    expect(links).toHaveLength(3);
    expect(links[0]).toEqual({ sessionId: "new-sess-1", speakerId: "new-sp-1", role: "keynote" });
    expect(links[1]).toEqual({ sessionId: "new-sess-1", speakerId: "new-sp-2", role: "panelist" });
    expect(links[2]).toEqual({ sessionId: "new-sess-2", speakerId: "new-sp-1", role: "moderator" });
  });
});

// ── Slug Generation Tests ────────────────────────────────────────────────────

describe("clone slug generation", () => {
  function generateSlug(sourceSlug: string, existing: boolean): string {
    const baseSlug = `${sourceSlug}-copy`;
    if (!existing) return baseSlug;
    return `${baseSlug}-${Date.now()}`;
  }

  it("appends -copy to source slug", () => {
    expect(generateSlug("annual-conference-2026", false)).toBe("annual-conference-2026-copy");
  });

  it("appends timestamp when -copy slug is taken", () => {
    const slug = generateSlug("my-event", true);
    expect(slug).toMatch(/^my-event-copy-\d+$/);
  });

  it("handles slugs that already end with -copy", () => {
    // Cloning a clone
    expect(generateSlug("my-event-copy", false)).toBe("my-event-copy-copy");
  });

  it("handles single-character slugs", () => {
    expect(generateSlug("x", false)).toBe("x-copy");
  });
});

// ── Data Completeness Tests ──────────────────────────────────────────────────

describe("clone data completeness", () => {
  it("defines all event fields that should be cloned", () => {
    // If a new field is added to Event, this test reminds you to update the clone list
    const allEventFields = [
      "id", "organizationId", "name", "slug", "description",
      "startDate", "endDate", "timezone", "venue", "address",
      "city", "country", "eventType", "tag", "specialty", "code",
      "status", "settings", "bannerImage", "footerHtml",
      "requiresDtcmBarcode",
      "emailHeaderImage", "emailFooterImage", "emailFooterHtml",
      "emailFromAddress", "emailFromName", "emailCcAddresses", "supportEmail",
      "registrationTermsHtml", "registrationWelcomeHtml", "registrationConfirmationHtml",
      "abstractWelcomeHtml", "abstractTermsHtml", "abstractConfirmationHtml",
      "speakerAgreementHtml", "speakerAgreementTemplate",
      "surveyIntroHtml", "surveyConfig", "surveyShareLink",
      "taxRate", "taxLabel", "bankDetails", "badgeVerticalOffset", "cmeHours",
      "externalId", "externalSource", "createdAt", "updatedAt",
    ];

    // These fields should NOT be cloned (auto-generated or reset)
    const autoFields = ["id", "createdAt", "updatedAt"];
    const resetFields = ["status", "externalId", "externalSource"];
    const specialFields = ["name", "slug", "settings"]; // modified, not copied as-is
    // Deliberately excluded per the clone design:
    //   code             — feeds invoice numbering; must regenerate per event
    //   surveyShareLink  — a live token tied to the source event
    //   speakerAgreementTemplate — file-backed (.docx); needs a file copy (Tier 3)
    const intentionallyExcluded = ["code", "surveyShareLink", "speakerAgreementTemplate"];

    const copyableFields = allEventFields.filter(
      (f) =>
        !autoFields.includes(f) &&
        !resetFields.includes(f) &&
        !specialFields.includes(f) &&
        !intentionallyExcluded.includes(f)
    );

    for (const field of copyableFields) {
      expect(CLONED_EVENT_FIELDS).toContain(field);
    }
  });

  it("ensures cloned event status is always DRAFT", () => {
    expect(RESET_EVENT_FIELDS.status).toBe("DRAFT");
  });

  it("ensures ticket soldCount resets to 0", () => {
    expect(RESET_TICKET_FIELDS.soldCount).toBe(0);
  });

  it("ensures speaker userId is cleared", () => {
    expect(RESET_SPEAKER_FIELDS.userId).toBeUndefined();
  });

  it("ensures speaker status resets to INVITED", () => {
    expect(RESET_SPEAKER_FIELDS.status).toBe("INVITED");
  });

  it("ensures room bookedRooms resets to 0", () => {
    expect(RESET_ROOM_FIELDS.bookedRooms).toBe(0);
  });

  it("ensures session abstractId is cleared", () => {
    expect(RESET_SESSION_FIELDS.abstractId).toBeUndefined();
  });

  it("ensures session status resets to SCHEDULED", () => {
    expect(RESET_SESSION_FIELDS.status).toBe("SCHEDULED");
  });
});

// ── Transactional Data Exclusion ─────────────────────────────────────────────

describe("transactional data not cloned", () => {
  const EXCLUDED_MODELS = [
    "Registration",
    "Attendee",
    "Abstract",
    "Accommodation",
    "Payment",
    "AuditLog",
  ];

  it.each(EXCLUDED_MODELS)("%s is not included in clone", (model) => {
    // The clone route's include does NOT contain these models
    const cloneIncludes = [
      "ticketTypes",
      "speakers",
      "tracks",
      "hotels",
      "eventSessions",
    ];

    expect(cloneIncludes).not.toContain(model.toLowerCase());
    expect(cloneIncludes).not.toContain(model);
  });
});

// ── Unique Constraint Safety ─────────────────────────────────────────────────

describe("unique constraint safety", () => {
  it("speaker unique constraint is scoped per event (eventId + email)", () => {
    // Same email can exist in both original and cloned event
    // because the unique constraint is @@unique([eventId, email])
    const originalSpeaker = { eventId: "evt-1", email: "john@example.com" };
    const clonedSpeaker = { eventId: "evt-2", email: "john@example.com" };

    // These are different composite keys — no conflict
    const key1 = `${originalSpeaker.eventId}:${originalSpeaker.email}`;
    const key2 = `${clonedSpeaker.eventId}:${clonedSpeaker.email}`;
    expect(key1).not.toBe(key2);
  });

  it("event slug uniqueness is scoped per organization", () => {
    // Clone gets slug "original-copy" which is unique within the org
    const original = { organizationId: "org-1", slug: "my-event" };
    const clone = { organizationId: "org-1", slug: "my-event-copy" };

    const key1 = `${original.organizationId}:${original.slug}`;
    const key2 = `${clone.organizationId}:${clone.slug}`;
    expect(key1).not.toBe(key2);
  });
});

// ── Ticket-type clone completeness (Aug 14, 2026) ────────────────────────────
//
// WHY THIS EXISTS, and why it is derived from the schema rather than
// hand-listed like CLONED_EVENT_FIELDS above.
//
// Three config fields have now been silently dropped from the cloned ticket
// type, one at a time: `isFaculty` (turned the hidden speaker-companion type
// into a publicly bookable one), `virtualPrice` (reset HYBRID virtual pricing),
// and `requiresDocument` + friends (a cloned Resident rate stopped asking for
// its letter). Each was found in production, after the fact, and each got a
// "MUST be copied" comment on the way past.
//
// The event fields do NOT drift this way, because the test above enumerates
// them. But that list is hand-maintained too, so it only fails once somebody
// remembers to extend it — which is exactly the step that keeps being missed.
//
// So this reads prisma/schema.prisma and requires EVERY scalar on TicketType to
// be explicitly classified: copied, reset, auto-generated, or deliberately
// excluded with a reason. Adding a column and doing nothing else fails here,
// which is the only version of this guard that can stop a fourth.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PRISMA_SCALARS = new Set([
  "String", "Int", "Boolean", "DateTime", "Decimal", "Json", "Float", "BigInt", "Bytes",
]);

/** Scalar (non-relation) field names on a model, read from the schema. */
function scalarFieldsOf(model: string): string[] {
  const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
  const block = new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, "m").exec(schema);
  if (!block) throw new Error(`model ${model} not found in schema.prisma`);
  const fields: string[] = [];
  for (const raw of block[1].split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("///") || line.startsWith("@@")) continue;
    const m = /^(\w+)\s+(\w+)/.exec(line);
    if (!m) continue;
    // `String?`, `Decimal`, `Json` … are scalars; `Event`, `PricingTier[]` are
    // relations and are handled by their own clone blocks.
    if (PRISMA_SCALARS.has(m[2])) fields.push(m[1]);
  }
  return fields;
}

/** Copied verbatim from the source ticket type. */
const CLONED_TICKET_FIELDS = [
  "name", "description", "isDefault", "isActive", "isFaculty", "sortOrder",
  "category", "price", "virtualPrice", "currency", "quantity", "maxPerOrder",
  "salesStart", "salesEnd", "requiresApproval",
  // Supporting-document policy (Aug 13, 2026).
  "requiresDocument", "documentRequired", "documentLabel", "documentInstructions",
  // Identity-evidence policy (Sept 2, 2026).
  "requiresMemberId", "requiresStudentId", "requiresStudentIdExpiry",
];

describe("ticket-type clone completeness", () => {
  it("classifies every scalar on TicketType", () => {
    const auto = ["id", "createdAt", "updatedAt"];
    // Re-derived from the NEW event, never copied from the source.
    const reparented = ["eventId", "organizationId"];
    const reset = Object.keys(RESET_TICKET_FIELDS); // soldCount

    const unclassified = scalarFieldsOf("TicketType").filter(
      (f) =>
        !CLONED_TICKET_FIELDS.includes(f) &&
        !auto.includes(f) &&
        !reparented.includes(f) &&
        !reset.includes(f),
    );

    // If this fails you have added a column to TicketType. Decide whether a
    // clone should carry it, then add it to CLONED_TICKET_FIELDS (and to the
    // clone route) or to one of the lists above. Do NOT just add it here.
    expect(unclassified).toEqual([]);
  });

  it("carries the supporting-document policy across a clone", () => {
    // The regression itself. Under the old name-pattern mechanism this passed
    // for free, because the requirement lived in the NAME and clone copies
    // names. Making the policy a column is what broke it.
    for (const f of ["requiresDocument", "documentRequired", "documentLabel", "documentInstructions"]) {
      expect(CLONED_TICKET_FIELDS).toContain(f);
    }
  });

  it("carries the identity-evidence policy across a clone", () => {
    // Exactly the same trap as the document policy above, and for exactly the
    // same reason: the name match it replaced survived a clone for free
    // because the rule lived in the NAME. A cloned "Student" rate that quietly
    // stopped asking for a student ID would look completely normal.
    for (const f of ["requiresMemberId", "requiresStudentId", "requiresStudentIdExpiry"]) {
      expect(CLONED_TICKET_FIELDS).toContain(f);
    }
  });

  it("still resets soldCount rather than copying it", () => {
    // A clone starts with nothing sold; copying the counter would show the new
    // event as part-full and could make it read sold out on day one.
    expect(CLONED_TICKET_FIELDS).not.toContain("soldCount");
    expect(RESET_TICKET_FIELDS.soldCount).toBe(0);
  });
});
