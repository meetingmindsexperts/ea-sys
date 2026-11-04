/**
 * The ID and document request page's API (Nov 4, 2026; src/lib/evidence-request.ts).
 *
 *   GET  ?token=   what this person's registration type still needs from them
 *   POST { token, memberId?, studentId?, studentIdExpiry?, supportingDocumentUrl?, supportingDocumentFilename? }
 *
 * Unauthenticated by design: the link IS the credential, a hashed
 * VerificationToken naming one registration, single use, with an expiry the
 * organiser chose. Rate limited per IP. Only the fields the type asks for and
 * the registration does not hold are asked or written; nothing already on file
 * is shown back or changed, so a forwarded link reveals and overwrites nothing.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { rateLimited } from "@/lib/api-errors";
import { eventMatchesRequestTenant } from "@/lib/public-event";
import { checkRateLimit, getClientIp, hashVerificationToken } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { resolveTenantOrg, normalizeHost } from "@/lib/tenant/resolver";
import { IDENTITY_EVIDENCE_SELECT } from "@/lib/identity-evidence";
import {
  SUPPORTING_DOCUMENT_POLICY_SELECT,
  resolveSupportingDocument,
  supportingDocumentInstructions,
  supportingDocumentLabel,
} from "@/lib/supporting-document";
import {
  checkTypeEvidence,
  evidenceDocumentBlocks,
  missingEvidenceFields,
  typeEvidenceShape,
  type TypeEvidenceField,
} from "@/lib/type-evidence";
import { parseEvidenceRequestIdentifier } from "@/lib/evidence-request";
import { syncToContact } from "@/lib/contact-sync";

interface RouteParams {
  params: Promise<{ slug: string }>;
}

const postSchema = z.object({
  token: z.string().min(1).max(200),
  ...typeEvidenceShape,
});

const LINK_PROBLEM = "This link is invalid or has already been used. Please contact the event organizer for a new link.";

const REGISTRATION_SELECT = {
  id: true,
  supportingDocumentUrl: true,
  ticketType: { select: { name: true, ...IDENTITY_EVIDENCE_SELECT, ...SUPPORTING_DOCUMENT_POLICY_SELECT } },
  attendee: {
    select: { id: true, firstName: true, lastName: true, email: true, memberId: true, studentId: true, studentIdExpiry: true },
  },
  event: {
    select: {
      id: true,
      name: true,
      slug: true,
      organizationId: true,
      startDate: true,
      bannerImage: true,
      bannerImageMobile: true,
      organization: { select: { name: true } },
    },
  },
} satisfies Prisma.RegistrationSelect;

type LinkedRegistration = Prisma.RegistrationGetPayload<{ select: typeof REGISTRATION_SELECT }>;

type Lookup =
  | { ok: false; response: NextResponse }
  | { ok: true; registration: LinkedRegistration; hashedToken: string };

function loadRegistration(registrationId: string): Promise<LinkedRegistration | null> {
  return db.registration.findFirst({
    where: { id: registrationId, status: { not: "CANCELLED" } },
    select: REGISTRATION_SELECT,
  });
}

/** Token → registration, with every refusal logged. Runs inside the tenant store. */
async function lookup(req: Request, slug: string, rawToken: string, route: string): Promise<Lookup> {
  const ip = getClientIp(req);
  const hashedToken = hashVerificationToken(rawToken);
  const token = await db.verificationToken.findUnique({ where: { token: hashedToken } });
  if (!token) {
    apiLogger.warn({ msg: `${route}:token-not-found`, slug, ip });
    return { ok: false, response: NextResponse.json({ error: LINK_PROBLEM, code: "LINK_INVALID" }, { status: 400 }) };
  }
  const registrationId = parseEvidenceRequestIdentifier(token.identifier);
  if (!registrationId) {
    apiLogger.warn({ msg: `${route}:wrong-token-kind`, slug, ip });
    return { ok: false, response: NextResponse.json({ error: LINK_PROBLEM, code: "LINK_INVALID" }, { status: 400 }) };
  }
  if (token.expires < new Date()) {
    await db.verificationToken.delete({ where: { token: hashedToken } }).catch((err) =>
      apiLogger.error({ msg: `${route}:expired-token-delete-failed`, registrationId, err }),
    );
    apiLogger.warn({ msg: `${route}:token-expired`, slug, registrationId, ip });
    return {
      ok: false,
      response: NextResponse.json(
        { error: "This link has expired. Please contact the event organizer for a new link.", code: "LINK_EXPIRED" },
        { status: 400 },
      ),
    };
  }
  const registration = await loadRegistration(registrationId);
  if (!registration) {
    apiLogger.warn({ msg: `${route}:registration-not-found`, slug, registrationId, ip });
    return { ok: false, response: NextResponse.json({ error: "This registration is no longer active.", code: "NOT_FOUND" }, { status: 404 }) };
  }
  if (registration.event.slug !== slug || !(await eventMatchesRequestTenant(req, registration.event.organizationId))) {
    apiLogger.warn({ msg: `${route}:wrong-event`, urlSlug: slug, registrationId, ip });
    return {
      ok: false,
      response: NextResponse.json(
        { error: "This link does not match the event. Please use the original link from your email.", code: "LINK_INVALID" },
        { status: 400 },
      ),
    };
  }
  return { ok: true, registration, hashedToken };
}

