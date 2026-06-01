/**
 * Phase A — certificates renderer + settings helpers.
 *
 * These tests pin three things that would silently break the cert pipeline
 * if regressed:
 *   1. readEventCmeSettings() handles every shape of settings JSON that
 *      could plausibly come back from Prisma (object, null, array, with/
 *      without cme block) without throwing.
 *   2. renderCertificate produces a valid PDF buffer (starts with %PDF
 *      magic, non-empty) for every CertificateType.
 *   3. The serial naming convention for previews is stable
 *      ("PREVIEW-DRAFT-{TYPE}") so the cert can never be mistaken for an
 *      issued one if printed.
 *
 * The visual layout is intentionally NOT pinned — Phase B's CEO/MD review
 * will iterate the layout, and a test that hardcodes coordinates would
 * just be friction. We only pin "renderer runs without throwing + outputs
 * a real PDF" here.
 */

import { describe, it, expect } from "vitest";
import { renderCertificate } from "@/lib/certificates/render";
import {
  buildPreviewCertificate,
  readEventCmeSettings,
  buildEventContext,
} from "@/lib/certificates/sample-data";
import type { CertificateType } from "@/lib/certificates/types";

const SAMPLE_EVENT = {
  id: "evt-1",
  name: "IOHNC 2026 — Test Conference",
  startDate: new Date("2026-04-10T00:00:00Z"),
  endDate: new Date("2026-04-12T00:00:00Z"),
  venue: "Sofitel The Palm",
  city: "Dubai",
  country: "United Arab Emirates",
  cmeHours: 18,
  settings: {
    cme: {
      accreditations: [
        { body: "DHA" as const, reference: "DHA-CPD-2026-0142" },
        { body: "EACCME" as const, reference: "EACCME-2026-007", hours: 12 },
      ],
    },
  },
  organization: { name: "Meeting Minds Group", logo: null },
};

describe("readEventCmeSettings", () => {
  it("returns empty object when settings is null", () => {
    expect(readEventCmeSettings(null)).toEqual({});
  });
  it("returns empty object when settings is an array", () => {
    expect(readEventCmeSettings([])).toEqual({});
  });
  it("returns empty object when settings has no cme key", () => {
    expect(readEventCmeSettings({ zoom: { enabled: true } })).toEqual({});
  });
  it("returns empty object when cme is non-object (defensive)", () => {
    expect(readEventCmeSettings({ cme: "bogus" })).toEqual({});
  });
  it("returns the cme block when shape is correct", () => {
    const cme = readEventCmeSettings({
      cme: {
        accreditations: [{ body: "DHA", reference: "X" }],
        designApprovedBy: "user-1",
      },
    });
    expect(cme.accreditations).toHaveLength(1);
    expect(cme.designApprovedBy).toBe("user-1");
  });
});

describe("buildEventContext", () => {
  it("flattens organization name + logo onto top level", () => {
    const ctx = buildEventContext(SAMPLE_EVENT);
    expect(ctx.organizationName).toBe("Meeting Minds Group");
    expect(ctx.organizationLogo).toBeNull();
  });

  it("converts Prisma Decimal-shaped cmeHours into a plain number", () => {
    const evt = {
      ...SAMPLE_EVENT,
      cmeHours: { toNumber: () => 18.5 },
    };
    const ctx = buildEventContext(evt);
    expect(ctx.cmeHours).toBe(18.5);
  });

  it("passes a plain-number cmeHours straight through", () => {
    const ctx = buildEventContext(SAMPLE_EVENT);
    expect(ctx.cmeHours).toBe(18);
  });

  it("returns null cmeHours when the event doesn't carry the field", () => {
    const ctx = buildEventContext({ ...SAMPLE_EVENT, cmeHours: null });
    expect(ctx.cmeHours).toBeNull();
  });

  it("pulls accreditations from settings.cme — multi-body supported", () => {
    const ctx = buildEventContext(SAMPLE_EVENT);
    expect(ctx.accreditations).toHaveLength(2);
    expect(ctx.accreditations?.[0].body).toBe("DHA");
    expect(ctx.accreditations?.[1].body).toBe("EACCME");
  });
});

describe("buildPreviewCertificate", () => {
  it("uses the PREVIEW-DRAFT serial naming so an accidental print can never be mistaken for an issued cert", () => {
    for (const type of ["ATTENDANCE", "PRESENTER", "POSTER", "CME"] as CertificateType[]) {
      const cert = buildPreviewCertificate({ type, event: SAMPLE_EVENT });
      expect(cert.serial).toBe(`PREVIEW-DRAFT-${type}`);
    }
  });

  it("uses the synthetic recipient when no override is passed", () => {
    const cert = buildPreviewCertificate({ type: "ATTENDANCE", event: SAMPLE_EVENT });
    expect(cert.recipient.fullName).toBe("Dr. Sample Attendee");
    expect(cert.recipient.organization).toBeTruthy();
  });

  it("attaches the right extras shape per type (discriminated union)", () => {
    const presenter = buildPreviewCertificate({ type: "PRESENTER", event: SAMPLE_EVENT });
    if (presenter.extras.type === "PRESENTER") {
      expect(presenter.extras.sessionTitles).toBeDefined();
    } else {
      expect.fail("presenter extras must have type 'PRESENTER'");
    }

    const poster = buildPreviewCertificate({ type: "POSTER", event: SAMPLE_EVENT });
    if (poster.extras.type === "POSTER") {
      expect(poster.extras.abstractTitle).toBeDefined();
    } else {
      expect.fail("poster extras must have type 'POSTER'");
    }
  });
});

describe("renderCertificate", () => {
  // 35s timeout — pdfkit's lazy font load takes a moment on cold start. Subsequent
  // renders in the same process are instant.
  for (const type of ["ATTENDANCE", "PRESENTER", "POSTER", "CME"] as CertificateType[]) {
    it(`renders a valid PDF buffer for ${type}`, async () => {
      const data = buildPreviewCertificate({ type, event: SAMPLE_EVENT });
      const pdf = await renderCertificate(data);
      expect(Buffer.isBuffer(pdf)).toBe(true);
      expect(pdf.byteLength).toBeGreaterThan(1000); // smallest possible cert is way more than this
      // PDF files start with the magic string "%PDF" per RFC 8118.
      expect(pdf.slice(0, 4).toString("ascii")).toBe("%PDF");
    }, 35_000);
  }

  it("does not crash when the event has zero accreditations on a CME render", async () => {
    const data = buildPreviewCertificate({
      type: "CME",
      event: {
        ...SAMPLE_EVENT,
        settings: { cme: { accreditations: [] } },
      },
    });
    const pdf = await renderCertificate(data);
    expect(pdf.slice(0, 4).toString("ascii")).toBe("%PDF");
  }, 35_000);

  it("does not crash when cmeHours is null on a CME render — the hours block just doesn't draw", async () => {
    const data = buildPreviewCertificate({
      type: "CME",
      event: { ...SAMPLE_EVENT, cmeHours: null },
    });
    const pdf = await renderCertificate(data);
    expect(pdf.slice(0, 4).toString("ascii")).toBe("%PDF");
  }, 35_000);
});
