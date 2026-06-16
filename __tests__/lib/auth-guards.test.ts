import { describe, it, expect, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

import { denyReviewer } from "@/lib/auth-guards";

describe("denyReviewer", () => {
  it("returns 403 for REVIEWER role", async () => {
    const result = denyReviewer({ user: { role: "REVIEWER" } });
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    const body = await result!.json();
    expect(body).toEqual({ error: "Forbidden" });
  });

  it("returns 403 for SUBMITTER role", async () => {
    const result = denyReviewer({ user: { role: "SUBMITTER" } });
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    const body = await result!.json();
    expect(body).toEqual({ error: "Forbidden" });
  });

  it("returns 403 for MEMBER role (read-only viewer — no writes)", async () => {
    const result = denyReviewer({ user: { role: "MEMBER" } });
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    expect(await result!.json()).toEqual({ error: "Forbidden" });
  });

  it("returns 403 for REGISTRANT role", async () => {
    const result = denyReviewer({ user: { role: "REGISTRANT" } });
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    expect(await result!.json()).toEqual({ error: "Forbidden" });
  });

  // Contacts write routes (POST/PUT/DELETE/bulk-tags/import/email) route
  // their guard through denyReviewer via { user: { role: ctx.role ?? undefined } }.
  // API-key auth has ctx.role === null → undefined → must pass through
  // (keys are org admin-equivalent; MEMBER cannot mint them).
  it("returns null when role is undefined (API-key auth, admin-equivalent)", () => {
    expect(denyReviewer({ user: { role: undefined } })).toBeNull();
  });

  it("returns null for ADMIN role", () => {
    expect(denyReviewer({ user: { role: "ADMIN" } })).toBeNull();
  });

  it("returns null for SUPER_ADMIN role", () => {
    expect(denyReviewer({ user: { role: "SUPER_ADMIN" } })).toBeNull();
  });

  it("returns null for ORGANIZER role", () => {
    expect(denyReviewer({ user: { role: "ORGANIZER" } })).toBeNull();
  });

  it("returns null for null session", () => {
    expect(denyReviewer(null)).toBeNull();
  });

  it("returns null for session with no user", () => {
    expect(denyReviewer({})).toBeNull();
  });

  it("returns null for session with user but no role", () => {
    expect(denyReviewer({ user: {} })).toBeNull();
  });

  // ONSITE (registration-desk staff) is restricted by default …
  it("returns 403 for ONSITE role by default", async () => {
    const result = denyReviewer({ user: { role: "ONSITE" } });
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    expect(await result!.json()).toEqual({ error: "Forbidden" });
  });

  // … but is let through on the routes it is permitted to write.
  it("returns null for ONSITE when allowed (create / check-in / badges)", () => {
    expect(denyReviewer({ user: { role: "ONSITE" } }, { allow: ["ONSITE"] })).toBeNull();
  });

  it("still blocks other restricted roles even when ONSITE is allowed", () => {
    expect(denyReviewer({ user: { role: "MEMBER" } }, { allow: ["ONSITE"] })).not.toBeNull();
    expect(denyReviewer({ user: { role: "REVIEWER" } }, { allow: ["ONSITE"] })).not.toBeNull();
  });

  it("does not affect privileged roles when an allow-list is passed", () => {
    expect(denyReviewer({ user: { role: "ORGANIZER" } }, { allow: ["ONSITE"] })).toBeNull();
  });
});
