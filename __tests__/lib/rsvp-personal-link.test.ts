/**
 * {{rsvpLink}} for one person (the per-registration / per-speaker single
 * sends). Pins: the token predicate matches exactly what renderTemplate
 * substitutes; the invite lookup is event-bound and matches by normalised
 * email plus the person's own facet id; exactly one OPEN invite resolves to
 * the personal link; none / only-closed / several are distinct refusals, and
 * nothing is ever minted.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { rsvpInvite: { findMany } } }));

import { resolveRsvpLinkForPerson, templateUsesRsvpLink } from "@/lib/rsvp/personal-link";

const inv = (token: string, id: string, name: string, isActive = true) => ({ token, campaign: { id, name, isActive } });

beforeEach(() => {
  findMany.mockReset();
  process.env.NEXT_PUBLIC_APP_URL = "https://events.example.com/";
});

describe("templateUsesRsvpLink", () => {
  it("matches the exact token in any part, and ignores empty parts", () => {
    expect(templateUsesRsvpLink("<p>{{rsvpLink}}</p>")).toBe(true);
    expect(templateUsesRsvpLink(null, undefined, "Subject", "text {{rsvpLink}}")).toBe(true);
    expect(templateUsesRsvpLink("Subject {{rsvpLink}}", "")).toBe(true);
  });
  it("matches {{rsvpButton}} too, since both resolve from the same invite", () => {
    expect(templateUsesRsvpLink("<p>{{rsvpButton}}</p>")).toBe(true);
  });
  it("does not match a spaced, url-encoded or different token (renderTemplate would not either)", () => {
    expect(templateUsesRsvpLink("{{ rsvpLink }}")).toBe(false);
    expect(templateUsesRsvpLink("%7B%7BrsvpLink%7D%7D")).toBe(false);
    expect(templateUsesRsvpLink("{{rsvpName}}", "{{surveyLink}}")).toBe(false);
    expect(templateUsesRsvpLink()).toBe(false);
  });
});

describe("resolveRsvpLinkForPerson", () => {
  it("queries the event's invites by case-insensitive email plus the facet ids given", async () => {
    findMany.mockResolvedValue([]);
    await resolveRsvpLinkForPerson({ eventId: "ev1", eventSlug: "OOPVF2026", email: " Dr.X@Example.com ", registrationId: "reg1" });
    const where = findMany.mock.calls[0][0].where;
    expect(where.eventId).toBe("ev1");
    expect(where.OR).toEqual([
      { inviteeEmail: { equals: "Dr.X@Example.com", mode: "insensitive" } },
      { registrationId: "reg1" },
    ]);
    findMany.mockClear();
    await resolveRsvpLinkForPerson({ eventId: "ev1", eventSlug: "s", email: "a@b.c", speakerId: "sp1" });
    expect(findMany.mock.calls[0][0].where.OR).toEqual([
      { inviteeEmail: { equals: "a@b.c", mode: "insensitive" } },
      { speakerId: "sp1" },
    ]);
  });

  it("resolves the personal link when the person holds exactly one open invite", async () => {
    findMany.mockResolvedValue([inv("tok1", "c1", "Attendance")]);
    const out = await resolveRsvpLinkForPerson({ eventId: "ev1", eventSlug: "OOPVF2026", email: "a@b.c" });
    expect(out).toMatchObject({ ok: true, rsvpLink: "https://events.example.com/e/OOPVF2026/rsvp/tok1", rsvpName: "Attendance", campaignId: "c1" });
    // The button is built from the same link, so the two can never disagree.
    if (out.ok) expect(out.rsvpButton).toContain('href="https://events.example.com/e/OOPVF2026/rsvp/tok1"');
  });

  it("counts one invite per campaign even when the email arm and the id arm return the same row", async () => {
    findMany.mockResolvedValue([inv("tok1", "c1", "Attendance"), inv("tok1", "c1", "Attendance")]);
    const out = await resolveRsvpLinkForPerson({ eventId: "ev1", eventSlug: "s", email: "a@b.c", registrationId: "r1" });
    expect(out.ok).toBe(true);
  });

  it("refuses NO_INVITE when the person is on no guest list, minting nothing", async () => {
    findMany.mockResolvedValue([]);
    const out = await resolveRsvpLinkForPerson({ eventId: "ev1", eventSlug: "s", email: "a@b.c" });
    expect(out).toMatchObject({ ok: false, code: "NO_INVITE", campaignNames: [] });
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("refuses CLOSED when every invite the person holds is on a closed RSVP, naming it", async () => {
    findMany.mockResolvedValue([inv("tok1", "c1", "Gala Dinner", false)]);
    const out = await resolveRsvpLinkForPerson({ eventId: "ev1", eventSlug: "s", email: "a@b.c" });
    expect(out).toMatchObject({ ok: false, code: "CLOSED", campaignNames: ["Gala Dinner"] });
    if (!out.ok) expect(out.message).toContain('"Gala Dinner"');
  });

  it("refuses AMBIGUOUS when the person is invited to more than one open RSVP, and ignores closed ones", async () => {
    findMany.mockResolvedValue([inv("t1", "c1", "Dinner"), inv("t2", "c2", "Workshop"), inv("t3", "c3", "Old", false)]);
    const out = await resolveRsvpLinkForPerson({ eventId: "ev1", eventSlug: "s", email: "a@b.c" });
    expect(out).toMatchObject({ ok: false, code: "AMBIGUOUS", campaignNames: ["Dinner", "Workshop"] });
    if (!out.ok) expect(out.message).toContain("Communications");
  });

  it("resolves the single open invite even when a closed one exists beside it", async () => {
    findMany.mockResolvedValue([inv("t3", "c3", "Old", false), inv("t1", "c1", "Attendance")]);
    const out = await resolveRsvpLinkForPerson({ eventId: "ev1", eventSlug: "s", email: "a@b.c" });
    expect(out).toMatchObject({ ok: true, rsvpName: "Attendance" });
  });
});
