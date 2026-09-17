/**
 * One-certificate cover emails as editable Email Templates (Sep 17, 2026).
 *
 * Which wording a one-certificate email uses, field by field:
 *   1. the certificate template's own saved cover,
 *   2. the event's Email Template for the category,
 *   3. the built-in text.
 * pickSingleCoverEmail is the one rule every sender, preview and dashboard
 * pre-fill goes through, so it is pinned here directly.
 */
import { describe, it, expect } from "vitest";
import {
  CERT_COVER_TEMPLATE_NAMES,
  CERT_COVER_TEMPLATE_SLUGS,
  SYSTEM_DEFAULT_BODY_APPRECIATION,
  SYSTEM_DEFAULT_BODY_ATTENDANCE,
  SYSTEM_DEFAULT_SUBJECT,
  describeCertificateCoverSources,
  eventCoverFromTemplateList,
  hasOwnCoverEmail,
  pickSingleCoverEmail,
} from "@/lib/certificates/email-tokens";
import { DEFAULT_TEMPLATES, TEMPLATE_VARIABLES } from "@/lib/email";
import { SYSTEM_TEMPLATE_SLUGS, formatTemplateLabel } from "@/lib/email-template-slugs";

const EVENT_COVER = { subject: "Event subject", body: "<p>Event body</p>" };

describe("pickSingleCoverEmail", () => {
  it("a template's own saved cover wins over the event's Email Template", () => {
    const out = pickSingleCoverEmail(
      { category: "ATTENDANCE", emailSubject: "Own subject", emailBody: "<p>Own body</p>" },
      EVENT_COVER,
    );
    expect(out).toEqual({ subject: "Own subject", body: "<p>Own body</p>" });
  });

  it("a template with no saved cover takes the event's Email Template", () => {
    const out = pickSingleCoverEmail({ category: "ATTENDANCE", emailSubject: null, emailBody: null }, EVENT_COVER);
    expect(out).toEqual(EVENT_COVER);
  });

  it("a half-saved cover keeps its half and takes the other from the event template", () => {
    const out = pickSingleCoverEmail(
      { category: "APPRECIATION", emailSubject: "Own subject", emailBody: "   " },
      EVENT_COVER,
    );
    expect(out).toEqual({ subject: "Own subject", body: "<p>Event body</p>" });
  });

  it("falls back to the built-in text for the category when the event template is unavailable", () => {
    expect(pickSingleCoverEmail({ category: "ATTENDANCE" }, null)).toEqual({
      subject: SYSTEM_DEFAULT_SUBJECT,
      body: SYSTEM_DEFAULT_BODY_ATTENDANCE,
    });
    expect(pickSingleCoverEmail({ category: "APPRECIATION" }, null).body).toBe(SYSTEM_DEFAULT_BODY_APPRECIATION);
  });

  it("a blank event template field never produces a blank email", () => {
    const out = pickSingleCoverEmail({ category: "ATTENDANCE" }, { subject: " ", body: "" });
    expect(out).toEqual({ subject: SYSTEM_DEFAULT_SUBJECT, body: SYSTEM_DEFAULT_BODY_ATTENDANCE });
  });
});

describe("hasOwnCoverEmail", () => {
  it("is true when either half is saved and false when neither is", () => {
    expect(hasOwnCoverEmail({ emailSubject: "S", emailBody: null })).toBe(true);
    expect(hasOwnCoverEmail({ emailSubject: null, emailBody: "<p>B</p>" })).toBe(true);
    expect(hasOwnCoverEmail({ emailSubject: " ", emailBody: null })).toBe(false);
    expect(hasOwnCoverEmail({})).toBe(false);
  });
});

