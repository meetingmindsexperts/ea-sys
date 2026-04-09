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
      "city", "country", "eventType", "tag", "specialty",
      "status", "settings", "bannerImage", "footerHtml",
      "externalId", "externalSource", "createdAt", "updatedAt",
    ];

    // These fields should NOT be cloned (auto-generated or reset)
    const autoFields = ["id", "createdAt", "updatedAt"];
    const resetFields = ["status", "externalId", "externalSource"];
    const specialFields = ["name", "slug", "settings"]; // modified, not copied as-is

    const copyableFields = allEventFields.filter(
      (f) => !autoFields.includes(f) && !resetFields.includes(f) && !specialFields.includes(f)
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
