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
// paper form's rule, enforced server-side at submit). The honorarium /
// speaker fee is the one item that needs no receipt, and since Sep 3, 2026
// it is also the one item the speaker does NOT enter: the organiser sets it
// on the Speaker row and the form shows it locked (see the Honorarium
// section below).

export const CLAIM_ITEMS = [
  { key: "SPEAKER_FEE", label: "Honorarium / Speaker Fee", receiptKind: null },
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
  // No `email` here, deliberately. The address is the identity the link was
  // sent to and the server writes `Speaker.email` (Sep 2, 2026). Accepting
  // it from the body let a speaker retype it, so the confirmation (the
  // receipt for a 45-day payment promise) could go to an address the invite
  // never went to, and the finance export carried a value that disagreed
  // with the speaker record. Changing an email goes through the organizer's
  // Change Email flow, the same rule every other surface follows.
  // z.object() strips unknown keys, so a tab still open across the deploy
  // that sends `email` parses fine; the value is simply never read.
  phone: z.string().trim().max(50).optional().or(z.literal("")),
  nationality: z.string().trim().min(2).max(100),
  passportNumber: z.string().trim().min(3).max(50),
  roleAtEvent: z.string().trim().min(2).max(100),

  // Expense lines only. The honorarium / speaker fee is NOT the speaker's to
  // send: the server drops any SPEAKER_FEE line here and injects the
  // organiser's agreed figure (effectiveClaimLines). No `.min(1)` because a
  // speaker with an agreed fee and no expenses legitimately sends [] — the
  // server decides emptiness AFTER injecting the fee (NOTHING_TO_CLAIM).
  claimLines: z.array(claimLineSchema).max(10),
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

// ── Honorarium / speaker fee (organiser-set, locked on the form) ──────
/**
 * The fee the organiser agreed with a speaker, stored on `Speaker`
 * (honorariumAmount + honorariumCurrency). Owner decisions, Sep 3 2026:
 *   - LOCKED on the reimbursement form: the speaker sees the agreed figure
 *     and can neither add nor change it. The public submit writes this value
 *     and ignores any SPEAKER_FEE line in the body (effectiveClaimLines).
 *   - NOT SET renders as 0 (formatHonorarium → "0.00"), never as a blank.
 *   - Visible inside the reimbursement boundary only (canManageReimbursements);
 *     the speaker list/detail payloads strip it for everyone else.
 *   - Available as {{honorarium}} / {{honorariumAmount}} /
 *     {{honorariumCurrency}} in every speaker email (honorariumVars).
 */
export interface Honorarium {
  amount: number;
  currency: ReimbursementCurrency;
}

/** Row shape both a Prisma row (Decimal) and a JSON payload (string) satisfy. */
export interface HonorariumFields {
  honorariumAmount?: unknown;
  honorariumCurrency?: string | null;
}

/**
 * Reads the agreed fee off a Speaker row / payload. Null unless the amount is
 * a positive finite number AND the currency is one we support: a row carrying
 * an amount with an unknown currency reads as not set rather than rendering
 * with a currency the form cannot pay in. Prisma's Decimal and its JSON
 * string both go through Number(String(x)); null/undefined become NaN.
 */
export function readHonorarium(row: HonorariumFields | null | undefined): Honorarium | null {
  if (!row) return null;
  const amount = Number(String(row.honorariumAmount ?? ""));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const currency = row.honorariumCurrency;
  if (!currency || !(REIMBURSEMENT_CURRENCIES as readonly string[]).includes(currency)) return null;
  return { amount: round2(amount), currency: currency as ReimbursementCurrency };
}

/** "USD 1,500.00", or "0.00" when no fee is agreed (owner: unset shows as 0). */
export function formatHonorarium(h: Honorarium | null): string {
  if (!h) return "0.00";
  return `${h.currency} ${h.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * The three template variables every speaker send exposes. One builder so the
 * six senders (bulk, single, reimbursement + profile-form invitations, the
 * received receipt, the agreement merge) cannot format the figure differently.
 */
export function honorariumVars(h: Honorarium | null): {
  honorarium: string;
  honorariumAmount: string;
  honorariumCurrency: string;
} {
  return {
    honorarium: formatHonorarium(h),
    honorariumAmount: h ? h.amount.toFixed(2) : "0.00",
    honorariumCurrency: h?.currency ?? "",
  };
}

/**
 * The claim lines a submission actually carries: the organiser's fee first
 * (when agreed), then the speaker's expense lines. Any SPEAKER_FEE line in the
 * input is DROPPED whichever way it got there — a snapshot saved before the
 * lock, or a crafted request — because the fee is the organiser's figure or
 * nothing. Shared by the form (totals + receipt rule) and the public POST so
 * the two cannot disagree about what is being claimed.
 */
export function effectiveClaimLines(honorarium: Honorarium | null, lines: ClaimLine[]): ClaimLine[] {
  const expenses = lines.filter((l) => l.item !== "SPEAKER_FEE");
  if (!honorarium) return expenses;
  return [{ item: "SPEAKER_FEE", currency: honorarium.currency, amount: honorarium.amount }, ...expenses];
}

/** Body of PATCH .../speakers/[speakerId]/honorarium. Amount 0 clears the fee. */
export const honorariumInputSchema = z.object({
  amount: z.number().min(0).max(1_000_000),
  currency: z.enum(REIMBURSEMENT_CURRENCIES),
});
export type HonorariumInput = z.infer<typeof honorariumInputSchema>;

/**
 * Removes the two honorarium columns from a speaker payload for callers
 * outside the reimbursement boundary. The speaker list + detail GETs return
 * whole rows (Prisma `include`), so without this every new Speaker column is
 * readable by MEMBER / ONSITE / WEBINARS, whom the owner excluded from
 * reimbursement data. Pure; returns a shallow copy minus the two keys.
 */
export function stripHonorariumFields<T extends object>(
  row: T,
): Omit<T, "honorariumAmount" | "honorariumCurrency"> {
  const copy = { ...(row as Record<string, unknown>) };
  delete copy.honorariumAmount;
  delete copy.honorariumCurrency;
  return copy as Omit<T, "honorariumAmount" | "honorariumCurrency">;
}

/** Max uploaded documents per reimbursement (sanity cap on the token route). */
export const MAX_REIMBURSEMENT_DOCUMENTS = 15;
