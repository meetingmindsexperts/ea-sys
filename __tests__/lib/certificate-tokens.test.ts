/**
 * The certificate token contract.
 *
 * The load-bearing test here is the DRIFT GUARD: the catalog the canvas editor
 * shows the organizer and the map the renderer actually resolves must hold the
 * same keys. They were two hand-maintained lists and had already diverged —
 * `{{role}}` shipped in June 2026, resolved fine, and never reached the
 * editor's list, so the one token an appreciation certificate most wants was
 * undiscoverable for a month.
 *
 * Both directions fail loudly on purpose:
 *   - in the catalog, not resolved  → prints blank on a real certificate and
 *     logs a warn on every render (silent on the page, so it must be loud here)
 *   - resolved, not in the catalog  → a capability nobody can find
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { resolveTokens, mergeBody } from "@/lib/certificates/template";
import {
  CERTIFICATE_TOKENS,
  CERTIFICATE_TOKEN_KEYS,
  isCertificateToken,
  tokensReferencedIn,
  unknownTokensIn,
} from "@/lib/certificates/token-catalog";
import type { CertificateData } from "@/lib/certificates/types";

function certData(over: Partial<CertificateData> = {}): CertificateData {
  return {
    type: "ATTENDANCE",
    serial: "OSHMM-ATT-0042",
    issuedAt: new Date("2026-06-17T09:00:00Z"),
    recipient: {
      title: "Dr.",
      firstName: "Sample",
      lastName: "Attendee",
      fullName: "Dr. Sample Attendee",
    },
    event: {
      name: "OSH Monthly Meeting 2026",
      startDate: new Date("2026-06-17T00:00:00Z"),
      endDate: new Date("2026-06-17T00:00:00Z"),
      venue: "Conrad Dubai",
      city: "Dubai",
      country: "United Arab Emirates",
      organizationName: "Meeting Minds Experts",
      cmeHours: 1.5,
      accreditations: [{ body: "OTHER", reference: "OMSB/CPD/C1/6529/2026" }],
    },
    extras: { type: "ATTENDANCE" },
    template: {},
    ...over,
  };
}

describe("token catalog ↔ resolver parity (drift guard)", () => {
  it("resolves exactly the keys the catalog advertises", () => {
    const resolved = Object.keys(resolveTokens(certData())).sort();
    expect(resolved).toEqual([...CERTIFICATE_TOKEN_KEYS].sort());
  });

  it("resolves the same key set for APPRECIATION as for ATTENDANCE", () => {
    // A key that only appears for one category would render as an
    // unknown-token warn on the other, on every single certificate.
    const attendance = Object.keys(resolveTokens(certData())).sort();
    const appreciation = Object.keys(
      resolveTokens(
        certData({
          type: "APPRECIATION",
          extras: { type: "APPRECIATION", abstractTitle: "A title", sessionTitles: ["S1"] },
        }),
      ),
    ).sort();
    expect(appreciation).toEqual(attendance);
  });

  it("has no duplicate keys and every entry carries a description", () => {
    expect(new Set(CERTIFICATE_TOKEN_KEYS).size).toBe(CERTIFICATE_TOKEN_KEYS.length);
    for (const t of CERTIFICATE_TOKENS) {
      expect(t.description.trim().length, t.key).toBeGreaterThan(0);
    }
  });
});

describe("newly exposed tokens", () => {
  it("renders the issuing organisation", () => {
    expect(mergeBody("{{organizationName}}", certData())).toBe("Meeting Minds Experts");
  });

  it("renders the certificate serial and issue date", () => {
    const d = certData();
    expect(mergeBody("Certificate No. {{certificateSerial}}", d)).toBe(
      "Certificate No. OSHMM-ATT-0042",
    );
    expect(mergeBody("Issued {{issuedDate}}", d)).toBe("Issued 17th June 2026");
  });

  it("renders abstract + session titles on APPRECIATION", () => {
    const d = certData({
      type: "APPRECIATION",
      extras: {
        type: "APPRECIATION",
        abstractTitle: "Optimizing HDMTX Outcomes",
        sessionTitles: ["Session A", "Session B"],
      },
    });
    expect(mergeBody("{{abstractTitle}}", d)).toBe("Optimizing HDMTX Outcomes");
    expect(mergeBody("{{sessionTitles}}", d)).toBe("Session A, Session B");
  });

  it("renders them EMPTY (not as an unknown token) on ATTENDANCE", () => {
    const d = certData();
    expect(mergeBody("{{abstractTitle}}", d)).toBe("");
    expect(mergeBody("{{sessionTitles}}", d)).toBe("");
  });
});

describe("accreditationName", () => {
  // The reason this token exists: `OTHER` renders the unusable literal
  // "The Accrediting Body", which is why the OSH templates typed their
  // accreditor by hand into a text box.
  it("prefers the organizer's free-text name over the enum's fallback", () => {
    const d = certData({
      event: {
        ...certData().event,
        accreditations: [
          {
            body: "OTHER",
            reference: "OMSB/CPD/C1/6529/2026",
            name: "Oman Medical Specialty Board (OMSB)",
          },
        ],
      },
    });
    expect(mergeBody("Accredited by {{accreditationName}}", d)).toBe(
      "Accredited by Oman Medical Specialty Board (OMSB)",
    );
    // The enum-derived token is unchanged — existing templates keep working.
    expect(mergeBody("{{accreditationBody}}", d)).toBe("The Accrediting Body");
  });

  it("falls back to the standard name when no free-text name is set", () => {
    const d = certData({
      event: {
        ...certData().event,
        accreditations: [{ body: "DHA", reference: "DHA-CPD-2026-0142" }],
      },
    });
    expect(mergeBody("{{accreditationName}}", d)).toBe("Dubai Health Authority (DHA)");
  });

  it("treats a whitespace-only name as unset", () => {
    const d = certData({
      event: {
        ...certData().event,
        accreditations: [{ body: "DHA", reference: "R", name: "   " }],
      },
    });
    expect(mergeBody("{{accreditationName}}", d)).toBe("Dubai Health Authority (DHA)");
  });

  it("renders empty when the event has no accreditation at all", () => {
    const d = certData({ event: { ...certData().event, accreditations: [] } });
    expect(mergeBody("{{accreditationName}}", d)).toBe("");
  });
});

describe("catalog helpers", () => {
  it("recognises catalog keys and rejects typos", () => {
    expect(isCertificateToken("recipientName")).toBe(true);
    expect(isCertificateToken("cmeHourz")).toBe(false);
  });

  it("extracts token keys with the same pattern the renderer uses", () => {
    expect(tokensReferencedIn("Accredited by {{accreditationName}} ref {{x}}")).toEqual([
      "accreditationName",
      "x",
    ]);
    expect(tokensReferencedIn("no tokens here")).toEqual([]);
    // Single braces are not tokens — mergeBody only matches the double form.
    expect(tokensReferencedIn("{recipientName}")).toEqual([]);
  });

  it("reports only the tokens the renderer would not resolve", () => {
    expect(unknownTokensIn("{{recipientName}} and {{cmeHours}}")).toEqual([]);
    expect(unknownTokensIn("{{recipientName}} and {{cmeHourz}}")).toEqual(["cmeHourz"]);
  });
});
