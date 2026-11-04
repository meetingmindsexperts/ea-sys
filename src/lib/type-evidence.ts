/**
 * What a registration type asks a person to prove, and what is still missing
 * (Nov 4, 2026). One place for the member ID, student ID, its expiry and the
 * supporting document, judged against the type's own switches.
 *
 * Three callers, so the rule lives here rather than in any of them:
 *   - the abstract sign-up doors (presenter-signup.ts), which refuse a
 *     submitter who leaves them out;
 *   - the ID and document request link (evidence-request-service.ts and the
 *     public verify-details page), which collects them afterwards from people
 *     who registered before the doors asked;
 *   - the Registrations list's "Missing ID or document" filter.
 *
 * Built on identity-evidence.ts and supporting-document.ts, which the delegate
 * form already uses, so all of them read the switches the same way.
 *
 * Client-safe and pure.
 */
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  readIdentityEvidencePolicy,
  missingIdentityEvidence,
  hasInvalidExpiryDate,
  type IdentityEvidencePolicy,
} from "@/lib/identity-evidence";
import {
  resolveSupportingDocument,
  requiresSupportingDocument,
  supportingDocumentBlocks,
  supportingDocumentLabel,
  type SupportingDocumentPolicy,
} from "@/lib/supporting-document";

/** A ticket type's identity and document switches. */
export type TypeEvidencePolicy = Partial<IdentityEvidencePolicy> & SupportingDocumentPolicy;

/** What a person gave (or has on file) for those switches. */
export interface TypeEvidenceInput {
  memberId?: string | null;
  studentId?: string | null;
  studentIdExpiry?: string | null;
  supportingDocumentUrl?: string | null;
  supportingDocumentFilename?: string | null;
}

/** The request fields for that evidence (same limits as the delegate form). */
export const typeEvidenceShape = {
  memberId: z.string().max(100).optional(),
  studentId: z.string().max(100).optional(),
  studentIdExpiry: z.string().max(20).optional(),
  supportingDocumentUrl: z.string().max(500).optional(),
  supportingDocumentFilename: z.string().max(255).optional(),
};

/** A field a form marks, by name. */
export type TypeEvidenceField = "memberId" | "studentId" | "studentIdExpiry" | "supportingDocument";

export type TypeEvidenceRefusal = {
  ok: false;
  code: "IDENTITY_EVIDENCE_REQUIRED" | "INVALID_EXPIRY_DATE" | "DOCUMENT_REQUIRED";
  message: string;
  /** The fields to mark, so the form can point at each one. */
  fields: TypeEvidenceField[];
  /** Why a submitted document was not accepted, for the log (it came from the client). */
  dropped?: "not-our-upload" | "type-does-not-ask";
};

/** missingIdentityEvidence() names fields by label; forms mark them by name. */
const FIELD_BY_LABEL: Record<string, TypeEvidenceField> = {
  "Member ID": "memberId",
  "Student ID": "studentId",
  "Student ID expiry date": "studentIdExpiry",
};

/** True when the type asks for anything a person has to give. */
export function asksForEvidence(policy: TypeEvidencePolicy | null | undefined): boolean {
  const identity = readIdentityEvidencePolicy(policy);
  return identity.requiresMemberId || identity.requiresStudentId || requiresSupportingDocument(policy);
}

/**
 * The type's rules checked against what was given. Everything missing comes
 * back in one answer, so nobody is refused twice in a row.
 */
