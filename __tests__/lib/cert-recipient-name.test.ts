/**
 * The certificate recipient name keeps its honorific (Sep 16, 2026).
 *
 * cert-context.ts carried a private { DR: "Dr.", … } map, a THIRD copy of the
 * mapping that already lives once as TITLE_LABELS in @/lib/utils. It was swapped
 * for the shared formatPersonName. Behaviour is identical today, which is
 * exactly why it needs pinning: the swap is invisible in review, and the way it
 * would break later is a Title enum value added to one map and silently dropped
 * from every certificate.
 *
 * Note this is NOT the same function as pdf/document-layout's
 * formatRecipientName, which is deliberately tolerant of an already-formatted
 * "Dr." because the invoice and quote builders disagree on the shape. Every
 * caller here passes the raw Prisma enum, so the strict helper is correct, and
 * the tolerant-vs-strict distinction is pinned below so a future consolidation
 * does not collapse the two.
 */
import { describe, it, expect } from "vitest";
import { formatRecipientName } from "@/lib/certificates/cert-context";
import { formatPersonName } from "@/lib/utils";
import { formatRecipientName as tolerantFormat } from "@/lib/pdf/document-layout";

describe("certificate recipientName", () => {
  it("prefixes the honorific for every Title the enum actually carries", () => {
    expect(formatRecipientName("DR", "Ahmed", "Osman")).toBe("Dr. Ahmed Osman");
    expect(formatRecipientName("PROF", "Jane", "Doe")).toBe("Prof. Jane Doe");
    expect(formatRecipientName("MR", "John", "Smith")).toBe("Mr. John Smith");
    expect(formatRecipientName("MRS", "Jane", "Smith")).toBe("Mrs. Jane Smith");
    expect(formatRecipientName("MS", "Jane", "Smith")).toBe("Ms. Jane Smith");
  });

  it("omits the prefix cleanly when there is no title, with no stray space", () => {
    expect(formatRecipientName(null, "Ahmed", "Osman")).toBe("Ahmed Osman");
    expect(formatRecipientName(undefined, "Ahmed", "Osman")).toBe("Ahmed Osman");
  });

  it("degrades to no prefix for OTHER rather than printing 'undefined'", () => {
    // OTHER is in the Title enum but in no label map. It must fall through to a
    // bare name: the old inline map produced a leading space that .trim() ate,
    // and the shared helper must keep that outcome.
    expect(formatRecipientName("OTHER", "Ahmed", "Osman")).toBe("Ahmed Osman");
  });

  it("is the shared helper, not a private copy of it", () => {
    // The regression this guards: someone re-inlines a local map here, and the
    // next Title enum value reaches the rest of the app but not certificates.
    expect(formatRecipientName).toBe(formatPersonName);
  });

  it("stays STRICT, unlike the deliberately tolerant PDF formatter", () => {
    // document-layout's version passes an already-formatted label through,
    // because its invoice caller supplies "Dr." while its quote caller supplies
    // "DR". Certificates only ever receive the enum. Collapsing the two would
    // make one of the two paths wrong, so the difference is pinned.
    expect(tolerantFormat("Dr.", "Ahmed", "Osman")).toBe("Dr. Ahmed Osman");
    expect(formatRecipientName("Dr.", "Ahmed", "Osman")).toBe("Ahmed Osman");
  });
});
