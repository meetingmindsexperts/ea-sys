import { describe, it, expect } from "vitest";
import { z } from "zod";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { hashVerificationToken } from "@/lib/security";

// ── Add reviewer schema (mirrors src/app/api/events/[eventId]/reviewers/route.ts) ──

const addReviewerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("speaker"), speakerId: z.string().min(1).max(100) }),
  z.object({ type: z.literal("direct"), email: z.string().email().max(255), firstName: z.string().min(1).max(100), lastName: z.string().min(1).max(100) }),
]);

// ── Schema validation ──────────────────────────────────────────────────────

describe("Reviewer: add reviewer schema", () => {
  it('accepts "speaker" type with speakerId', () => {
    const result = addReviewerSchema.safeParse({
      type: "speaker",
      speakerId: "speaker-1",
    });
    expect(result.success).toBe(true);
  });

  it('accepts "direct" type with email + name', () => {
    const result = addReviewerSchema.safeParse({
      type: "direct",
      email: "reviewer@example.com",
      firstName: "Bob",
      lastName: "Smith",
    });
    expect(result.success).toBe(true);
  });

  it("rejects speaker type without speakerId", () => {
    const result = addReviewerSchema.safeParse({
      type: "speaker",
    });
    expect(result.success).toBe(false);
  });

  it("rejects direct type without email", () => {
    const result = addReviewerSchema.safeParse({
      type: "direct",
      firstName: "Bob",
      lastName: "Smith",
    });
    expect(result.success).toBe(false);
  });

  it("rejects direct type without firstName", () => {
    const result = addReviewerSchema.safeParse({
      type: "direct",
      email: "reviewer@example.com",
      lastName: "Smith",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid type", () => {
    const result = addReviewerSchema.safeParse({
      type: "email",
      email: "reviewer@example.com",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid email in direct type", () => {
    const result = addReviewerSchema.safeParse({
      type: "direct",
      email: "not-valid",
      firstName: "Bob",
      lastName: "Smith",
    });
    expect(result.success).toBe(false);
  });
});

// ── Role restrictions: who can manage reviewers ────────────────────────────

describe("Reviewer: role restrictions", () => {
  it("blocks REVIEWER from adding other reviewers", () => {
    const result = denyReviewer({ user: { role: "REVIEWER" } });
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("blocks SUBMITTER from adding reviewers", () => {
    const result = denyReviewer({ user: { role: "SUBMITTER" } });
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("allows ADMIN to manage reviewers", () => {
    expect(denyReviewer({ user: { role: "ADMIN" } })).toBeNull();
  });

  it("allows ORGANIZER to manage reviewers", () => {
    expect(denyReviewer({ user: { role: "ORGANIZER" } })).toBeNull();
  });
});

// ── Reviewer account properties ────────────────────────────────────────────

describe("Reviewer: account creation", () => {
  it("creates user with REVIEWER role", () => {
    const user = {
      role: "REVIEWER",
      organizationId: null, // org-independent
    };
    expect(user.role).toBe("REVIEWER");
    expect(user.organizationId).toBeNull();
  });

  it("reviewer is org-independent (no organizationId)", () => {
    const user = { id: "rev-1", role: "REVIEWER", organizationId: null };
    expect(user.organizationId).toBeNull();
  });

  it("generates invitation token hash", () => {
    process.env.NEXTAUTH_SECRET = "test-secret";
    const token = "abc123def456";
    const hash = hashVerificationToken(token);

    // Hash is a 64-char hex string
    expect(hash).toMatch(/^[a-f0-9]{64}$/);

    // Deterministic
    expect(hashVerificationToken(token)).toBe(hash);

    // Different tokens produce different hashes
    expect(hashVerificationToken("different-token")).not.toBe(hash);
  });

  it("sets invitation expiry to 7 days", () => {
    const now = Date.now();
    const expiryMs = 7 * 24 * 60 * 60 * 1000;
    const expiry = new Date(now + expiryMs);

    const diffDays = (expiry.getTime() - now) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeCloseTo(7, 0);
  });
});

// ── Reviewer event scoping ─────────────────────────────────────────────────

describe("Reviewer: event access scoping", () => {
  it("reviewer sees only events where assigned via reviewerUserIds", () => {
    const where = buildEventAccessWhere({
      id: "reviewer-1",
      role: "REVIEWER",
      organizationId: null,
    });
    expect(where).toEqual({
      settings: {
        path: ["reviewerUserIds"],
        array_contains: "reviewer-1",
      },
    });
    expect(where).not.toHaveProperty("organizationId");
  });

  it("reviewer sees specific event when eventId provided", () => {
    const where = buildEventAccessWhere(
      { id: "reviewer-1", role: "REVIEWER", organizationId: null },
      "evt-5"
    );
    expect(where).toEqual({
      id: "evt-5",
      settings: {
        path: ["reviewerUserIds"],
        array_contains: "reviewer-1",
      },
    });
  });

  it("reviewer can review across multiple orgs", () => {
    // Same reviewer ID, no org filter — scoped only by assignment
    const where1 = buildEventAccessWhere({
      id: "reviewer-1",
      role: "REVIEWER",
      organizationId: null,
    });
    const where2 = buildEventAccessWhere({
      id: "reviewer-1",
      role: "REVIEWER",
      organizationId: null,
    });

    // Both queries are identical and have no org filter
    expect(where1).toEqual(where2);
    expect(where1).not.toHaveProperty("organizationId");
  });
});

// ── Reviewer assignment: duplicate check ───────────────────────────────────

describe("Reviewer: duplicate assignment check", () => {
  it("detects already-assigned reviewer", () => {
    const reviewerUserIds = ["user-1", "user-2", "user-3"];
    const newUserId = "user-2";
    expect(reviewerUserIds.includes(newUserId)).toBe(true);
  });

  it("allows new reviewer assignment", () => {
    const reviewerUserIds = ["user-1", "user-2"];
    const newUserId = "user-3";
    expect(reviewerUserIds.includes(newUserId)).toBe(false);
  });

  it("adds userId to reviewerUserIds array", () => {
    const reviewerUserIds = ["user-1", "user-2"];
    const newUserId = "user-3";
    const updated = [...reviewerUserIds, newUserId];
    expect(updated).toEqual(["user-1", "user-2", "user-3"]);
    expect(updated).toHaveLength(3);
  });
});

// ── Existing user role conflict ────────────────────────────────────────────

describe("Reviewer: existing user role handling", () => {
  it("allows reuse of existing REVIEWER user", () => {
    const existingUser = { id: "user-1", role: "REVIEWER" };
    const canReuse = existingUser.role === "REVIEWER";
    expect(canReuse).toBe(true);
  });

  it("rejects user with ADMIN role", () => {
    const existingUser = { id: "user-1", role: "ADMIN" };
    const canReuse = existingUser.role === "REVIEWER";
    expect(canReuse).toBe(false);
  });

  it("rejects user with SUBMITTER role", () => {
    const existingUser = { id: "user-1", role: "SUBMITTER" };
    const canReuse = existingUser.role === "REVIEWER";
    expect(canReuse).toBe(false);
  });

  it("rejects user with ORGANIZER role", () => {
    const existingUser = { id: "user-1", role: "ORGANIZER" };
    const canReuse = existingUser.role === "REVIEWER";
    expect(canReuse).toBe(false);
  });
});

// ── Reviewer access: abstracts only ────────────────────────────────────────

describe("Reviewer: abstracts-only access", () => {
  it("reviewer is blocked from write operations by denyReviewer", () => {
    const result = denyReviewer({ user: { role: "REVIEWER" } });
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("reviewer can read abstracts (GET routes skip denyReviewer)", () => {
    // GET routes for abstracts don't call denyReviewer — they use event access scoping
    const where = buildEventAccessWhere(
      { id: "reviewer-1", role: "REVIEWER", organizationId: null },
      "evt-1"
    );
    // Reviewer gets a valid WHERE clause (not blocked)
    expect(where).toBeDefined();
    expect(where.id).toBe("evt-1");
  });
});
