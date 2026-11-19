/**
 * A speaker's presentations, on their own form link (Nov 19, 2026;
 * docs/SPEAKER_PRESENTATIONS_PLAN.md). Public: the token in the link is the
 * key, as for the rest of the speaker form.
 *
 *   GET  the speaker's talks and the files received for them
 *   POST allow an upload: answers what the browser needs to send the file
 *        straight to storage
 *
 * Unlike the passport and cover letter, these stay open after the form is
 * submitted: slides come weeks later, and can be replaced.
 */
import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { getClientIp } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { askedItemsForForm, loadProfileFormForSlug, resolveProfileFormEventOrg } from "@/lib/speaker-profile/server";
import { presentationRefusal, speakerFormPresentationLimit, startPresentationUploadSchema, startUploadResponse } from "@/lib/speaker-presentation-http";
import { listSpeakerPresentations, startPresentationUpload } from "@/services/speaker-presentation-service";

type RouteParams = { params: Promise<{ slug: string; token: string }> };

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const p = await params;
    const limited = speakerFormPresentationLimit(getClientIp(req), p.token, p.slug);
    if (limited) return limited;
    const org = await resolveProfileFormEventOrg(req, p.slug);
    if (!org) {
      apiLogger.warn({ slug: p.slug, stage: "presentation-org" }, "speaker-form-presentation:invalid-token");
      return NextResponse.json({ error: "This link is invalid." }, { status: 404 });
    }
    return await runWithTenant(org, async () => {
      // Open on a SUBMITTED form too: slides come weeks after the passport.
      const form = await loadProfileFormForSlug(req, p.slug, p.token);
      if (!form) {
        apiLogger.warn({ slug: p.slug, stage: "presentation" }, "speaker-form-presentation:invalid-token");
        return NextResponse.json({ error: "This link is invalid." }, { status: 404 });
      }
      const scope = { eventId: form.eventId, organizationId: form.event.organizationId, speakerId: form.speaker.id };
      // Not asked of this speaker: the page hides the section, as it does
      // where presentations are switched off.
      if (!askedItemsForForm(form).includes("presentation")) {
        return NextResponse.json({ enabled: false, slots: [], presentations: [] });
      }
      return NextResponse.json(await listSpeakerPresentations(scope));
    });
  } catch (error) {
    apiLogger.error({ err: error }, "speaker-form-presentation:get-failed");
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const p = await params;
    const limited = speakerFormPresentationLimit(getClientIp(req), p.token, p.slug);
    if (limited) return limited;
    const body = await req.json().catch(() => null);
    const org = await resolveProfileFormEventOrg(req, p.slug);
    if (!org) {
      apiLogger.warn({ slug: p.slug, stage: "presentation-org" }, "speaker-form-presentation:invalid-token");
      return NextResponse.json({ error: "This link is invalid." }, { status: 404 });
    }
    return await runWithTenant(org, async () => {
      // Open on a SUBMITTED form too: slides come weeks after the passport.
      const form = await loadProfileFormForSlug(req, p.slug, p.token);
      if (!form) {
        apiLogger.warn({ slug: p.slug, stage: "presentation" }, "speaker-form-presentation:invalid-token");
        return NextResponse.json({ error: "This link is invalid." }, { status: 404 });
      }
      const scope = { eventId: form.eventId, organizationId: form.event.organizationId, speakerId: form.speaker.id };
      // The door closes with the event: a link forwarded or leaked is not a
      // way to store files for ever. Staff can still upload from the speaker page.
      if (form.event.endDate && form.event.endDate.getTime() < Date.now()) {
        apiLogger.warn({ slug: p.slug, formId: form.id }, "speaker-form-presentation:event-ended");
        return NextResponse.json({ error: "This event has ended, so uploads are closed. Contact the organisers.", code: "EVENT_ENDED" }, { status: 409 });
      }
      if (!askedItemsForForm(form).includes("presentation")) {
        apiLogger.warn({ slug: p.slug, formId: form.id, item: "presentation" }, "speaker-form-presentation:not-asked");
        return NextResponse.json({ error: "A presentation is not needed for this form. Reload the page.", code: "NOT_ASKED" }, { status: 409 });
      }
      const parsed = startPresentationUploadSchema.safeParse(body);
      if (!parsed.success) {
        apiLogger.warn({ slug: p.slug, formId: form.id, errors: parsed.error.flatten() }, "speaker-form-presentation:zod-validation-failed");
        return NextResponse.json({ error: "Invalid input" }, { status: 400 });
      }
      const result = await startPresentationUpload({ ...scope, ...parsed.data, actor: { source: "speaker-form" } });
      if (!result.ok) return presentationRefusal(result);
      return startUploadResponse(result, (id) => `/api/public/events/${p.slug}/speaker-form/${p.token}/presentations/${id}/file`);
    });
  } catch (error) {
    apiLogger.error({ err: error }, "speaker-form-presentation:post-failed");
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
