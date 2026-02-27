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
});
