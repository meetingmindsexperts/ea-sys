/**
 * sendTravelGrantInvitations: the author's additional address is copied
 * (Sep 9, 2026), on both resolvers, the way every other speaker-facing send
 * already does it. The invitation carries the same link as the submission
 * confirmation, which was CC'd; this one was not.
 *
 * MUTATION TO VERIFY AGAINST: pass `[]` to brandingCc in send.ts again and
 * both cases fail.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { db, sendEmail } = vi.hoisted(() => ({
  db: {
    travelGrant: {
      findMany: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn(),
      findUnique: vi.fn(),
    },
    speaker: { findMany: vi.fn() },
  },
  sendEmail: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("@/lib/db", () => ({ db }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/email", () => ({
  sendEmail,
  getEventTemplate: vi.fn().mockResolvedValue(null),
  getDefaultTemplate: () => ({ subject: "Travel grant", htmlContent: "<p>{{travelGrantBlock}}</p>", textContent: "{{travelGrantBlockText}}" }),
  renderAndWrap: (tpl: { subject: string }) => ({ subject: tpl.subject, htmlContent: "<p>x</p>", textContent: "x" }),
  brandingFrom: () => ({ email: "events@example.org", name: "Events" }),
  // The real helper's contract for what this test pins: per-recipient extras
  // become CC entries, the recipient's own address is excluded, blanks dropped.
  brandingCc: (_b: unknown, exclude: { email: string }[], extra?: (string | null)[]) => {
    const skip = new Set(exclude.map((e) => e.email.toLowerCase()));
    const cc = (extra ?? []).filter((e): e is string => !!e).map((e) => e.toLowerCase()).filter((e) => !skip.has(e)).map((email) => ({ email }));
    return cc.length ? cc : undefined;
  },
}));

import { sendTravelGrantInvitations } from "@/lib/travel-grant/send";

const EVENT = {
  id: "evt-1",
  slug: "ev",
  name: "Event",
  organizationId: "org-1",
  travelGrantMessageHtml: null,
  homeCountries: ["AE"],
};
const actor = { id: "u-1", name: "Org Team" };

beforeEach(() => {
  vi.clearAllMocks();
  sendEmail.mockResolvedValue({ success: true });
});

describe("sendTravelGrantInvitations copies the author's additional address", () => {
  it("remind-pending: the grant row's speaker additionalEmail is CC'd, and a blank one is not", async () => {
    db.travelGrant.findMany.mockResolvedValue([
      { id: "g1", token: "t1", status: "PENDING", speakerId: "s1", speaker: { title: null, firstName: "Ana", lastName: "Silva", email: "ana@x.com", additionalEmail: "Ana.Alt@X.com", country: "Egypt" } },
      { id: "g2", token: "t2", status: "PENDING", speakerId: "s2", speaker: { title: null, firstName: "Bo", lastName: "Li", email: "bo@y.org", additionalEmail: null, country: "Oman" } },
    ]);
    const r = await sendTravelGrantInvitations({ event: EVENT, pendingOnly: true, actor });
    expect(r.sent).toBe(2);
    const calls = sendEmail.mock.calls.map((c) => c[0]);
    expect(calls.find((c) => c.to[0].email === "ana@x.com")?.cc).toEqual([{ email: "ana.alt@x.com" }]);
    expect(calls.find((c) => c.to[0].email === "bo@y.org")?.cc).toBeUndefined();
  });

  it("named send: the speaker's additionalEmail is CC'd too", async () => {
    db.speaker.findMany.mockResolvedValue([
      { id: "s1", title: null, firstName: "Ana", lastName: "Silva", email: "ana@x.com", additionalEmail: "assistant@x.com", country: "Egypt", travelGrant: { id: "g1", token: "t1", status: "PENDING" } },
    ]);
    const r = await sendTravelGrantInvitations({ event: EVENT, speakerIds: ["s1"], actor });
    expect(r.sent).toBe(1);
    expect(sendEmail.mock.calls[0][0].cc).toEqual([{ email: "assistant@x.com" }]);
  });
});
