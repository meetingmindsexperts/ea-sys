/**
 * The speaker's file itself, on the LOCAL storage provider only (development
 * and the test server). On S3 the service answers 404: the app never carries
 * a large body (Nov 19, 2026).
 */
import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { getClientIp } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { loadProfileFormForSlug, resolveProfileFormEventOrg } from "@/lib/speaker-profile/server";
import { presentationRefusal, readUploadedFile, speakerFormPresentationLimit } from "@/lib/speaker-presentation-http";
import { presentationFileRouteAvailable, receiveLocalPresentationFile } from "@/services/speaker-presentation-service";

type RouteParams = { params: Promise<{ slug: string; token: string; presentationId: string }> };

export async function POST(req: Request, { params }: RouteParams) {
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
      // Before the body is read: on S3 the app never buffers a file.
      if (!presentationFileRouteAvailable()) {
        apiLogger.warn({ slug: p.slug, formId: form.id }, "speaker-form-presentation:file-route-off");
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      const bytes = await readUploadedFile(req);
      if (!bytes) {
        apiLogger.warn({ slug: p.slug, formId: form.id }, "speaker-form-presentation:no-file");
        return NextResponse.json({ error: "No file provided" }, { status: 400 });
      }
      const result = await receiveLocalPresentationFile({ ...scope, presentationId: p.presentationId, bytes });
      if (!result.ok) {
        apiLogger.warn({ slug: p.slug, formId: form.id, code: result.code }, "speaker-form-presentation:file-refused");
        return presentationRefusal(result);
      }
      return new NextResponse(null, { status: 204 });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "speaker-form-presentation:post-failed");
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
