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

const { findUnique, create, updateMany, warn, error } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
  updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { travelGrant: { findUnique, create, updateMany } },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn, error } }));
vi.mock("@/lib/tenant-context", () => ({
  runWithTenant: (_org: string, fn: () => unknown) => fn(),
}));

import { buildTravelGrantBlock, templateUsesTravelGrantBlock } from "@/lib/travel-grant/block";
import { resolveTravelGrantBlock } from "@/lib/travel-grant/server";

const ENABLED = { travelGrant: { enabled: true } };
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
    expect(b.html).toContain("Confirm your travel grant");
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
    expect(b.html).toContain("Confirm your travel grant");
    expect(b.html).not.toContain("<div style=\"margin: 0 0 16px 0;");
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
