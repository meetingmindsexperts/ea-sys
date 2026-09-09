/**
 * The {{travelGrantBlock}} email variable and the mint-or-reuse behind it.
 *
 * MUTATIONS THIS SUITE EXISTS TO CATCH:
 *   1. Drop the saved-template append in abstract-notifications.ts
 *      -> the trap test fails. That append is the ONLY thing that reaches the
 *         24 events already holding their own copy of the template.
 *   2. Render the block for a UAE author, an unknown country, or a
 *      feature-off event -> the "renders nothing" tests fail.
 *   3. Create a second row on a second abstract from the same author
 *      -> the reuse test fails, and decision D2 is broken.
 *   4. Let resolveTravelGrantBlock throw -> the isolation test fails, and a
 *      travel-grant problem would stop an abstract confirmation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { findUnique, create, updateMany, info, warn, error } = vi.hoisted(() => ({
  info: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { travelGrant: { findUnique, create, updateMany } },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info, warn, error } }));
vi.mock("@/lib/tenant-context", () => ({
  runWithTenant: (_org: string, fn: () => unknown) => fn(),
}));

import { buildTravelGrantBlock, templateUsesTravelGrantBlock } from "@/lib/travel-grant/block";
import { resolveTravelGrantBlock } from "@/lib/travel-grant/server";

// homeCountries is part of the switch: `{ enabled: true }` alone reads as
// misconfigured and therefore OFF, so a fixture without it silently tests the
// disabled path. See travel-grant-settings.test.ts.
const ENABLED = { travelGrant: { enabled: true, homeCountries: ["AE"] } };
const base = {
  eventId: "ev1",
  organizationId: "org1",
  eventSlug: "medcon",
  speakerId: "sp1",
  settings: ENABLED,
  messageHtml: "<p>We help with travel.</p>",
  abstractId: "ab1",
};

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue(null);
  create.mockResolvedValue({ token: "tok123", status: "PENDING" });
  updateMany.mockResolvedValue({ count: 1 });
});

describe("buildTravelGrantBlock", () => {
  it("renders the organizer's message and a CTA when pending", () => {
    const b = buildTravelGrantBlock({ link: "https://x/t", messageHtml: "<p>Hello</p>", status: "PENDING" });
    expect(b.html).toContain("https://x/t");
    expect(b.html).toContain("Hello");
    expect(b.html).toContain("Apply for Travel Grant");
    expect(b.text).toContain("https://x/t");
    expect(b.text).toContain("Hello");
    expect(b.text).not.toContain("<p>"); // plain-text part carries no markup
  });

  it("acknowledges rather than re-asking once consented", () => {
    const b = buildTravelGrantBlock({ link: "https://x/t", status: "CONSENTED" });
    expect(b.html).toContain("has been received");
    expect(b.html).not.toContain("https://x/t");
  });

  it("renders NOTHING once declined, so a later abstract does not re-ask", () => {
    expect(buildTravelGrantBlock({ link: "https://x/t", status: "DECLINED" })).toEqual({ html: "", text: "" });
  });

  it("renders NOTHING without a link", () => {
    expect(buildTravelGrantBlock({ link: "", status: "PENDING" })).toEqual({ html: "", text: "" });
  });

  it("renders a bare CTA when the organizer wrote no message", () => {
    const b = buildTravelGrantBlock({ link: "https://x/t", messageHtml: "  ", status: "PENDING" });
    expect(b.html).toContain("Apply for Travel Grant");
    expect(b.html).not.toContain("<div style=\"margin: 0 0 16px 0;");
  });

  it("names the application deadline under the button, in both parts, and only when there is one", () => {
    const withDeadline = buildTravelGrantBlock({ link: "https://x/t", status: "PENDING", deadlineText: "September 30, 2026 at 11:59 PM (GMT+4)" });
    expect(withDeadline.html).toContain("Applications close on September 30, 2026 at 11:59 PM (GMT+4).");
    expect(withDeadline.text).toContain("Applications close on September 30, 2026 at 11:59 PM (GMT+4).");
    const without = buildTravelGrantBlock({ link: "https://x/t", status: "PENDING" });
    expect(without.html).not.toContain("Applications close");
    expect(without.text).not.toContain("Applications close");
  });

  it("renders the organizer's button text, escaped, and falls back to the default when blank", () => {
    const custom = buildTravelGrantBlock({ link: "https://x/t", status: "PENDING", ctaLabel: "Request <b>travel</b> support" });
    expect(custom.html).toContain("Request &lt;b&gt;travel&lt;/b&gt; support</a>");
    expect(custom.html).not.toContain("<b>travel</b>");
    expect(custom.text).toContain("Request <b>travel</b> support (link unique to you)");
    const blank = buildTravelGrantBlock({ link: "https://x/t", status: "PENDING", ctaLabel: "   " });
    expect(blank.html).toContain("Apply for Travel Grant</a>");
  });
});

describe("templateUsesTravelGrantBlock", () => {
  it("detects either token in any part", () => {
    expect(templateUsesTravelGrantBlock("<p>{{travelGrantBlock}}</p>", null, null)).toBe(true);
    expect(templateUsesTravelGrantBlock(null, "{{travelGrantBlockText}}", null)).toBe(true);
  });
  it("is false for a template that does not mention it", () => {
    expect(templateUsesTravelGrantBlock("<p>{{abstractTitle}}</p>", "plain", "subject")).toBe(false);
    expect(templateUsesTravelGrantBlock(null, undefined, "")).toBe(false);
  });
  it("does not confuse a different token that merely contains the word", () => {
    expect(templateUsesTravelGrantBlock("{{travelGrantBlockSomethingElse}}")).toBe(false);
  });
});

describe("resolveTravelGrantBlock", () => {
  it("renders nothing when the feature is off, and touches no row", async () => {
    const b = await resolveTravelGrantBlock({ ...base, settings: {} });
    expect(b).toEqual({ html: "", text: "" });
    expect(findUnique).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("renders nothing for a UAE-based author, and touches no row", async () => {
    const b = await resolveTravelGrantBlock({ ...base, speakerCountry: "United Arab Emirates" });
    expect(b).toEqual({ html: "", text: "" });
    expect(create).not.toHaveBeenCalled();
  });

  it("renders nothing for the ISO code AE either", async () => {
    const b = await resolveTravelGrantBlock({ ...base, speakerCountry: "AE" });
    expect(b).toEqual({ html: "", text: "" });
    expect(create).not.toHaveBeenCalled();
  });

  it("renders nothing for an unknown country, and WARNS so a human can act (D4)", async () => {
    const b = await resolveTravelGrantBlock({ ...base, speakerCountry: "Dubai" });
    expect(b).toEqual({ html: "", text: "" });
    expect(create).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "travel-grant:residency-unknown-not-invited", country: "Dubai" }),
    );
  });

  it("mints a row and renders the CTA for an overseas author", async () => {
    const b = await resolveTravelGrantBlock({ ...base, speakerCountry: "Oman" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data).toMatchObject({
      eventId: "ev1",
      organizationId: "org1",
      speakerId: "sp1",
    });
    expect(create.mock.calls[0][0].data.token).toBeTruthy();
    expect(b.html).toContain("/e/medcon/travel-grant/tok123");
    expect(b.html).toContain("We help with travel.");
  });

  it("REUSES the row on a second abstract from the same author (D2)", async () => {
    findUnique.mockResolvedValue({ token: "existing", status: "PENDING" });
    const b = await resolveTravelGrantBlock({ ...base, speakerCountry: "Oman" });
    expect(create).not.toHaveBeenCalled();
    expect(b.html).toContain("/e/medcon/travel-grant/existing");
    expect(updateMany).toHaveBeenCalled(); // invitedAt re-stamped
  });

  it("does not re-ask an author who already consented", async () => {
    findUnique.mockResolvedValue({ token: "existing", status: "CONSENTED" });
    const b = await resolveTravelGrantBlock({ ...base, speakerCountry: "Oman" });
    expect(b.html).toContain("has been received");
    expect(b.html).not.toContain("/travel-grant/existing");
  });

  it("stays silent for an author who declined", async () => {
    findUnique.mockResolvedValue({ token: "existing", status: "DECLINED" });
    const b = await resolveTravelGrantBlock({ ...base, speakerCountry: "Oman" });
    expect(b).toEqual({ html: "", text: "" });
    // Says so in the log: from the organizer's side "the offer was in the last
    // email and not in this one" looks like a bug (the Sep 8 MEHF resends).
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "travel-grant:block-for-decided-row", status: "DECLINED", speakerId: base.speakerId }),
    );
  });

  it("renders nothing and mints nothing once the deadline has passed, and says so at info", async () => {
    const b = await resolveTravelGrantBlock({
      ...base,
      speakerCountry: "Oman",
      settings: { travelGrant: { enabled: true, homeCountries: ["AE"], deadline: "2000-01-01T00:00:00.000Z" } },
    });
    expect(b).toEqual({ html: "", text: "" });
    // One read, to see whether this author already answered; never a mint.
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ msg: "travel-grant:deadline-passed-not-invited", speakerId: base.speakerId }));
  });

  it("past the deadline, a PENDING row is neither re-sent nor re-stamped", async () => {
    findUnique.mockResolvedValue({ token: "tok123", status: "PENDING" });
    const b = await resolveTravelGrantBlock({
      ...base,
      speakerCountry: "Oman",
      settings: { travelGrant: { enabled: true, homeCountries: ["AE"], deadline: "2000-01-01T00:00:00.000Z" } },
    });
    expect(b).toEqual({ html: "", text: "" });
    expect(updateMany).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ msg: "travel-grant:deadline-passed-not-invited" }));
  });

  it("past the deadline, a CONSENTED author still gets the acknowledgement the consent page shows them, with nothing re-stamped", async () => {
    findUnique.mockResolvedValue({ token: "tok123", status: "CONSENTED" });
    const b = await resolveTravelGrantBlock({
      ...base,
      speakerCountry: "Oman",
      settings: { travelGrant: { enabled: true, homeCountries: ["AE"], deadline: "2000-01-01T00:00:00.000Z" } },
    });
    expect(b.html).toContain("Your travel grant request has been received");
    expect(b.html).not.toContain("Applications close on");
    expect(updateMany).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "travel-grant:block-for-decided-row", status: "CONSENTED", deadlinePassed: true }),
    );
  });

  it("past the deadline, a DECLINED author still gets silence", async () => {
    findUnique.mockResolvedValue({ token: "tok123", status: "DECLINED" });
    const b = await resolveTravelGrantBlock({
      ...base,
      speakerCountry: "Oman",
      settings: { travelGrant: { enabled: true, homeCountries: ["AE"], deadline: "2000-01-01T00:00:00.000Z" } },
    });
    expect(b).toEqual({ html: "", text: "" });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("words a future deadline into the block, in the event's timezone", async () => {
    const b = await resolveTravelGrantBlock({
      ...base,
      speakerCountry: "Oman",
      timezone: "Asia/Dubai",
      settings: { travelGrant: { enabled: true, homeCountries: ["AE"], deadline: "2099-09-30T19:59:00.000Z" } },
    });
    expect(b.html).toContain("Applications close on");
    expect(b.html).toMatch(/11:59\s?PM/);
  });

  it("renders nothing and logs at ERROR when there is no slug to build a link from", async () => {
    const b = await resolveTravelGrantBlock({ ...base, eventSlug: null, speakerCountry: "Oman" });
    expect(b).toEqual({ html: "", text: "" });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "travel-grant:no-event-slug-cannot-build-link" }),
    );
  });

  it("NEVER throws: a database failure degrades to an empty block", async () => {
    findUnique.mockRejectedValue(new Error("pool exhausted"));
    const b = await resolveTravelGrantBlock({ ...base, speakerCountry: "Oman" });
    expect(b).toEqual({ html: "", text: "" });
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ msg: "travel-grant:block-failed" }));
  });
});
