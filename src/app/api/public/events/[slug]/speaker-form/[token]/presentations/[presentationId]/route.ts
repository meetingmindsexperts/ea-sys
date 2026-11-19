/**
 * One of the speaker's own presentations, on their form link (Nov 19, 2026).
 *
 *   DELETE            removes a READY file THEY sent (never one staff
 *                     uploaded; the row is kept, so staff can recover it);
 *                     closed once the event has ended, as uploading is
 *   DELETE ?abandon=1 the upload failed in the browser: the row stops
 *                     holding quota. Only ever an upload still in flight.
 */
import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { getClientIp } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { loadProfileFormForSlug, resolveProfileFormEventOrg } from "@/lib/speaker-profile/server";
import { presentationRefusal, speakerFormPresentationLimit } from "@/lib/speaker-presentation-http";
import { abandonPresentationUpload, deleteSpeakerPresentation } from "@/services/speaker-presentation-service";

type RouteParams = { params: Promise<{ slug: string; token: string; presentationId: string }> };

export async function DELETE(req: Request, { params }: RouteParams) {
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
      // An upload still in flight is only ever abandoned, whatever was asked:
      // a page open since before removal existed sends a bare DELETE to mean
      // exactly that. Abandon touches nothing that is not UPLOADING.
      const abandoned = await abandonPresentationUpload({ ...scope, presentationId: p.presentationId });
      if (abandoned.abandoned || new URL(req.url).searchParams.get("abandon") === "1") {
        return NextResponse.json(abandoned);
      }
      if (form.event.endDate && form.event.endDate.getTime() < Date.now()) {
        apiLogger.warn({ slug: p.slug, formId: form.id }, "speaker-form-presentation:event-ended");
        return NextResponse.json({ error: "This event has ended, so files can no longer be changed. Contact the organisers.", code: "EVENT_ENDED" }, { status: 409 });
      }
      const result = await deleteSpeakerPresentation({ ...scope, presentationId: p.presentationId, actor: { source: "speaker-form" } });
      if (!result.ok) {
        apiLogger.warn({ slug: p.slug, formId: form.id, presentationId: p.presentationId }, "speaker-form-presentation:delete-not-found");
        return presentationRefusal(result);
      }
      return NextResponse.json({ ok: true });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "speaker-form-presentation:delete-failed");
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
