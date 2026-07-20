/**
 * Speaker reimbursement — client-safe constants + validation + pure helpers.
 *
 * Web replacement for the paper "Speaker / Faculty Reimbursement Form"
 * (bank wire transfer request, Meeting Minds FZ LLC). This module is
 * imported by BOTH the public form page ("use client") and the API routes,
 * so it must stay free of Node-only imports (crypto/fs/path) — the token
 * generator lives in ./server.ts.
 *
 * v1 model (owner decisions, July 20, 2026):
 *   - submission-only lifecycle: PENDING → SUBMITTED (+ organizer reopen)
 *   - dashboard visibility: SUPER_ADMIN / ADMIN / ORGANIZER only
 *   - currencies: USD / AED / SAR (as on the paper form)
 */

import { z } from "zod";

// ── Currencies (owner decision: match the paper form exactly) ─────────

export const REIMBURSEMENT_CURRENCIES = ["USD", "AED", "SAR"] as const;
export type ReimbursementCurrency = (typeof REIMBURSEMENT_CURRENCIES)[number];

// ── Claim items (Section C) ───────────────────────────────────────────
// `receiptKind` names the document kind that MUST be uploaded when the
// item is claimed ("Expenses without receipts cannot be processed" — the
// paper form's rule, enforced server-side at submit). The speaker fee is
// the one item that needs no receipt.

export const CLAIM_ITEMS = [
  { key: "SPEAKER_FEE", label: "Speaker Fee", receiptKind: null },
  { key: "FLIGHT", label: "Flight Reimbursement", receiptKind: "FLIGHT_RECEIPT" },
  { key: "HOTEL", label: "Hotel Accommodation", receiptKind: "HOTEL_INVOICE" },
  { key: "TRANSPORT", label: "Ground Transport / Taxi", receiptKind: "TRANSPORT_RECEIPT" },
  { key: "OTHER", label: "Other Expenses", receiptKind: "OTHER" },
] as const;
export type ClaimItemKey = (typeof CLAIM_ITEMS)[number]["key"];

const CLAIM_ITEM_KEYS = CLAIM_ITEMS.map((c) => c.key) as [ClaimItemKey, ...ClaimItemKey[]];

export function claimItemLabel(key: string): string {
  return CLAIM_ITEMS.find((c) => c.key === key)?.label ?? key;
}

// ── Document kinds (Section E) ────────────────────────────────────────

export const DOCUMENT_KINDS = [
  { key: "PASSPORT", label: "Passport copy (photo page)" },
  { key: "FLIGHT_RECEIPT", label: "Flight receipt" },
  { key: "HOTEL_INVOICE", label: "Hotel invoice" },
  { key: "TRANSPORT_RECEIPT", label: "Transport / taxi receipt" },
  { key: "OTHER", label: "Other supporting receipt" },
] as const;
export type DocumentKindKey = (typeof DOCUMENT_KINDS)[number]["key"];

const DOCUMENT_KIND_KEYS = DOCUMENT_KINDS.map((d) => d.key) as [
  DocumentKindKey,
  ...DocumentKindKey[],
];
export const documentKindSchema = z.enum(DOCUMENT_KIND_KEYS);

export function documentKindLabel(key: string): string {
  return DOCUMENT_KINDS.find((d) => d.key === key)?.label ?? key;
}

/** Role-at-event choices (Section B) — free "Other: …" text is allowed. */
export const ROLE_AT_EVENT_OPTIONS = [
  "Speaker",
  "Session Chair",
  "Panelist / Discussant",
  "Workshop Facilitator",
] as const;

// ── Access boundary ───────────────────────────────────────────────────
/**
 * Who may see submitted reimbursements (incl. bank details + passport
 * number) in the dashboard. Owner decision (July 20, 2026): staff only —
 * SUPER_ADMIN / ADMIN / ORGANIZER. MEMBER / ONSITE / CRM_USER and every
 * org-null role see NOTHING (this is wire-transfer data, stricter than the
 * finance boundary, which includes MEMBER + ONSITE). Fails closed.
 *
 * The API routes enforce the same set via `denyReviewer(session)` with no
 * allow-list (its restricted set is exactly the excluded population); this
 * predicate exists for UI gating and as the named statement of the boundary.
 */
export function canManageReimbursements(role: string | null | undefined): boolean {
  return role === "SUPER_ADMIN" || role === "ADMIN" || role === "ORGANIZER";
}

// ── Validation (shared client + server) ───────────────────────────────

