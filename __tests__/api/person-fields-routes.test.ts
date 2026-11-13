/**
 * The two person-fields routes (Nov 13, 2026; step 1 of docs/ORG_FIELDS_PLAN.md),
 * with the real permission check:
 *  - changing the Specialty answers needs formFields.manage, which admins and
 *    organisers hold (owner: "give the option to organizer too") and a
 *    read-only member does not;
 *  - the forms read the answers with no sign-in, and whose list they get is
 *    the event's organisation, then the signed-in person's, then the one the
 *    address belongs to, and today's lists when none of those is known.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, saveSpecialtyAnswers, countSpecialtyUse, resolveRequestOrgId, resolvePublicEventOrg, rateLimit, lane } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: { organization: { findUnique: vi.fn() } },
  saveSpecialtyAnswers: vi.fn(),
  countSpecialtyUse: vi.fn(),
  resolveRequestOrgId: vi.fn(),
  resolvePublicEventOrg: vi.fn(),
  lane: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => {
      const headers = new Map<string, string>(Object.entries(init?.headers ?? {}));
      return { status: init?.status ?? 200, json: async () => body, headers: { set: (k: string, v: string) => headers.set(k, v), get: (k: string) => headers.get(k) } };
    },
  },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => rateLimit(), getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/tenant/resolver", () => ({ resolveRequestOrgId: (req: Request) => resolveRequestOrgId(req) }));
vi.mock("@/lib/tenant/event-tenant", () => ({ resolvePublicEventOrg: (req: Request, slug: string) => resolvePublicEventOrg(req, slug) }));
vi.mock("@/lib/tenant-lane", () => ({
  runWithTenantLane: (orgId: string, ctx: unknown, fn: () => unknown) => {
    lane(orgId, ctx);
    return fn();
  },
}));
vi.mock("@/services/person-field-service", () => ({ saveSpecialtyAnswers, countSpecialtyUse }));

import { GET as getSettings, PUT } from "@/app/api/organization/person-fields/route";
import { GET as getPublic } from "@/app/api/public/person-fields/route";
import { PERSON_FIELDS_SETTING, DEFAULT_PUBLIC_PERSON_FIELDS } from "@/lib/person-fields";

const ORG = "org-1";
const user = (role: string, organizationId: string | null = ORG) => ({ user: { id: "u1", role, organizationId } });
const put = (body: unknown) => PUT({ json: async () => body } as unknown as Request);
const EXPECTED = { answers: [{ answer: "Cloud" }, { answer: "Legacy", retired: true }], allowOther: false };
const VALID = { specialty: { answers: [{ answer: "Cloud" }, { answer: "Data", retired: true }], allowOther: false, expected: EXPECTED } };
const OWN_LIST = {
  [PERSON_FIELDS_SETTING]: {
    specialty: { label: "Area", options: [{ key: "Cloud", label: "Cloud" }, { key: "Legacy", label: "Legacy", retired: true }], allowOther: false },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  rateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  saveSpecialtyAnswers.mockResolvedValue({ ok: true, field: {} });
  countSpecialtyUse.mockResolvedValue(new Map([["Cloud", 12]]));
  mockDb.organization.findUnique.mockResolvedValue({ settings: OWN_LIST });
  resolveRequestOrgId.mockResolvedValue(null);
  resolvePublicEventOrg.mockResolvedValue(null);
});

describe("Settings, Form fields: who may read and change the list", () => {
  it.each(["SUPER_ADMIN", "ADMIN", "ORGANIZER"])("%s reads the list, retired answers and the record count included, in the organisation's lane", async (role) => {
    mockAuth.mockResolvedValue(user(role));
    const res = await getSettings();
    expect(res.status).toBe(200);
    expect((await res.json()).specialty).toEqual({
      label: "Area",
      allowOther: false,
      answers: [{ answer: "Cloud", retired: false, records: 12 }, { answer: "Legacy", retired: true, records: 0 }],
    });
    // The counts read contacts, attendees and speakers, which sit behind a row policy on the platform.
    expect(lane).toHaveBeenCalledWith(ORG, { route: "organization/person-fields:GET", userId: "u1" });
  });

  it.each(["MEMBER", "ONSITE", "CRM_USER", "HR_USER", "REGISTRANT", "SUBMITTER", "REVIEWER"])("%s is refused, read and write", async (role) => {
    mockAuth.mockResolvedValue(user(role));
    expect((await getSettings()).status).toBe(403);
    expect((await put(VALID)).status).toBe(403);
    expect(saveSpecialtyAnswers).not.toHaveBeenCalled();
  });

  it("401 without a session", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await getSettings()).status).toBe(401);
    expect((await put(VALID)).status).toBe(401);
  });

  it("an organiser saves the list, inside the organisation's tenant lane", async () => {
    mockAuth.mockResolvedValue(user("ORGANIZER"));
    const res = await put(VALID);
    expect(res.status).toBe(200);
    // The in-use count reads contacts, attendees and speakers, which sit behind
    // a row policy on the platform: outside the lane a held answer looks unused.
    expect(lane).toHaveBeenCalledWith(ORG, { route: "organization/person-fields:PUT", userId: "u1" });
    // With the list the screen loaded, so a save made from an older copy can be refused.
    expect(saveSpecialtyAnswers).toHaveBeenCalledWith({ organizationId: ORG, actorUserId: "u1", answers: VALID.specialty.answers, allowOther: false, expected: EXPECTED });
  });

  it("a role that holds no such key is refused by the permission check, with or without an organisation", async () => {
    mockAuth.mockResolvedValue(user("ADMIN", null));
    expect((await put(VALID)).status).toBe(403);
    expect(saveSpecialtyAnswers).not.toHaveBeenCalled();
  });

  it.each([
    ["no body", null],
    ["answers that are not a list", { specialty: { answers: "Cloud", allowOther: true } }],
    ["no Others switch", { specialty: { answers: [], expected: EXPECTED } }],
    ["no list it was edited from", { specialty: { answers: [], allowOther: true } }],
    ["more than 200 answers", { specialty: { answers: Array.from({ length: 201 }, (_, i) => ({ answer: `A${i}` })), allowOther: true, expected: EXPECTED } }],
  ])("400 on %s", async (_name, body) => {
    mockAuth.mockResolvedValue(user("ADMIN"));
    expect((await put(body)).status).toBe(400);
    expect(saveSpecialtyAnswers).not.toHaveBeenCalled();
  });

  it("the service's refusal reaches the screen with its code and who holds the answer", async () => {
    mockAuth.mockResolvedValue(user("ADMIN"));
    saveSpecialtyAnswers.mockResolvedValue({ ok: false, code: "ANSWER_IN_USE", message: "held", inUse: [{ answer: "Cardiology", records: 3788 }] });
    const res = await put(VALID);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "held", code: "ANSWER_IN_USE", inUse: [{ answer: "Cardiology", records: 3788 }] });
  });

  it.each([
    ["LIST_CHANGED", 409],
    ["NOTHING_OFFERED", 400],
  ])("%s reaches the screen as %i with its code", async (code, status) => {
    mockAuth.mockResolvedValue(user("ORGANIZER"));
    saveSpecialtyAnswers.mockResolvedValue({ ok: false, code, message: "no" });
    const res = await put(VALID);
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ code });
  });

  it("429 when saved too often", async () => {
    mockAuth.mockResolvedValue(user("ADMIN"));
    rateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 30 });
    const res = await put(VALID);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ retryAfterSeconds: 30, limit: 60, windowSeconds: 3600 });
  });
});

describe("the forms' read: whose list, and never an empty picker", () => {
  const get = (url = "http://x/api/public/person-fields") => getPublic(new Request(url));
  const specialtyKeys = async (res: { json: () => Promise<unknown> }) =>
    ((await res.json()) as { fields: { specialty: { answers: { key: string }[] } } }).fields.specialty.answers.map((a) => a.key);

  it("needs no sign-in, sends only the answers on offer, and is never kept by the browser", async () => {
    mockAuth.mockResolvedValue(null);
    resolveRequestOrgId.mockResolvedValue(ORG);
    const res = await get();
    expect(res.status).toBe(200);
    // The retired answer is not sent; this organisation offers no Others.
    expect(await specialtyKeys(res)).toEqual(["Cloud"]);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("on an event's public form the list is the EVENT's organisation's, whoever is signed in", async () => {
    mockAuth.mockResolvedValue(user("ADMIN", "another-org"));
    resolvePublicEventOrg.mockResolvedValue(ORG);
    await get("http://x/api/public/person-fields?event=hemnet2026");
    // Found as the public pages find the event (a slug is unique per organisation).
    expect(resolvePublicEventOrg).toHaveBeenCalledWith(expect.anything(), "hemnet2026");
    expect(mockDb.organization.findUnique).toHaveBeenCalledWith({ where: { id: ORG }, select: { settings: true } });
  });

  it("an unknown event falls back to the signed-in person's organisation", async () => {
    mockAuth.mockResolvedValue(user("ORGANIZER"));
    await get("http://x/api/public/person-fields?event=nope");
    expect(mockDb.organization.findUnique).toHaveBeenCalledWith({ where: { id: ORG }, select: { settings: true } });
  });

  it("with nobody signed in, the organisation is the one the address belongs to", async () => {
    mockAuth.mockResolvedValue(null);
    resolveRequestOrgId.mockResolvedValue("host-org");
    await get();
    expect(mockDb.organization.findUnique).toHaveBeenCalledWith({ where: { id: "host-org" }, select: { settings: true } });
  });

  it("with no organisation at all, today's lists", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await get();
    expect(await res.json()).toEqual({ fields: DEFAULT_PUBLIC_PERSON_FIELDS });
    expect(mockDb.organization.findUnique).not.toHaveBeenCalled();
  });

  it("when the read fails, 503 and not the default lists as if they were the organisation's", async () => {
    // A 200 with the defaults would be kept by the page for five minutes as
    // this organisation's own list. The picker falls back by itself.
    mockAuth.mockResolvedValue(user("ADMIN"));
    mockDb.organization.findUnique.mockRejectedValue(new Error("db down"));
    const res = await get();
    expect(res.status).toBe(503);
    expect(await res.json()).not.toHaveProperty("fields");
  });

  it("429 with the retry time when flooded", async () => {
    rateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 12 });
    const res = await get();
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ retryAfterSeconds: 12, limit: 600, windowSeconds: 60 });
  });
});
