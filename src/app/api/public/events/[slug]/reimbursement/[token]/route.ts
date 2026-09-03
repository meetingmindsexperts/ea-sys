/**
 * Public speaker-reimbursement form — tokenized load + submit (no login).
 *
 *   GET  /api/public/events/[slug]/reimbursement/[token]
 *     → validates the token, asserts it belongs to the URL's event, returns
 *       event branding + prefill (saved snapshot if any, else the Speaker
 *       record) + uploaded documents + status.
 *
 *   POST /api/public/events/[slug]/reimbursement/[token]
 *     → the full submission (sections B + C + D + F). Enforces the paper
 *       form's receipt rule server-side: passport copy always required,
 *       plus the matching receipt for every claimed expense type. A
 *       SUBMITTED form is LOCKED (409) until an organizer reopens it; the
 *       status flip is a conditional claim so double-submits can't race.
 *       On success: audit (with IP, the agreement-acceptance shape), admin
 *       notification, and a branded confirmation email to the speaker —
 *       both failure-isolated.
 *
 * Rate-limited per IP + per token. Every rejection logs `{ slug, stage }`.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { notifyEventAdmins } from "@/lib/notifications";
import {
  claimItemLabel,
  effectiveClaimLines,
  formatHonorarium,
  missingDocumentKinds,
  readHonorarium,
  reimbursementSubmitSchema,
  formatClaimTotals,
  type ClaimLine,
} from "@/lib/reimbursement/constants";
import { loadReimbursementForSlug, resolveReimbursementEventOrg } from "@/lib/reimbursement/server";
import { runWithTenant } from "@/lib/tenant-context";
import { escapeHtml } from "@/lib/html";
import {
  brandingCc,
  brandingFrom,
  getEventTemplate,
  renderAndWrap,
  sendEmail,
} from "@/lib/email";

type RouteParams = { params: Promise<{ slug: string; token: string }> };

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { slug, token } = await params;
    const ip = getClientIp(req);
    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `reimb-load:${ip}`,
      limit: 120,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ slug, ip, stage: "load" }, "reimbursement-public:rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    // Tenancy (Domain #17): resolve the tenant org from the un-swept Event by
    // host+slug FIRST — the swept token lookup below fail-closes without it.
    const org = await resolveReimbursementEventOrg(req, slug);
    if (!org) {
      apiLogger.warn({ slug, stage: "load-org" }, "reimbursement-public:invalid-token");
      return NextResponse.json({ error: "This reimbursement link is invalid." }, { status: 404 });
    }
    return await runWithTenant(org, async () => {
    const row = await loadReimbursementForSlug(req, slug, token);
    if (!row) {
      apiLogger.warn({ slug, stage: "load" }, "reimbursement-public:invalid-token");
      return NextResponse.json({ error: "This reimbursement link is invalid." }, { status: 404 });
    }

    return NextResponse.json({
      event: {
        slug: row.event.slug,
        name: row.event.name,
        bannerImage: row.event.bannerImage,
        bannerImageMobile: row.event.bannerImageMobile,
        startDate: row.event.startDate,
        endDate: row.event.endDate,
        timezone: row.event.timezone,
        eventType: row.event.eventType,
        venue: row.event.venue,
        city: row.event.city,
        organizationName: row.event.organization?.name ?? null,
      },
      status: row.status,
      submittedAt: row.submittedAt,
      // The organiser-agreed fee (Sep 3, 2026): rendered LOCKED on the form.
      // Null when none is agreed — the form shows 0 and offers no input.
      honorarium: readHonorarium(row.speaker),
      // Prefill: the saved snapshot wins (reopened edits resume where the
      // speaker left off); else seed from the Speaker record.
      prefill: {
        fullName: row.fullName ?? `${row.speaker.firstName} ${row.speaker.lastName}`.trim(),
        designation: row.designation ?? row.speaker.jobTitle ?? "",
        institution: row.institution ?? row.speaker.organization ?? "",
        country: row.country ?? row.speaker.country ?? "",
        // Always the Speaker record, never the saved snapshot: the form
        // shows it read-only and the POST writes exactly this value, so a
        // pre-lock submission that stored a divergent address is corrected
        // on the next submit rather than carried forward.
        email: row.speaker.email,
        phone: row.phone ?? row.speaker.phone ?? "",
        nationality: row.nationality ?? "",
        passportNumber: row.passportNumber ?? "",
        roleAtEvent: row.roleAtEvent ?? "",
        // Expense lines only. A snapshot saved before the fee lock may
        // carry a speaker-typed SPEAKER_FEE line; the organiser's figure
        // (`honorarium` above) is the only fee, so it is never re-offered.
        claimLines: ((row.claimLines as ClaimLine[] | null) ?? []).filter((l) => l.item !== "SPEAKER_FEE"),
        bankDetails: row.bankDetails ?? null,
        signedName: row.signedName ?? "",
      },
      documents: row.documents,
    });
    });
  } catch (err) {
    apiLogger.error({ err }, "reimbursement-public:load-failed");
    return NextResponse.json({ error: "Failed to load the reimbursement form" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { slug, token } = await params;
    const ip = getClientIp(req);
    // Generous per-IP ceiling (venue NAT) + a tight per-token bucket.
    const ipLimit = checkRateLimit({ key: `reimb-submit:${ip}`, limit: 60, windowMs: 3600_000 });
    const tokenLimit = checkRateLimit({
      key: `reimb-submit-token:${token.slice(0, 16)}`,
      limit: 15,
      windowMs: 3600_000,
    });
    if (!ipLimit.allowed || !tokenLimit.allowed) {
      const retryAfterSeconds = Math.max(
        ipLimit.retryAfterSeconds ?? 0,
        tokenLimit.retryAfterSeconds ?? 0,
      );
      apiLogger.warn({ slug, ip, stage: "submit" }, "reimbursement-public:rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const body = await req.json().catch(() => null);
    const parsed = reimbursementSubmitSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn(
        { slug, stage: "validate", errors: parsed.error.flatten() },
        "reimbursement-public:submit-invalid",
      );
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    // Tenancy (Domain #17): org bootstrap first (see GET) — the swept token
    // read + the conditional-claim updateMany below run on this org's lane.
    const org = await resolveReimbursementEventOrg(req, slug);
    if (!org) {
      apiLogger.warn({ slug, stage: "submit-load-org" }, "reimbursement-public:invalid-token");
      return NextResponse.json({ error: "This reimbursement link is invalid." }, { status: 404 });
    }
    return await runWithTenant(org, async () => {
    const row = await loadReimbursementForSlug(req, slug, token);
    if (!row) {
      apiLogger.warn({ slug, stage: "submit-load" }, "reimbursement-public:invalid-token");
      return NextResponse.json({ error: "This reimbursement link is invalid." }, { status: 404 });
    }
    if (row.status === "SUBMITTED") {
      apiLogger.warn({ slug, reimbursementId: row.id, stage: "locked" }, "reimbursement-public:already-submitted");
      return NextResponse.json(
        {
          error:
            "This form has already been submitted. Contact the organizing team if you need to make a change.",
          code: "ALREADY_SUBMITTED",
        },
        { status: 409 },
      );
    }

    const d = parsed.data;
    // The fee is the organiser's figure or nothing (Sep 3, 2026): the form
    // renders the "Honorarium / Speaker Fee" line LOCKED, so a SPEAKER_FEE
    // line arriving here is a pre-lock tab or a crafted request. It is
    // dropped, never honoured, and the agreed figure is injected from the
    // Speaker row — the same shape as the email lock above.
    const honorarium = readHonorarium(row.speaker);
    if (d.claimLines.some((l) => l.item === "SPEAKER_FEE")) {
      apiLogger.warn(
        { slug, reimbursementId: row.id, stage: "speaker-fee" },
        "reimbursement-public:speaker-fee-in-body-ignored",
      );
    }
    const claimLines: ClaimLine[] = effectiveClaimLines(
      honorarium,
      d.claimLines.map((l) => ({
        item: l.item,
        currency: l.currency,
        amount: Math.round(l.amount * 100) / 100,
      })),
    );
    if (claimLines.length === 0) {
      apiLogger.warn(
        { slug, reimbursementId: row.id, stage: "nothing-to-claim" },
        "reimbursement-public:nothing-to-claim",
      );
      return NextResponse.json(
        {
          error:
            "There is nothing to claim yet: no expenses were selected and no honorarium has been agreed for you.",
          code: "NOTHING_TO_CLAIM",
        },
        { status: 400 },
      );
    }

    // The paper form's rule, enforced: "Expenses without receipts cannot be
    // processed" — passport copy always, plus each claimed item's receipt.
    const uploadedKinds = row.documents.map((doc) => doc.kind);
    const missing = missingDocumentKinds(claimLines, uploadedKinds);
    if (missing.length > 0) {
      apiLogger.warn(
        { slug, reimbursementId: row.id, missing, stage: "documents" },
        "reimbursement-public:missing-documents",
      );
      return NextResponse.json(
        { error: "Required documents are missing.", code: "MISSING_DOCUMENTS", missing },
        { status: 400 },
      );
    }

    // Empty-string optionals → null so the stored snapshot is clean.
    const opt = (v: string | undefined) => (v && v.trim() ? v.trim() : null);
    const bank = d.bankDetails;
    const bankDetails = {
      beneficiaryName: bank.beneficiaryName.trim(),
      beneficiaryAddress: opt(bank.beneficiaryAddress),
      bankName: bank.bankName.trim(),
      bankAddress: opt(bank.bankAddress),
      bankCountry: opt(bank.bankCountry),
      accountNumber: opt(bank.accountNumber),
      iban: opt(bank.iban),
      swift: bank.swift.trim(),
      routingNumber: opt(bank.routingNumber),
      sortCode: opt(bank.sortCode),
      intermediaryBank: opt(bank.intermediaryBank),
    };

    // Conditional claim on PENDING: a double-click / two-tab race submits
    // exactly once — the loser lands in the count===0 branch.
    const { count } = await db.speakerReimbursement.updateMany({
      where: { id: row.id, status: "PENDING" },
      data: {
        status: "SUBMITTED",
        fullName: d.fullName.trim(),
        designation: opt(d.designation),
        institution: opt(d.institution),
        country: d.country.trim(),
        // From the Speaker row, not the body. The snapshot semantics are
        // kept (a later Change Email does not rewrite what was signed), but
        // what gets snapshotted is the canonical address, not user input.
        email: row.speaker.email.trim().toLowerCase(),
        phone: opt(d.phone),
        nationality: d.nationality.trim(),
        passportNumber: d.passportNumber.trim(),
        roleAtEvent: d.roleAtEvent.trim(),
        claimLines,
        bankDetails,
        signedName: d.signedName.trim(),
        submittedAt: new Date(),
        submittedIp: ip,
      },
    });
    if (count === 0) {
      apiLogger.warn({ slug, reimbursementId: row.id, stage: "claim-lost" }, "reimbursement-public:submit-race-lost");
      return NextResponse.json(
        { error: "This form has already been submitted.", code: "ALREADY_SUBMITTED" },
        { status: 409 },
      );
    }

    // Audit with IP — an externally-meaningful token-based write, same shape
    // as the speaker-agreement acceptance trail. Fire-and-forget.
    db.auditLog
      .create({
        data: {
          eventId: row.eventId,
          userId: null,
          action: "SUBMIT",
          entityType: "SPEAKER_REIMBURSEMENT",
          entityId: row.id,
          changes: {
            actor: "SPEAKER",
            speakerId: row.speaker.id,
            signedName: d.signedName.trim(),
            claimLines,
            totals: formatClaimTotals(claimLines),
            documents: uploadedKinds,
            ip,
          },
          ipAddress: ip,
        },
      })
      .catch((err) => apiLogger.error({ err, reimbursementId: row.id }, "reimbursement-public:audit-failed"));

    const speakerDisplayName = d.fullName.trim();
    const totals = formatClaimTotals(claimLines) || "—";

    // In-app notification for the org's admins/organizers (failure-isolated
    // inside the helper).
    notifyEventAdmins(row.eventId, {
      type: "PAYMENT",
      title: "Reimbursement form submitted",
      message: `${speakerDisplayName} submitted a reimbursement claim (${totals}) for ${row.event.name}.`,
      link: `/events/${row.eventId}/reimbursements`,
    }).catch((err) =>
      apiLogger.error({ err, reimbursementId: row.id }, "reimbursement-public:notify-failed"),
    );

    // Confirmation email to the speaker — their receipt of submission (the
    // declaration promises processing within 45 days of receipt, so the
    // timestamped email matters). Failure-isolated: the submission is
    // already committed and must never 500 because of a mail blip.
    try {
      const tpl = await getEventTemplate(row.eventId, "speaker-reimbursement-received");
      if (tpl) {
        const claimSummary = `<table style="width:100%;border-collapse:collapse;margin:12px 0;">${claimLines
          .map(
            (l) =>
              `<tr><td style="padding:6px 0;color:#6b7280;">${escapeHtml(claimItemLabel(l.item))}</td><td style="padding:6px 0;text-align:right;font-weight:500;">${escapeHtml(`${l.currency} ${l.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)}</td></tr>`,
          )
          .join("")}<tr><td style="padding:8px 0;border-top:1px solid #e5e7eb;font-weight:600;">Total</td><td style="padding:8px 0;border-top:1px solid #e5e7eb;text-align:right;font-weight:600;">${escapeHtml(totals)}</td></tr></table>`;
        const branding = tpl.branding;
        const rendered = renderAndWrap(
          { subject: tpl.subject, htmlContent: tpl.htmlContent, textContent: tpl.textContent },
          {
            firstName: row.speaker.firstName,
            speakerName: speakerDisplayName,
            eventName: row.event.name,
            claimSummary,
            claimSummaryText: claimLines
              .map((l) => `${claimItemLabel(l.item)}: ${l.currency} ${l.amount.toFixed(2)}`)
              .join("\n"),
            // The agreed fee as its own token too, so the receipt template can
            // name it outside the claim table ("0.00" when none is agreed).
            honorarium: formatHonorarium(honorarium),
            organizerName: row.event.organization?.name ?? "The organizing team",
          },
          branding,
          new Set(["claimSummary"]),
        );
        // The receipt goes to the address the link went to. A body-supplied
        // address here would let the person holding the token redirect the
        // one document that proves what they claimed and when.
        const recipient = row.speaker.email.trim().toLowerCase();
        await sendEmail({
          to: [{ email: recipient, name: speakerDisplayName }],
          cc: brandingCc(branding, [{ email: recipient }]),
          from: brandingFrom(branding),
          subject: rendered.subject,
          htmlContent: rendered.htmlContent,
          textContent: rendered.textContent,
          logContext: {
            // organizationId from the event (no session on a public route) —
            // without it the row is filtered out of the Email History card.
            organizationId: row.event.organizationId,
            eventId: row.eventId,
            entityType: "SPEAKER",
            entityId: row.speaker.id,
            templateSlug: "speaker-reimbursement-received",
          },
        });
      } else {
        apiLogger.error({ eventId: row.eventId }, "reimbursement-public:received-template-missing");
      }
    } catch (err) {
      apiLogger.error({ err, reimbursementId: row.id }, "reimbursement-public:confirmation-email-failed");
    }

    apiLogger.info({ slug, reimbursementId: row.id, totals }, "reimbursement-public:submitted");
    return NextResponse.json({ ok: true });
    });
  } catch (err) {
    apiLogger.error({ err }, "reimbursement-public:submit-failed");
    return NextResponse.json({ error: "Failed to submit the form" }, { status: 500 });
  }
}
