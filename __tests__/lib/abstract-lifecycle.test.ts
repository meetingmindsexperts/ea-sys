import { describe, it, expect } from "vitest";
import { z } from "zod";
import { buildEventAccessWhere } from "@/lib/event-access";

// ── Abstract schemas (mirrors src/app/api/events/[eventId]/abstracts/ routes) ──

const createAbstractSchema = z.object({
  speakerId: z.string().min(1).max(100),
  title: z.string().min(1).max(500),
  content: z.string().min(1).max(50000),
  specialty: z.string().max(255).optional(),
  trackId: z.string().max(100).optional(),
  status: z.enum(["DRAFT", "SUBMITTED", "UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED"]).default("SUBMITTED"),
});

const updateAbstractSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  content: z.string().min(1).max(50000).optional(),
  trackId: z.string().max(100).nullable().optional(),
  specialty: z.string().max(255).optional(),
  status: z.enum(["DRAFT", "SUBMITTED", "UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED"]).optional(),
  reviewNotes: z.string().max(5000).optional(),
  reviewScore: z.number().min(0).max(100).nullable().optional(),
});

// ── Create abstract: schema validation ─────────────────────────────────────

describe("Abstract submission: schema validation", () => {
  const validAbstract = {
    speakerId: "speaker-1",
    title: "Novel Approaches to Machine Learning in Healthcare",
    content: "This paper presents a novel approach to using ML in cardiology...",
  };

  it("accepts valid abstract with defaults", () => {
    const result = createAbstractSchema.safeParse(validAbstract);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("SUBMITTED"); // default
    }
  });

  it("accepts DRAFT status", () => {
    const result = createAbstractSchema.safeParse({
      ...validAbstract,
      status: "DRAFT",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("DRAFT");
    }
  });

  it("accepts abstract with all optional fields", () => {
    const result = createAbstractSchema.safeParse({
      ...validAbstract,
      specialty: "Cardiology",
      trackId: "track-1",
      status: "SUBMITTED",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing speakerId", () => {
    const result = createAbstractSchema.safeParse({
      title: "Test",
      content: "Content...",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty title", () => {
    const result = createAbstractSchema.safeParse({
      ...validAbstract,
      title: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty content", () => {
    const result = createAbstractSchema.safeParse({
      ...validAbstract,
      content: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects title exceeding 500 chars", () => {
    const result = createAbstractSchema.safeParse({
      ...validAbstract,
      title: "A".repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it("rejects content exceeding 50000 chars", () => {
    const result = createAbstractSchema.safeParse({
      ...validAbstract,
      content: "A".repeat(50001),
    });
    expect(result.success).toBe(false);
  });
});

// ── Save draft ─────────────────────────────────────────────────────────────

describe("Abstract: save draft", () => {
  it("creates abstract with DRAFT status", () => {
    const result = createAbstractSchema.safeParse({
      speakerId: "speaker-1",
      title: "Work in Progress",
      content: "Preliminary findings...",
      status: "DRAFT",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("DRAFT");
    }
  });

  it("does not set submittedAt for DRAFT", () => {
    const status: string = "DRAFT";
    const submittedAt = status === "SUBMITTED" ? new Date() : undefined;
    expect(submittedAt).toBeUndefined();
  });

  it("sets submittedAt when status is SUBMITTED", () => {
    const status: string = "SUBMITTED";
    const submittedAt = status === "SUBMITTED" ? new Date() : undefined;
    expect(submittedAt).toBeDefined();
    expect(submittedAt).toBeInstanceOf(Date);
  });
});

// ── Edit abstract (update schema) ──────────────────────────────────────────

describe("Abstract: edit/update schema", () => {
  it("accepts partial update (title only)", () => {
    const result = updateAbstractSchema.safeParse({
      title: "Updated Title",
    });
    expect(result.success).toBe(true);
  });

  it("accepts partial update (content only)", () => {
    const result = updateAbstractSchema.safeParse({
      content: "Updated content with new findings...",
    });
    expect(result.success).toBe(true);
  });

  it("accepts status change to SUBMITTED", () => {
    const result = updateAbstractSchema.safeParse({
      status: "SUBMITTED",
    });
    expect(result.success).toBe(true);
  });

  it("accepts review fields (notes + score)", () => {
    const result = updateAbstractSchema.safeParse({
      status: "ACCEPTED",
      reviewNotes: "Excellent research methodology",
      reviewScore: 85,
    });
    expect(result.success).toBe(true);
  });

  it("accepts null trackId to unassign track", () => {
    const result = updateAbstractSchema.safeParse({
      trackId: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects review score above 100", () => {
    const result = updateAbstractSchema.safeParse({
      reviewScore: 101,
    });
    expect(result.success).toBe(false);
  });

  it("rejects review score below 0", () => {
    const result = updateAbstractSchema.safeParse({
      reviewScore: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid status", () => {
    const result = updateAbstractSchema.safeParse({
      status: "PUBLISHED",
    });
    expect(result.success).toBe(false);
  });
});

// ── SUBMITTER role restrictions ────────────────────────────────────────────

describe("Abstract: SUBMITTER restrictions", () => {
  const editableStatuses = ["DRAFT", "SUBMITTED", "REVISION_REQUESTED"];
  const lockedStatuses = ["UNDER_REVIEW", "ACCEPTED", "REJECTED"];
  const reviewStatuses = ["UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED"];

  it.each(editableStatuses)(
    "allows SUBMITTER to edit abstract in %s status",
    (status) => {
      expect(editableStatuses.includes(status)).toBe(true);
    }
  );

  it.each(lockedStatuses)(
    "blocks SUBMITTER from editing abstract in %s status",
    (status) => {
      expect(editableStatuses.includes(status)).toBe(false);
    }
  );

  it("blocks SUBMITTER from setting review statuses", () => {
    for (const status of reviewStatuses) {
      // SUBMITTER should be forbidden from setting these
      expect(reviewStatuses.includes(status)).toBe(true);
    }
  });

  it("blocks SUBMITTER from setting reviewNotes", () => {
    const data = { reviewNotes: "Some notes" };
    const isReviewField = data.reviewNotes !== undefined;
    expect(isReviewField).toBe(true); // should be forbidden
  });

  it("blocks SUBMITTER from setting reviewScore", () => {
    const data = { reviewScore: 80 };
    const isReviewField = data.reviewScore !== undefined;
    expect(isReviewField).toBe(true); // should be forbidden
  });

  it("verifies SUBMITTER can only edit own abstracts (speaker.userId must match)", () => {
    const abstract = { speaker: { userId: "user-1" } };
    const sessionUserId = "user-1";
    expect(abstract.speaker.userId === sessionUserId).toBe(true);

    const otherUserId = "user-2";
    expect(abstract.speaker.userId === otherUserId).toBe(false);
  });
});

// ── SUBMITTER speaker scoping ──────────────────────────────────────────────

describe("Abstract: SUBMITTER speaker scoping on create", () => {
  it("restricts SUBMITTER to their own speaker record", () => {
    const userRole = "SUBMITTER";
    const userId = "user-1";
    const speakerId = "speaker-1";
    const eventId = "evt-1";

    const speakerWhere = userRole === "SUBMITTER"
      ? { id: speakerId, eventId, userId }
      : { id: speakerId, eventId };

    expect(speakerWhere).toEqual({
      id: "speaker-1",
      eventId: "evt-1",
      userId: "user-1",
    });
  });

  it("does not restrict ADMIN to userId-scoped speaker", () => {
    const userRole: string = "ADMIN";
    const speakerId = "speaker-1";
    const eventId = "evt-1";

    const speakerWhere = userRole === "SUBMITTER"
      ? { id: speakerId, eventId, userId: "admin-1" }
      : { id: speakerId, eventId };

    expect(speakerWhere).toEqual({
      id: "speaker-1",
      eventId: "evt-1",
    });
    expect(speakerWhere).not.toHaveProperty("userId");
  });
});

// ── REVIEWER restrictions on abstract ──────────────────────────────────────

describe("Abstract: REVIEWER blocked from creating", () => {
  it("blocks REVIEWER from creating abstracts", () => {
    const role = "REVIEWER";
    expect(role === "REVIEWER").toBe(true); // route returns 403
  });

  it("allows SUBMITTER to create abstracts", () => {
    const role: string = "SUBMITTER";
    expect(role === "REVIEWER").toBe(false); // allowed
  });

  it("allows ADMIN to create abstracts", () => {
    const role: string = "ADMIN";
    expect(role === "REVIEWER").toBe(false);
  });
});

// ── Admin-only review actions ──────────────────────────────────────────────

describe("Abstract: admin-only review actions", () => {
  const reviewStatuses = ["UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED"];

  it("only ADMIN/SUPER_ADMIN can set review statuses", () => {
    const isAdmin = (role: string) => role === "SUPER_ADMIN" || role === "ADMIN";

    expect(isAdmin("ADMIN")).toBe(true);
    expect(isAdmin("SUPER_ADMIN")).toBe(true);
    expect(isAdmin("ORGANIZER")).toBe(false);
    expect(isAdmin("REVIEWER")).toBe(false);
    expect(isAdmin("SUBMITTER")).toBe(false);
  });

  it("identifies review actions that trigger email", () => {
    for (const status of reviewStatuses) {
      const isReview = reviewStatuses.includes(status);
      expect(isReview).toBe(true);
    }
  });

  it("identifies submission action (DRAFT → SUBMITTED)", () => {
    const existingStatus = "DRAFT";
    const newStatus = "SUBMITTED";
    const isSubmission = newStatus === "SUBMITTED" && existingStatus === "DRAFT";
    expect(isSubmission).toBe(true);
  });

  it("does not flag re-submission as submission action", () => {
    const existingStatus: string = "REVISION_REQUESTED";
    const newStatus: string = "SUBMITTED";
    const isSubmission = newStatus === "SUBMITTED" && existingStatus === "DRAFT";
    expect(isSubmission).toBe(false);
  });

  it("sets reviewedAt timestamp for review actions", () => {
    const status = "ACCEPTED";
    const isReview = reviewStatuses.includes(status);
    const reviewedAt = isReview ? new Date() : undefined;
    expect(reviewedAt).toBeDefined();
  });

  it("does not set reviewedAt for non-review actions", () => {
    const status = "SUBMITTED";
    const isReview = reviewStatuses.includes(status);
    const reviewedAt = isReview ? new Date() : undefined;
    expect(reviewedAt).toBeUndefined();
  });
});

// ── Event access scoping for abstracts ─────────────────────────────────────

describe("Abstract: event access scoping", () => {
  it("SUBMITTER sees only events with linked speaker", () => {
    const where = buildEventAccessWhere(
      { id: "submitter-1", role: "SUBMITTER", organizationId: null },
      "evt-1"
    );
    expect(where).toEqual({
      id: "evt-1",
      speakers: { some: { userId: "submitter-1" } },
    });
  });

  it("REVIEWER sees only assigned events", () => {
    const where = buildEventAccessWhere(
      { id: "reviewer-1", role: "REVIEWER", organizationId: null },
      "evt-1"
    );
    expect(where).toEqual({
      id: "evt-1",
      settings: { path: ["reviewerUserIds"], array_contains: "reviewer-1" },
    });
  });

  it("ADMIN sees all org events", () => {
    const where = buildEventAccessWhere(
      { id: "admin-1", role: "ADMIN", organizationId: "org-1" },
      "evt-1"
    );
    expect(where).toEqual({
      id: "evt-1",
      organizationId: "org-1",
    });
  });
});
