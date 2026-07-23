/**
 * Media-delete guard — findMediaReferences() blocks deleting an image that
 * event branding / organizer HTML content / saved email templates / the org
 * logo still point at (the July 23 dangling-emailFooterImage bug: a deleted
 * media file left a permanent 404 <img> in every email an event sent).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  event: { findMany: vi.fn() },
  emailTemplate: { findMany: vi.fn() },
  organization: { findFirst: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { findMediaReferences, mediaInUseMessage } from "@/lib/media-references";

const URL = "/uploads/media/2026/07/abc.jpg";
const ORG = "org-1";

function noHits() {
  mockDb.event.findMany.mockResolvedValue([]);
  mockDb.emailTemplate.findMany.mockResolvedValue([]);
  mockDb.organization.findFirst.mockResolvedValue(null);
}

beforeEach(() => {
  vi.clearAllMocks();
  noHits();
});

describe("findMediaReferences", () => {
  it("returns empty when nothing references the URL", async () => {
    expect(await findMediaReferences(URL, ORG)).toEqual([]);
  });

  it("reports an event branding column that equals the URL, with a readable label", async () => {
    mockDb.event.findMany
      .mockResolvedValueOnce([
        { name: "4th GCC Hematology Hub 2026", emailHeaderImage: null, emailFooterImage: URL, bannerImage: null, bannerImageMobile: null },
      ])
      .mockResolvedValueOnce([]);
    const refs = await findMediaReferences(URL, ORG);
    expect(refs).toEqual([
      { kind: "event-branding", label: "4th GCC Hematology Hub 2026 — email footer image" },
    ]);
  });

  it("reports Tiptap-embedded references inside organizer HTML content (contains, not equals)", async () => {
    mockDb.event.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          name: "BHS2026",
          registrationWelcomeHtml: `<p>hi</p><img src="${URL}" />`,
          abstractWelcomeHtml: null,
          registrationTermsHtml: null,
          abstractGuidelinesHtml: null,
          surveyIntroHtml: null,
          emailFooterHtml: null,
        },
      ]);
    const refs = await findMediaReferences(URL, ORG);
    expect(refs).toEqual([
      { kind: "event-content", label: "BHS2026 — registration welcome content" },
    ]);
  });

  it("reports saved email templates and the organization logo", async () => {
    mockDb.emailTemplate.findMany.mockResolvedValue([
      { name: "Speaker Invitation", event: { name: "BHS2026" } },
    ]);
    mockDb.organization.findFirst.mockResolvedValue({ name: "MM Group" });
    const refs = await findMediaReferences(URL, ORG);
    expect(refs).toEqual([
      { kind: "email-template", label: 'BHS2026 — email template "Speaker Invitation"' },
      { kind: "organization-logo", label: "MM Group — organization logo" },
    ]);
  });

  it("scopes every query to the caller's organization", async () => {
    await findMediaReferences(URL, ORG);
    for (const call of mockDb.event.findMany.mock.calls) {
      expect(call[0].where.organizationId).toBe(ORG);
    }
    expect(mockDb.emailTemplate.findMany.mock.calls[0][0].where.event.organizationId).toBe(ORG);
    expect(mockDb.organization.findFirst.mock.calls[0][0].where.id).toBe(ORG);
  });
});

describe("mediaInUseMessage", () => {
  it("lists up to 3 locations and counts the rest", () => {
    const refs = Array.from({ length: 5 }, (_, i) => ({
      kind: "event-branding" as const,
      label: `Event ${i} — banner image`,
    }));
    const msg = mediaInUseMessage(refs);
    expect(msg).toContain("Event 0 — banner image");
    expect(msg).toContain("Event 2 — banner image");
    expect(msg).not.toContain("Event 3");
    expect(msg).toContain("(+2 more)");
  });
});
