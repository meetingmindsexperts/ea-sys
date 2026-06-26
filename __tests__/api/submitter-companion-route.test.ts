/**
 * Fix: the public submitter self-registration route created a Speaker with a
 * raw `tx.speaker.create` and never minted the companion registration, so
 * self-registered faculty had no badge / entry barcode / check-in / survey /
 * certificate. This pins that the route now calls ensureSpeakerCompanionRegistration
 * (failure-isolated — a companion hiccup must NOT fail the account create).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, ensureCompanionSpy } = vi.hoisted(() => {
  const tx = {
    user: { create: vi.fn().mockResolvedValue({ id: "u1" }), update: vi.fn().mockResolvedValue({ id: "u1" }) },
    speaker: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "sp1" }),
      update: vi.fn().mockResolvedValue({ id: "sp1" }),
    },
  };
  return {
    mockDb: {
      event: { findFirst: vi.fn() },
      user: { findUnique: vi.fn().mockResolvedValue(null) },
      speaker: { findUnique: vi.fn().mockResolvedValue({ id: "sp1", sourceRegistrationId: null }) },
      $transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
      _tx: tx,
    },
    ensureCompanionSpy: vi.fn().mockResolvedValue({ status: "created", registrationId: "reg1" }),
  };
});

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/security", () => ({
  checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "1.2.3.4",
}));
vi.mock("bcryptjs", () => ({ default: { hash: vi.fn().mockResolvedValue("hashed") } }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  getEventTemplate: vi.fn().mockResolvedValue(null),
  getDefaultTemplate: vi.fn().mockReturnValue({ subject: "s", html: "h", text: "t" }),
  renderAndWrap: vi.fn().mockReturnValue({ subject: "s", html: "h", text: "t" }),
  brandingFrom: vi.fn().mockReturnValue({ email: "f@x.com" }),
  brandingCc: vi.fn().mockReturnValue([]),
}));
vi.mock("@/lib/speaker-companion", () => ({ ensureSpeakerCompanionRegistration: ensureCompanionSpy }));

import { POST } from "@/app/api/public/events/[slug]/submitter/route";

function makeReq(body: Record<string, unknown>) {
  return new Request("http://localhost/api/public/events/ev-slug/submitter", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}
const params = Promise.resolve({ slug: "ev-slug" });
const validBody = {
  title: "DR", role: "ACADEMIA", firstName: "Jane", lastName: "Doe",
  email: "Jane@Example.com", password: "secret123",
  organization: "Acme", jobTitle: "Prof", phone: "+97150", city: "Dubai",
  country: "AE", specialty: "Cardiology",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({
    id: "ev1", name: "Ev", slug: "ev-slug",
    settings: { allowAbstractSubmissions: true }, organizationId: "org1",
  });
  mockDb.user.findUnique.mockResolvedValue(null);
  mockDb.speaker.findUnique.mockResolvedValue({ id: "sp1", sourceRegistrationId: null });
  mockDb._tx.speaker.findUnique.mockResolvedValue(null);
  mockDb._tx.speaker.create.mockResolvedValue({ id: "sp1" });
});

describe("submitter route — companion registration", () => {
  it("mints a companion registration for the new submitter-speaker", async () => {
    const res = await POST(makeReq(validBody), { params });
    expect(res.status).toBeLessThan(400);
    expect(ensureCompanionSpy).toHaveBeenCalledTimes(1);
    expect(ensureCompanionSpy.mock.calls[0][0]).toMatchObject({
      id: "sp1",
      eventId: "ev1",
      email: "jane@example.com", // normalized lowercase
      firstName: "Jane",
      lastName: "Doe",
    });
  });

  it("does not fail the registration if the companion ensure throws (failure-isolated)", async () => {
    ensureCompanionSpy.mockRejectedValueOnce(new Error("boom"));
    const res = await POST(makeReq(validBody), { params });
    expect(res.status).toBeLessThan(400); // account still created
    expect(ensureCompanionSpy).toHaveBeenCalledTimes(1);
  });
});