export const claimLineSchema = z.object({
  item: z.enum(CLAIM_ITEM_KEYS),
  currency: z.enum(REIMBURSEMENT_CURRENCIES),
  // 2dp money; the cap is a sanity guard, not a business rule.
  amount: z.number().positive().max(1_000_000),
});
export type ClaimLine = z.infer<typeof claimLineSchema>;

export const bankDetailsSchema = z
  .object({
    beneficiaryName: z.string().trim().min(2).max(200),
    beneficiaryAddress: z.string().trim().max(400).optional().or(z.literal("")),
    bankName: z.string().trim().min(2).max(200),
    bankAddress: z.string().trim().max(400).optional().or(z.literal("")),
    bankCountry: z.string().trim().max(100).optional().or(z.literal("")),
    accountNumber: z.string().trim().max(50).optional().or(z.literal("")),
    iban: z.string().trim().max(50).optional().or(z.literal("")),
    swift: z.string().trim().min(4).max(20),
    routingNumber: z.string().trim().max(30).optional().or(z.literal("")),
    sortCode: z.string().trim().max(20).optional().or(z.literal("")),
    intermediaryBank: z.string().trim().max(300).optional().or(z.literal("")),
  })
  .refine((b) => Boolean(b.accountNumber?.trim() || b.iban?.trim()), {
    message: "Provide an account number or an IBAN.",
    path: ["accountNumber"],
  });
export type BankDetails = z.infer<typeof bankDetailsSchema>;

/** The public submit body (Sections B + C + D + F). */
export const reimbursementSubmitSchema = z.object({
  // Section B — wire-compliance-critical fields are required; the rest
  // mirror the paper form as optional.
  fullName: z.string().trim().min(2).max(200),
  designation: z.string().trim().max(200).optional().or(z.literal("")),
  institution: z.string().trim().max(300).optional().or(z.literal("")),
  country: z.string().trim().min(2).max(100),
  email: z.string().trim().min(3).max(200).email(),
  phone: z.string().trim().max(50).optional().or(z.literal("")),
  nationality: z.string().trim().min(2).max(100),
  passportNumber: z.string().trim().min(3).max(50),
  roleAtEvent: z.string().trim().min(2).max(100),

  claimLines: z.array(claimLineSchema).min(1).max(10),
  bankDetails: bankDetailsSchema,

  signedName: z.string().trim().min(2).max(200),
  declarationAccepted: z.literal(true),
});
export type ReimbursementSubmit = z.infer<typeof reimbursementSubmitSchema>;

// ── Pure helpers ──────────────────────────────────────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Per-currency totals — the paper form's single TOTAL row assumes one
 * currency; mixed-currency claims must never be summed across currencies.
 */
export function computeClaimTotals(lines: ClaimLine[]): Partial<Record<ReimbursementCurrency, number>> {
  const totals: Partial<Record<ReimbursementCurrency, number>> = {};
  for (const line of lines) {
    totals[line.currency] = round2((totals[line.currency] ?? 0) + line.amount);
  }
  return totals;
}

/** "USD 1,250.00 · AED 400.00" — display string for lists/CSV. */
export function formatClaimTotals(lines: ClaimLine[]): string {
  const totals = computeClaimTotals(lines);
  return REIMBURSEMENT_CURRENCIES.filter((c) => totals[c] != null)
    .map((c) => `${c} ${totals[c]!.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
    .join(" · ");
}

/**
 * The document kinds a submission MUST include for the claimed items:
 * always the passport photo page, plus each claimed item's receipt kind.
 */
export function requiredDocumentKinds(lines: Pick<ClaimLine, "item">[]): DocumentKindKey[] {
  const kinds = new Set<DocumentKindKey>(["PASSPORT"]);
  for (const line of lines) {
    const receiptKind = CLAIM_ITEMS.find((c) => c.key === line.item)?.receiptKind;
    if (receiptKind) kinds.add(receiptKind);
  }
  return [...kinds];
}

/** Required kinds not yet covered by an uploaded document. */
export function missingDocumentKinds(
  lines: Pick<ClaimLine, "item">[],
  uploadedKinds: string[],
): DocumentKindKey[] {
  const uploaded = new Set(uploadedKinds);
  return requiredDocumentKinds(lines).filter((k) => !uploaded.has(k));
}

/** Max uploaded documents per reimbursement (sanity cap on the token route). */
export const MAX_REIMBURSEMENT_DOCUMENTS = 15;
