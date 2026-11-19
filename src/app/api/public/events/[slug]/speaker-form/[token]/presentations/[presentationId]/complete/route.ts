/**
 * The speaker's upload has finished: the service checks the file that landed
 * before it counts (Nov 19, 2026).
 */
import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { getClientIp } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { loadProfileFormForSlug, resolveProfileFormEventOrg } from "@/lib/speaker-profile/server";
import { presentationRefusal, speakerFormPresentationLimit } from "@/lib/speaker-presentation-http";
import { completePresentationUpload } from "@/services/speaker-presentation-service";

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
      const result = await completePresentationUpload({ ...scope, presentationId: p.presentationId, actor: { source: "speaker-form" } });
      if (!result.ok) return presentationRefusal(result);
      return NextResponse.json({ presentation: result.presentation });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "speaker-form-presentation:post-failed");
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