export function checkTypeEvidence(
  policy: TypeEvidencePolicy,
  eventId: string,
  evidence: TypeEvidenceInput | undefined,
): { ok: true } | TypeEvidenceRefusal {
  const missing = missingIdentityEvidence(readIdentityEvidencePolicy(policy), evidence ?? {});
  const document = resolveSupportingDocument(
    policy,
    eventId,
    evidence?.supportingDocumentUrl,
    evidence?.supportingDocumentFilename,
  );
  const dropped = document.dropped ? { dropped: document.dropped } : {};
  const documentLabel = supportingDocumentLabel(policy);
  if (missing.length > 0) {
    const labels = document.missingRequired ? [...missing, documentLabel] : missing;
    return {
      ok: false,
      code: "IDENTITY_EVIDENCE_REQUIRED",
      message: `${labels.join(" and ")} ${labels.length > 1 ? "are" : "is"} required for this registration type.`,
      fields: [
        ...missing.map((label) => FIELD_BY_LABEL[label]).filter((f) => f !== undefined),
        ...(document.missingRequired ? (["supportingDocument"] as const) : []),
      ],
      ...dropped,
    };
  }
  if (hasInvalidExpiryDate(evidence ?? {})) {
    return {
      ok: false,
      code: "INVALID_EXPIRY_DATE",
      message: "Please enter a valid student ID expiry date.",
      fields: document.missingRequired ? ["studentIdExpiry", "supportingDocument"] : ["studentIdExpiry"],
      ...dropped,
    };
  }
  if (document.missingRequired) {
    return {
      ok: false,
      code: "DOCUMENT_REQUIRED",
      message: `${documentLabel} is required for this registration type.`,
      fields: ["supportingDocument"],
      ...dropped,
    };
  }
  return { ok: true };
}

/** What a registration already holds, as stored. */
export interface EvidenceOnFile {
  memberId: string | null;
  studentId: string | null;
  studentIdExpiry: Date | string | null;
  supportingDocumentUrl: string | null;
}

/**
 * The fields this type asks for that the registration does not hold yet. The
 * document counts only when the type asks for it (blocking or not): the
 * request link exists to collect what an organiser asked for.
 */
export function missingEvidenceFields(policy: TypeEvidencePolicy | null | undefined, onFile: EvidenceOnFile): TypeEvidenceField[] {
  const identity = readIdentityEvidencePolicy(policy);
  const out: TypeEvidenceField[] = [];
  // Empty means null or "", exactly as MISSING_EVIDENCE_WHERE says it, so the
  // screen and the export cannot disagree (review of 4d890f35). Saves trim, so
  // a whitespace-only value is not one this feature writes.
  if (identity.requiresMemberId && !onFile.memberId) out.push("memberId");
  if (identity.requiresStudentId && !onFile.studentId) out.push("studentId");
  if (identity.requiresStudentIdExpiry && !onFile.studentIdExpiry) out.push("studentIdExpiry");
  if (requiresSupportingDocument(policy) && !onFile.supportingDocumentUrl) out.push("supportingDocument");
  return out;
}

/** Human labels for the fields, in the order a person sees them. */
export function evidenceFieldLabel(field: TypeEvidenceField, policy: TypeEvidencePolicy | null | undefined): string {
  if (field === "memberId") return "Member ID";
  if (field === "studentId") return "Student ID";
  if (field === "studentIdExpiry") return "Student ID expiry date";
  return supportingDocumentLabel(policy);
}

/** True when a missing document would block (versus ask-but-not-block). */
export function evidenceDocumentBlocks(policy: TypeEvidencePolicy | null | undefined): boolean {
  return supportingDocumentBlocks(policy);
}

/**
 * Registrations whose type asks for something they do not hold: the
 * Registrations list's "Missing ID or document" filter. Not CANCELLED. One
 * clause with its own OR, so it can sit inside an AND beside other filters
 * without taking over a top-level OR.
 */
export const MISSING_EVIDENCE_WHERE: Prisma.RegistrationWhereInput = {
  AND: [
    { status: { not: "CANCELLED" } },
    {
      OR: [
        { ticketType: { requiresMemberId: true }, attendee: { OR: [{ memberId: null }, { memberId: "" }] } },
        { ticketType: { requiresStudentId: true }, attendee: { OR: [{ studentId: null }, { studentId: "" }] } },
        { ticketType: { requiresStudentId: true, requiresStudentIdExpiry: true }, attendee: { studentIdExpiry: null } },
        { ticketType: { requiresDocument: true }, supportingDocumentUrl: null },
      ],
    },
  ],
};