function stillMissing(registration: LinkedRegistration): TypeEvidenceField[] {
  return missingEvidenceFields(registration.ticketType, {
    memberId: registration.attendee.memberId,
    studentId: registration.attendee.studentId,
    studentIdExpiry: registration.attendee.studentIdExpiry,
    supportingDocumentUrl: registration.supportingDocumentUrl,
  });
}

export async function GET(req: Request, { params }: RouteParams) {
  const route = "public/verify-details:GET";
  try {
    const { slug } = await params;
    const rawToken = new URL(req.url).searchParams.get("token");
    if (!rawToken) {
      apiLogger.warn({ msg: `${route}:no-token`, slug });
      return NextResponse.json({ error: LINK_PROBLEM, code: "LINK_INVALID" }, { status: 400 });
    }
    const limit = checkRateLimit({ key: `verify-details-get:ip:${getClientIp(req)}`, limit: 30, windowMs: 15 * 60 * 1000 });
    if (!limit.allowed) return rateLimited(limit, { route, message: "Too many requests. Please try again shortly." });

    const tenant = await resolveTenantOrg(normalizeHost(req.headers.get("host")));
    return await runWithTenant(tenant.orgId ?? "", async () => {
      const found = await lookup(req, slug, rawToken, route);
      if (!found.ok) return found.response;
      const { registration } = found;
      const missing = stillMissing(registration);
      const type = registration.ticketType;
      return NextResponse.json({
        event: {
          name: registration.event.name,
          slug: registration.event.slug,
          startDate: registration.event.startDate,
          bannerImage: registration.event.bannerImage,
          bannerImageMobile: registration.event.bannerImageMobile,
          organizationName: registration.event.organization.name,
        },
        firstName: registration.attendee.firstName,
        lastName: registration.attendee.lastName,
        ticketTypeName: type?.name ?? null,
        missing,
        document: missing.includes("supportingDocument")
          ? {
              label: supportingDocumentLabel(type),
              instructions: supportingDocumentInstructions(type),
              required: evidenceDocumentBlocks(type),
            }
          : null,
      });
    });
  } catch (err) {
    apiLogger.error({ err, msg: `${route}:failed` });
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  const route = "public/verify-details:POST";
  try {
    const { slug } = await params;
    const ip = getClientIp(req);
    const limit = checkRateLimit({ key: `verify-details-post:ip:${ip}`, limit: 15, windowMs: 15 * 60 * 1000 });
    if (!limit.allowed) return rateLimited(limit, { route, message: "Too many attempts. Please try again shortly." });

    const parsed = postSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      apiLogger.warn({ msg: `${route}:validation-failed`, slug, errors: parsed.error.flatten().fieldErrors });
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }
    const body = parsed.data;

    const tenant = await resolveTenantOrg(normalizeHost(req.headers.get("host")));
    return await runWithTenant(tenant.orgId ?? "", async () => {
      const found = await lookup(req, slug, body.token, route);
      if (!found.ok) return found.response;
      const { registration, hashedToken } = found;
      const missing = stillMissing(registration);
      if (missing.length === 0) {
        await db.verificationToken.delete({ where: { token: hashedToken } }).catch((err) =>
          apiLogger.error({ msg: `${route}:token-delete-failed`, registrationId: registration.id, err }),
        );
        apiLogger.info({ msg: `${route}:nothing-missing`, registrationId: registration.id });
        return NextResponse.json({ ok: true, saved: [] });
      }

      // Only what is still missing is taken from the request; what is on file
      // stands, so the check below judges the registration as it will be.
      const take = (field: TypeEvidenceField, value: string | undefined) =>
        missing.includes(field) ? value?.trim() || null : null;
      const submitted = {
        memberId: take("memberId", body.memberId),
        studentId: take("studentId", body.studentId),
        studentIdExpiry: take("studentIdExpiry", body.studentIdExpiry),
      };
      const onFileExpiry = registration.attendee.studentIdExpiry?.toISOString().slice(0, 10) ?? null;
      const merged = {
        memberId: registration.attendee.memberId || submitted.memberId,
        studentId: registration.attendee.studentId || submitted.studentId,
        studentIdExpiry: onFileExpiry || submitted.studentIdExpiry,
        supportingDocumentUrl: registration.supportingDocumentUrl
          ?? (missing.includes("supportingDocument") ? body.supportingDocumentUrl : undefined),
        supportingDocumentFilename: body.supportingDocumentFilename,
      };
      const check = checkTypeEvidence(registration.ticketType ?? {}, registration.event.id, merged);
      if (!check.ok) {
        apiLogger.warn({
          msg: `${route}:refused`,
          code: check.code,
          fields: check.fields,
          dropped: check.dropped ?? null,
          registrationId: registration.id,
          ip,
        });
        return NextResponse.json({ error: check.message, code: check.code, fields: check.fields }, { status: 400 });
      }

      const document = missing.includes("supportingDocument")
        ? resolveSupportingDocument(registration.ticketType, registration.event.id, body.supportingDocumentUrl, body.supportingDocumentFilename)
        : null;
      if (document?.dropped) {
        apiLogger.warn({ msg: `${route}:document-dropped`, registrationId: registration.id, reason: document.dropped, ip });
      }
      const expiry = submitted.studentIdExpiry ? new Date(submitted.studentIdExpiry) : null;
      const saved: TypeEvidenceField[] = [
        ...(submitted.memberId ? (["memberId"] as const) : []),
        ...(submitted.studentId ? (["studentId"] as const) : []),
        ...(expiry ? (["studentIdExpiry"] as const) : []),
        ...(document?.url ? (["supportingDocument"] as const) : []),
      ];
      // A save that adds nothing must not use up the link: an ask-but-not-block
      // document left out, or one dropped as not ours, would otherwise burn it
      // and show "thank you" with nothing collected (review of 4d890f35, MED).
      if (saved.length === 0) {
        apiLogger.warn({ msg: `${route}:nothing-provided`, registrationId: registration.id, missing, ip });
        return NextResponse.json(
          { error: "Please add the details below before saving.", code: "NOTHING_PROVIDED", fields: missing },
          { status: 400 },
        );
      }

      await tenantTransaction(async (tx) => {
        // Single use: claiming the token is the first write, so two tabs cannot both save.
        const claimed = await tx.verificationToken.deleteMany({ where: { token: hashedToken } });
        if (claimed.count === 0) throw new LinkAlreadyUsedError(registration.id);
        // Each field only while it is still empty: an organiser who filled it in
        // since the page loaded keeps their value (review of 4d890f35, LOW).
        for (const [field, value] of [["memberId", submitted.memberId], ["studentId", submitted.studentId]] as const) {
          if (!value) continue;
          await tx.attendee.updateMany({
            where: { id: registration.attendee.id, OR: [{ [field]: null }, { [field]: "" }] },
            data: { [field]: value },
          });
        }
        if (expiry) {
          await tx.attendee.updateMany({
            where: { id: registration.attendee.id, studentIdExpiry: null },
            data: { studentIdExpiry: expiry },
          });
        }
        if (document?.url) {
          await tx.registration.updateMany({
            where: { id: registration.id, supportingDocumentUrl: null },
            data: { supportingDocumentUrl: document.url, supportingDocumentFilename: document.filename },
          });
        }
        await tx.auditLog.create({
          data: {
            eventId: registration.event.id,
            action: "EVIDENCE_PROVIDED",
            entityType: "Registration",
            entityId: registration.id,
            changes: { source: "evidence-request-link", saved, email: registration.attendee.email, ip },
          },
        });
      });

      apiLogger.info({ msg: `${route}:saved`, registrationId: registration.id, eventId: registration.event.id, saved });
      // The org contact carries these too, as on the registration forms.
      // Failure-isolated: the registration already holds them.
      await syncToContact({
        organizationId: registration.event.organizationId,
        eventId: registration.event.id,
        email: registration.attendee.email,
        firstName: registration.attendee.firstName,
        lastName: registration.attendee.lastName,
        ...(submitted.memberId && { memberId: submitted.memberId }),
        ...(submitted.studentId && { studentId: submitted.studentId }),
        ...(expiry && { studentIdExpiry: expiry }),
      }).catch((err) => apiLogger.error({ msg: `${route}:contact-sync-failed`, registrationId: registration.id, err }));
      return NextResponse.json({ ok: true, saved });
    });
  } catch (err) {
    if (err instanceof LinkAlreadyUsedError) {
      apiLogger.warn({ msg: `${route}:link-already-used`, registrationId: err.registrationId });
      return NextResponse.json({ error: LINK_PROBLEM, code: "LINK_INVALID" }, { status: 400 });
    }
    apiLogger.error({ err, msg: `${route}:failed` });
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

/** The token was used between the lookup and the save (a second tab). */
class LinkAlreadyUsedError extends Error {
  constructor(readonly registrationId: string) {
    super("LINK_ALREADY_USED");
    this.name = "LinkAlreadyUsedError";
  }
}
