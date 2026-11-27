/**
 * Editing a scheduled TYPED email (PATCH emails/schedule/[id]): the new subject
 * or message is held to the token map as when it was scheduled (review of
 * fa9aede3, Nov 27, 2026). Before, an edit that added a token the audience
 * does not get saved, and the whole send failed when it fired.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth } = vi.hoisted(() => ({
  mockDb: { scheduledEmail: { findFirst: vi.fn(), updateMany: vi.fn() } },
  mockAuth: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, cb: () => unknown) => cb() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4" }));

import { PATCH } from "@/app/api/events/[eventId]/emails/schedule/[id]/route";

const params = { params: Promise.resolve({ eventId: "ev1", id: "sch1" }) };
const patch = (body: Record<string, unknown>) =>
  PATCH(new Request("http://t/api/events/ev1/emails/schedule/sch1", { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), params);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org1", email: "a@x.test" } });
  mockDb.scheduledEmail.findFirst.mockResolvedValue({ emailType: "custom", recipientType: "registrations", customSubject: "Hello", customMessage: "Dear {{firstName}}" });
  mockDb.scheduledEmail.updateMany.mockResolvedValue({ count: 1 });
});

describe("PATCH a scheduled typed email", () => {
  it("refuses an edit that names a token its audience does not get, and writes nothing", async () => {
    const res = await patch({ customMessage: "Your fee is {{honorarium}}" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("TOKENS_NOT_SET");
    expect(body.error).toContain("{{honorarium}} is filled only when sending to speakers");
    expect(mockDb.scheduledEmail.updateMany).not.toHaveBeenCalled();
  });

  it("reads the edited field with the stored other one", async () => {
    mockDb.scheduledEmail.findFirst.mockResolvedValue({ emailType: "custom", recipientType: "registrations", customSubject: "Fee {{honorarium}}", customMessage: "Hi" });
    // The stored subject is already bad; changing only the message does not hide it.
    expect((await patch({ customMessage: "Dear {{firstName}}" })).status).toBe(400);
  });

  it("lets a clean edit, a time-only edit, and another email type through", async () => {
    expect((await patch({ customMessage: "You owe {{amount}}" })).status).not.toBe(400);
    mockDb.scheduledEmail.findFirst.mockResolvedValue({ emailType: "custom", recipientType: "registrations", customSubject: "Old {{honorarium}}", customMessage: "Hi" });
    expect((await patch({ scheduledFor: new Date(Date.now() + 3600_000).toISOString() })).status).not.toBe(400);
    mockDb.scheduledEmail.findFirst.mockResolvedValue({ emailType: "invitation", recipientType: "speakers", customSubject: null, customMessage: null });
    expect((await patch({ customMessage: "A note with {{amount}}" })).status).not.toBe(400);
  });
});
