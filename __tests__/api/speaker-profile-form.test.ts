/**
 * Speaker profile form (Aug 4, 2026) — the public token form where a speaker
 * submits their photo + passport copy (+ optional cover letter) + bio, and
 * the organizer route that mints + emails the link from the speaker page.
 *
 * Public submit pins: token 404, submitted-lock 409, the photo/passport
 * completeness gates (server-side — the form is a bypassable client), the
 * conditional PENDING→SUBMITTED claim (two tabs race to ONE submission), the
 * bio write + audit + admin notify.
 *
 * Organizer route pins: real denyReviewer RBAC, mint-once token semantics,
 * the EmailLog slug (Email History parity), send failure surfaced as 502,
 * reopen semantics.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockLoad, mockResolveOrg, sendEmailSpy, notifySpy, rateLimitSpy } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    speaker: { findFirst: vi.fn(), update: vi.fn() },
    speakerProfileForm: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    user: { findUnique: vi.fn() },
    auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
  },
  mockAuth: vi.fn(),
  mockLoad: vi.fn(),
  mockResolveOrg: vi.fn(),
  sendEmailSpy: vi.fn(),
  notifySpy: vi.fn().mockReturnValue({ catch: () => {} }),
  rateLimitSpy: vi.fn().mockReturnValue({ allowed: true, retryAfterSeconds: 0 }),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({
  db: mockDb,
  tenantTransaction: (fn: (tx: unknown) => unknown) => fn(mockDb),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/security", () => ({
  getClientIp: () => "1.2.3.4",
  checkRateLimit: rateLimitSpy,
}));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: notifySpy }));
vi.mock("@/lib/event-access", () => ({
  buildEventAccessWhere: (_u: unknown, id: string) => ({ id, organizationId: "org1" }),
}));
vi.mock("@/lib/speaker-profile/server", () => ({
  generateProfileFormToken: () => "tok_generated",
  resolveProfileFormEventOrg: (...a: unknown[]) => mockResolveOrg(...a),
  loadProfileFormForSlug: (...a: unknown[]) => mockLoad(...a),
}));
vi.mock("@/lib/email", () => ({
  sendEmail: sendEmailSpy,
  getEventTemplate: vi.fn(async () => ({
    subject: "Your photo & documents — {{eventName}}",
    htmlContent: "<p>{{speakerName}} {{profileFormLink}}</p>",
    textContent: "{{profileFormLink}}",
    branding: { eventName: "Ev" },
  })),
  renderAndWrap: (tpl: { subject: string; htmlContent: string; textContent: string }, vars: Record<string, string>) => ({
    subject: tpl.subject.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? ""),
    htmlContent: tpl.htmlContent.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? ""),
    textContent: tpl.textContent.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? ""),
  }),
  renderMessageValue: (m: string) => m,
  brandingFrom: () => undefined,
  brandingCc: () => undefined,
}));

import { POST as PUBLIC_SUBMIT } from "@/app/api/public/events/[slug]/speaker-form/[token]/route";
import { GET, POST as SEND, PATCH } from "@/app/api/events/[eventId]/speakers/[speakerId]/profile-form/route";

const publicParams = { params: Promise.resolve({ slug: "medcon", token: "tok1" }) };
const staffParams = { params: Promise.resolve({ eventId: "ev1", speakerId: "sp1" }) };
const jsonReq = (body: unknown) =>
  new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

const baseRow = {
  id: "form1",
  eventId: "ev1",
  status: "PENDING",
  submittedAt: null,
  speaker: {
    id: "sp1",
    title: "DR",
    firstName: "Amina",
    lastName: "Khan",
    email: "amina@x.com",
    photo: "/uploads/photos/2026/08/a.jpg",
    bio: null,
    organization: "Org",
    jobTitle: "Consultant",
    documents: [{ id: "d1", label: "Passport copy", filename: "p.pdf", size: 100, createdAt: new Date() }],
  },
  event: {
    id: "ev1",
    slug: "medcon",
    name: "MedCon",
    organizationId: "org1",
    bannerImage: null,
    bannerImageMobile: null,
    startDate: new Date(),
    endDate: new Date(),
    timezone: "Asia/Dubai",
    venue: null,
    city: null,
    organization: { name: "MMG" },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  rateLimitSpy.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  mockResolveOrg.mockResolvedValue("org1");
  mockLoad.mockResolvedValue(structuredClone(baseRow));
  mockDb.speakerProfileForm.updateMany.mockResolvedValue({ count: 1 });
  mockDb.speaker.update.mockResolvedValue({});
  notifySpy.mockReturnValue({ catch: () => {} });
  mockAuth.mockResolvedValue({ user: { id: "admin1", role: "ORGANIZER", organizationId: "org1" } });
  mockDb.event.findFirst.mockResolvedValue({
    id: "ev1", slug: "medcon", name: "MedCon", organizationId: "org1", organization: { name: "MMG" },
  });
  mockDb.speaker.findFirst.mockResolvedValue({ id: "sp1", title: "DR", firstName: "Amina", lastName: "Khan", email: "amina@x.com" });
  mockDb.speakerProfileForm.findFirst.mockResolvedValue(null);
  mockDb.speakerProfileForm.create.mockResolvedValue({ id: "form1", token: "tok_generated", status: "PENDING" });
  mockDb.user.findUnique.mockResolvedValue({ firstName: "Ops", lastName: "Casison", emailSignature: "<p>sig</p>" });
  sendEmailSpy.mockResolvedValue({ success: true });
});

describe("public speaker-form submit", () => {
  it("404s an invalid token", async () => {
    mockLoad.mockResolvedValue(null);
    const res = await PUBLIC_SUBMIT(jsonReq({}), publicParams);
    expect(res.status).toBe(404);
    expect(mockDb.speakerProfileForm.updateMany).not.toHaveBeenCalled();
  });

  it("409s a submitted (locked) form", async () => {
    mockLoad.mockResolvedValue({ ...structuredClone(baseRow), status: "SUBMITTED" });
    const res = await PUBLIC_SUBMIT(jsonReq({}), publicParams);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.code).toBe("ALREADY_SUBMITTED");
  });

  it("400 MISSING_PHOTO — a photo is required (server-side, form is bypassable)", async () => {
    const row = structuredClone(baseRow);
    row.speaker.photo = null as never;
    mockLoad.mockResolvedValue(row);
    const res = await PUBLIC_SUBMIT(jsonReq({}), publicParams);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.code).toBe("MISSING_PHOTO");
  });

  it("400 MISSING_DOCUMENTS when the passport copy is absent (cover letter stays optional)", async () => {
    const row = structuredClone(baseRow);
    row.speaker.documents = [{ id: "d2", label: "Cover letter", filename: "c.pdf", size: 1, createdAt: new Date() }] as never;
    mockLoad.mockResolvedValue(row);
    const res = await PUBLIC_SUBMIT(jsonReq({}), publicParams);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.code).toBe("MISSING_DOCUMENTS");
    expect(body.missing).toEqual(["passport"]);
  });

  it("submits: conditional PENDING claim + bio write + audit + admin notify", async () => {
    const res = await PUBLIC_SUBMIT(jsonReq({ bio: "  New bio  " }), publicParams);
    expect(res.status).toBe(200);
    expect(mockDb.speakerProfileForm.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "form1", status: "PENDING" },
        data: expect.objectContaining({ status: "SUBMITTED", submittedIp: "1.2.3.4" }),
      }),
    );
    expect(mockDb.speaker.update).toHaveBeenCalledWith({ where: { id: "sp1" }, data: { bio: "New bio" } });
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "PROFILE_FORM_SUBMITTED",
          entityType: "Speaker",
          entityId: "sp1",
        }),
      }),
    );
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });

  it("a lost submit race (claim count 0) returns 409 and writes nothing else", async () => {
    mockDb.speakerProfileForm.updateMany.mockResolvedValue({ count: 0 });
    const res = await PUBLIC_SUBMIT(jsonReq({ bio: "x" }), publicParams);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.code).toBe("ALREADY_SUBMITTED");
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it("an empty bio never overwrites the existing one", async () => {
    const res = await PUBLIC_SUBMIT(jsonReq({ bio: "   " }), publicParams);
    expect(res.status).toBe(200);
    expect(mockDb.speaker.update).not.toHaveBeenCalled();
  });

  it("an ORGANIZER-uploaded passport (free-text label 'Passport') satisfies the required slot", async () => {
    // The docs can come from either side — the Documents card's free-text
    // label is alias-matched, not exact-matched.
    const row = structuredClone(baseRow);
    row.speaker.documents = [{ id: "d3", label: "Passport", filename: "scan.jpg", size: 1, createdAt: new Date() }] as never;
    mockLoad.mockResolvedValue(row);
    const res = await PUBLIC_SUBMIT(jsonReq({}), publicParams);
    expect(res.status).toBe(200);
  });
});

describe("profile slot matching (either-side uploads)", () => {
  it("alias labels map to slots case-insensitively; unrelated labels don't", async () => {
    const { profileSlotForLabel, missingProfileDocSlots } = await import("@/lib/speaker-profile/constants");
    expect(profileSlotForLabel("Passport copy")).toBe("passport");
    expect(profileSlotForLabel("passport")).toBe("passport");
    expect(profileSlotForLabel("  PASSPORT PHOTOCOPY ")).toBe("passport");
    expect(profileSlotForLabel("Cover Letter")).toBe("cover_letter");
    expect(profileSlotForLabel("Bio")).toBeNull();
    expect(profileSlotForLabel(null)).toBeNull();
    expect(missingProfileDocSlots(["Cover letter", "Bio"])).toEqual(["passport"]);
    expect(missingProfileDocSlots(["passport scan"])).toEqual([]);
  });
});

describe("organizer profile-form route — RBAC (real denyReviewer)", () => {
  it("401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await SEND(jsonReq({}), staffParams);
    expect(res.status).toBe(401);
  });

  it.each(["MEMBER", "REVIEWER", "SUBMITTER", "ONSITE"])("403 for %s", async (role) => {
    mockAuth.mockResolvedValue({ user: { id: "u1", role, organizationId: "org1" } });
    const res = await SEND(jsonReq({}), staffParams);
    expect(res.status).toBe(403);
    expect(sendEmailSpy).not.toHaveBeenCalled();
  });
});

describe("organizer profile-form route — mint + send", () => {
  it("first send MINTS the token, emails the link, logs against the SPEAKER", async () => {
    const res = await SEND(jsonReq({}), staffParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.sentTo).toBe("amina@x.com");
    expect(mockDb.speakerProfileForm.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventId: "ev1",
          organizationId: "org1",
          speakerId: "sp1",
          token: "tok_generated",
          createdById: "admin1",
        }),
      }),
    );
    expect(body.link).toContain("/e/medcon/speaker-form/tok_generated");
    const sendCall = sendEmailSpy.mock.calls[0][0];
    expect(sendCall.htmlContent).toContain("/e/medcon/speaker-form/tok_generated");
    expect(sendCall.logContext).toMatchObject({
      entityType: "SPEAKER",
      entityId: "sp1",
      templateSlug: "speaker-profile-form-request",
    });
  });

  it("a resend REUSES the existing token (earlier emails keep working)", async () => {
    mockDb.speakerProfileForm.findFirst.mockResolvedValue({ id: "form1", token: "tok_existing", status: "PENDING" });
    const res = await SEND(jsonReq({}), staffParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(mockDb.speakerProfileForm.create).not.toHaveBeenCalled();
    expect(body.link).toContain("tok_existing");
  });

  it("send failure surfaces as 502 EMAIL_SEND_FAILED (never silent)", async () => {
    sendEmailSpy.mockResolvedValue({ success: false, error: "boom" });
    const res = await SEND(jsonReq({}), staffParams);
    const body = await res.json();
    expect(res.status).toBe(502);
    expect(body.code).toBe("EMAIL_SEND_FAILED");
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("400 NO_SPEAKER_EMAIL when the speaker has no address", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({ id: "sp1", title: null, firstName: "A", lastName: "K", email: null });
    const res = await SEND(jsonReq({}), staffParams);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.code).toBe("NO_SPEAKER_EMAIL");
  });

  it("429 when rate-limited", async () => {
    rateLimitSpy.mockReturnValue({ allowed: false, retryAfterSeconds: 60 });
    const res = await SEND(jsonReq({}), staffParams);
    expect(res.status).toBe(429);
    expect(sendEmailSpy).not.toHaveBeenCalled();
  });
});

describe("organizer profile-form route — GET + reopen", () => {
  it("GET returns null when no form was minted yet", async () => {
    const res = await GET(new Request("http://localhost/x"), staffParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.form).toBeNull();
  });

  it("GET returns the copyable link + status", async () => {
    mockDb.speakerProfileForm.findFirst.mockResolvedValue({
      id: "form1", token: "tok_existing", status: "SUBMITTED", submittedAt: new Date(), createdAt: new Date(),
    });
    const res = await GET(new Request("http://localhost/x"), staffParams);
    const body = await res.json();
    expect(body.form.status).toBe("SUBMITTED");
    expect(body.form.link).toContain("/e/medcon/speaker-form/tok_existing");
  });

  it("PATCH reopen flips SUBMITTED → PENDING (conditional) + audits", async () => {
    mockDb.speakerProfileForm.updateMany.mockResolvedValue({ count: 1 });
    const res = await PATCH(jsonReq({ reopen: true }), staffParams);
    expect(res.status).toBe(200);
    expect(mockDb.speakerProfileForm.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { speakerId: "sp1", eventId: "ev1", status: "SUBMITTED" },
        data: { status: "PENDING" },
      }),
    );
    expect(mockDb.auditLog.create).toHaveBeenCalled();
  });

  it("PATCH reopen with nothing submitted is a 400, not a silent success", async () => {
    mockDb.speakerProfileForm.updateMany.mockResolvedValue({ count: 0 });
    const res = await PATCH(jsonReq({ reopen: true }), staffParams);
    expect(res.status).toBe(400);
  });
});
