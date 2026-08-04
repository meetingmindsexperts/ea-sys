/**
 * Public speaker profile form (token-gated, Aug 4 2026).
 *
 *   GET  → event branding + speaker prefill (name/photo/bio) + slot documents
 *   POST → submit: requires a photo + the passport document; optional bio
 *          written to Speaker.bio. Conditional claim PENDING → SUBMITTED.
 *
 * Mirrors the reimbursement public routes: plaintext token lookup, slug +
 * tenant asserted, org bootstrapped from the un-swept Event before any swept
 * read. Submitted forms are LOCKED — the organizer reopens from the speaker
 * page (audited) if changes are needed.
 */
import { NextResponse } from "next/server";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { notifyEventAdmins } from "@/lib/notifications";
import { formatPersonName } from "@/lib/utils";
import {
  missingProfileDocSlots,
  profileSubmitSchema,
  PROFILE_DOC_LABELS,
} from "@/lib/speaker-profile/constants";
import { loadProfileFormForSlug, resolveProfileFormEventOrg } from "@/lib/speaker-profile/server";

type RouteParams = { params: Promise<{ slug: string; token: string }> };

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { slug, token } = await params;
    const ip = getClientIp(req);
    const rl = checkRateLimit({ key: `speaker-form-load:${ip}`, limit: 120, windowMs: 3600_000 });
    if (!rl.allowed) {
      apiLogger.warn({ slug, ip }, "speaker-form:load-rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }

    const org = await resolveProfileFormEventOrg(req, slug);
    if (!org) {
      apiLogger.warn({ slug, stage: "load-org" }, "speaker-form:invalid-token");
      return NextResponse.json({ error: "This link is invalid." }, { status: 404 });
    }
    return await runWithTenant(org, async () => {
      const row = await loadProfileFormForSlug(req, slug, token);
      if (!row) {
        apiLogger.warn({ slug, stage: "load" }, "speaker-form:invalid-token");
        return NextResponse.json({ error: "This link is invalid." }, { status: 404 });
      }
      return NextResponse.json({
        status: row.status,
        submittedAt: row.submittedAt,
        event: {
          name: row.event.name,
          bannerImage: row.event.bannerImage,
          bannerImageMobile: row.event.bannerImageMobile,
          startDate: row.event.startDate,
          endDate: row.event.endDate,
          venue: row.event.venue,
          city: row.event.city,
          organizationName: row.event.organization?.name ?? null,
        },
        speaker: {
          name: formatPersonName(row.speaker.title, row.speaker.firstName, row.speaker.lastName),
          email: row.speaker.email,
          photo: row.speaker.photo,
          bio: row.speaker.bio,
          organization: row.speaker.organization,
          jobTitle: row.speaker.jobTitle,
        },
        documents: row.speaker.documents,
      });
    });
  } catch (err) {
    apiLogger.error({ err }, "speaker-form:GET failed");
    return NextResponse.json({ error: "Failed to load the form" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { slug, token } = await params;
    const ip = getClientIp(req);
    const ipLimit = checkRateLimit({ key: `speaker-form-submit:${ip}`, limit: 60, windowMs: 3600_000 });
    const tokenLimit = checkRateLimit({
      key: `speaker-form-submit-token:${token.slice(0, 16)}`,
      limit: 15,
      windowMs: 3600_000,
    });
    if (!ipLimit.allowed || !tokenLimit.allowed) {
      const retryAfterSeconds = Math.max(ipLimit.retryAfterSeconds ?? 0, tokenLimit.retryAfterSeconds ?? 0);
      apiLogger.warn({ slug, ip, stage: "submit" }, "speaker-form:submit-rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const body = await req.json().catch(() => ({}));
    const parsed = profileSubmitSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ slug, errors: parsed.error.flatten() }, "speaker-form:submit-invalid-input");
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    const org = await resolveProfileFormEventOrg(req, slug);
    if (!org) {
      apiLogger.warn({ slug, stage: "submit-org" }, "speaker-form:invalid-token");
      return NextResponse.json({ error: "This link is invalid." }, { status: 404 });
    }
    return await runWithTenant(org, async () => {
      const row = await loadProfileFormForSlug(req, slug, token);
      if (!row) {
        apiLogger.warn({ slug, stage: "submit" }, "speaker-form:invalid-token");
        return NextResponse.json({ error: "This link is invalid." }, { status: 404 });
      }
      if (row.status === "SUBMITTED") {
        apiLogger.warn({ slug, formId: row.id }, "speaker-form:already-submitted");
        return NextResponse.json(
          { error: "This form has already been submitted.", code: "ALREADY_SUBMITTED" },
          { status: 409 },
        );
      }

      // Server-side completeness gate (the form is a bypassable client).
      if (!row.speaker.photo) {
        apiLogger.warn({ slug, formId: row.id }, "speaker-form:missing-photo");
        return NextResponse.json(
          { error: "Please upload your photo before submitting.", code: "MISSING_PHOTO" },
          { status: 400 },
        );
      }
      const missing = missingProfileDocSlots(
        row.speaker.documents.map((d) => d.label ?? ""),
      );
      if (missing.length > 0) {
        apiLogger.warn({ slug, formId: row.id, missing }, "speaker-form:missing-documents");
        return NextResponse.json(
          {
            error: `Please upload: ${missing.map((s) => PROFILE_DOC_LABELS[s]).join(", ")}.`,
            code: "MISSING_DOCUMENTS",
            missing,
          },
          { status: 400 },
        );
      }

      const bio = parsed.data.bio?.trim() || null;
      const claimed = await tenantTransaction(async (tx) => {
        // Conditional claim — two tabs submitting race to ONE submission.
        const claim = await tx.speakerProfileForm.updateMany({
          where: { id: row.id, status: "PENDING" },
          data: { status: "SUBMITTED", submittedAt: new Date(), submittedIp: ip },
        });
        if (claim.count === 0) return false;
        if (bio) {
          await tx.speaker.update({ where: { id: row.speaker.id }, data: { bio } });
        }
        return true;
      });
      if (!claimed) {
        apiLogger.warn({ slug, formId: row.id }, "speaker-form:lost-submit-race");
        return NextResponse.json(
          { error: "This form has already been submitted.", code: "ALREADY_SUBMITTED" },
          { status: 409 },
        );
      }

      // Audit with IP (the agreement-acceptance shape) — the speaker is the
      // actor, no User row behind them.
      db.auditLog
        .create({
          data: {
            eventId: row.eventId,
            userId: null,
            organizationId: row.event.organizationId,
            action: "PROFILE_FORM_SUBMITTED",
            entityType: "Speaker",
            entityId: row.speaker.id,
            changes: {
              actor: "SPEAKER",
              formId: row.id,
              bioUpdated: bio != null,
              documents: row.speaker.documents.map((d) => d.label),
              ip,
            },
            ipAddress: ip,
          },
        })
        .catch((err) => apiLogger.error({ err, formId: row.id }, "speaker-form:audit-failed"));

      notifyEventAdmins(row.eventId, {
        // No dedicated notification type for speaker-profile data;
        // REGISTRATION is the closest person-data category (icon only).
        type: "REGISTRATION",
        title: "Speaker profile form submitted",
        message: `${formatPersonName(row.speaker.title, row.speaker.firstName, row.speaker.lastName)} submitted their photo & documents`,
        link: `/events/${row.eventId}/speakers/${row.speaker.id}`,
      }).catch((err) => apiLogger.error({ err, formId: row.id }, "speaker-form:notify-failed"));

      apiLogger.info({ slug, formId: row.id, speakerId: row.speaker.id }, "speaker-form:submitted");
      return NextResponse.json({ success: true });
    });
  } catch (err) {
    apiLogger.error({ err }, "speaker-form:POST failed");
    return NextResponse.json({ error: "Failed to submit the form" }, { status: 500 });
  }
}