describe("eventCoverFromTemplateList", () => {
  const rows = [
    { slug: "certificate-attendance-delivery", isActive: true, subject: "A", htmlContent: "<p>A</p>" },
    { slug: "certificate-appreciation-delivery", isActive: false, subject: "P", htmlContent: "<p>P</p>" },
  ];

  it("reads an active row as the event cover", () => {
    expect(eventCoverFromTemplateList(rows, CERT_COVER_TEMPLATE_SLUGS.ATTENDANCE)).toEqual({
      subject: "A",
      body: "<p>A</p>",
    });
  });

  it("treats a switched-off or missing row as unavailable, like the server", () => {
    expect(eventCoverFromTemplateList(rows, CERT_COVER_TEMPLATE_SLUGS.APPRECIATION)).toBeNull();
    expect(eventCoverFromTemplateList(rows, "certificate-bundle-delivery")).toBeNull();
    expect(eventCoverFromTemplateList(undefined, CERT_COVER_TEMPLATE_SLUGS.ATTENDANCE)).toBeNull();
  });
});

describe("the two system templates", () => {
  it("are seeded with exactly the previous built-in wording, so nothing changes until edited", () => {
    const att = DEFAULT_TEMPLATES.find((t) => t.slug === CERT_COVER_TEMPLATE_SLUGS.ATTENDANCE);
    const app = DEFAULT_TEMPLATES.find((t) => t.slug === CERT_COVER_TEMPLATE_SLUGS.APPRECIATION);
    expect(att).toMatchObject({
      name: CERT_COVER_TEMPLATE_NAMES.ATTENDANCE,
      subject: SYSTEM_DEFAULT_SUBJECT,
      htmlContent: SYSTEM_DEFAULT_BODY_ATTENDANCE,
    });
    expect(app).toMatchObject({
      name: CERT_COVER_TEMPLATE_NAMES.APPRECIATION,
      subject: SYSTEM_DEFAULT_SUBJECT,
      htmlContent: SYSTEM_DEFAULT_BODY_APPRECIATION,
    });
  });

  it("are system slugs, so the bulk-email dialog never offers them as a saved template to send", () => {
    expect(SYSTEM_TEMPLATE_SLUGS.has(CERT_COVER_TEMPLATE_SLUGS.ATTENDANCE)).toBe(true);
    expect(SYSTEM_TEMPLATE_SLUGS.has(CERT_COVER_TEMPLATE_SLUGS.APPRECIATION)).toBe(true);
    expect(formatTemplateLabel(CERT_COVER_TEMPLATE_SLUGS.ATTENDANCE)).toBe("Certificate (attendance)");
  });

  it("advertise {{title}}, and {{abstractTitle}} only on the appreciation template", () => {
    const keys = (slug: string) => (TEMPLATE_VARIABLES[slug] ?? []).map((v) => v.key);
    expect(keys(CERT_COVER_TEMPLATE_SLUGS.ATTENDANCE)).toContain("title");
    expect(keys(CERT_COVER_TEMPLATE_SLUGS.ATTENDANCE)).not.toContain("abstractTitle");
    expect(keys(CERT_COVER_TEMPLATE_SLUGS.APPRECIATION)).toContain("abstractTitle");
  });
});

describe("describeCertificateCoverSources (the send dialog's default cover option)", () => {
  it("names the Email Template each selected certificate template will use", () => {
    expect(describeCertificateCoverSources([{ name: "CME", category: "ATTENDANCE" }])).toBe(
      "CME → Certificate Delivery (Attendance)",
    );
  });

  it("says when a template uses its own wording, and adds the bundle template for several", () => {
    expect(
      describeCertificateCoverSources([
        { name: "CME", category: "ATTENDANCE", emailSubject: "Own", emailBody: null },
        { name: "Speaker", category: "APPRECIATION" },
      ]),
    ).toBe(
      "CME → its own cover email; Speaker → Certificate Delivery (Appreciation); anyone receiving several → Certificate Delivery (Multiple Certificates)",
    );
  });

  it("asks for a selection when none is made", () => {
    expect(describeCertificateCoverSources([])).toMatch(/Select a certificate template/);
  });
});
