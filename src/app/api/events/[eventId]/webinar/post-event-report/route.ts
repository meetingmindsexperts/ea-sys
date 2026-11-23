import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { findGatedEvent } from "@/lib/tenant/event-tenant";
import { requirePermission } from "@/lib/permissions/require-permission";
import { can } from "@/lib/permissions/can";
import { eventFactsOf } from "@/lib/permissions/event-facts";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { checkRateLimit } from "@/lib/security";
import { contentDisposition } from "@/lib/download-filename";
import { loadPostEventReport } from "@/lib/webinar/post-event-report-server";
import { generatePostEventReportPdf } from "@/lib/webinar/post-event-report-pdf";

type RouteParams = { params: Promise<{ eventId: string }> };

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * A webinar's post-event report (Nov 23, 2026; post-event-report.ts): registrations, attendance,
 * questions and survey results, as JSON for the page at /events/[id]/analytics/report, or with
 * ?format=pdf as the PDF to forward to a client. No names or emails, so the key is the one the
 * webinar's reports already ask, `webinar.analytics.read`; the survey results are in it only for a
 * caller who may also read them (`surveys.read`). Survey comments go into the PDF only with
 * ?comments=1, which the report page sends when its box is ticked beside the warning about typed text;
 * the console's download, which shows no warning, sends nothing and gets none (review of cdec0c859).
 * Both views read every viewer's record, so both are limited per person.
 */
export async function GET(req: Request, { params }: RouteParams) {
  let eventIdForLog: string | undefined;
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    eventIdForLog = eventId;
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const route = "events/[eventId]/webinar/post-event-report:GET";
    const orgGuard = requireOrgId(session, { route });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "webinar.analytics.read", { route, eventId, onMissing: "hide" });
    if (!gate.ok) return gate.response;
    const search = new URL(req.url).searchParams;
    const asPdf = search.get("format") === "pdf";
    // The page shows the comments with its warning beside them; a PDF carries them only when asked.
    const includeComments = !asPdf || search.get("comments") === "1";

    const limit = asPdf ? 30 : 120;
    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `post-event-report-${asPdf ? "pdf" : "view"}:${session.user.id}`,
      limit,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ eventId, userId: session.user.id, retryAfterSeconds, asPdf }, "post-event-report:rate-limited");
      return NextResponse.json(
        { error: "Too many requests for this report. Try again later.", retryAfterSeconds, limit, windowSeconds: 3600 },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    return await runWithTenant(orgGuard.orgId, async () => {
      const event = await findGatedEvent(gate, {
        select: {
          id: true,
          name: true,
          slug: true,
          timezone: true,
          settings: true,
          eventType: true,
          organizationId: true,
          surveyConfig: true,
          surveyIntroHtml: true,
          surveyThankYouHtml: true,
          staffAssignments: { select: { userId: true } },
          organization: {
            select: {
              name: true,
              companyName: true,
              companyAddress: true,
              companyCity: true,
              companyZipCode: true,
              companyCountry: true,
              logo: true,
            },
          },
        },
      });
      if (!event) {
        apiLogger.warn({ eventId, userId: session.user.id }, "post-event-report:event-not-found");
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      if (event.eventType !== "WEBINAR") {
        apiLogger.warn({ eventId, eventType: event.eventType }, "post-event-report:not-a-webinar");
        return NextResponse.json({ error: "The post-event report is for webinars.", code: "NOT_A_WEBINAR" }, { status: 409 });
      }

      const facts = eventFactsOf({ ...event, staffUserIds: event.staffAssignments.map((a) => a.userId) });
      const includeSurveys = can(gate.principal, "surveys.read", { event: facts });
      const report = await loadPostEventReport(event, { includeSurveys, includeComments });

      if (!asPdf) return NextResponse.json(report, { headers: NO_STORE });

      const org = event.organization;
      const pdf = await generatePostEventReportPdf(report, {
        name: org?.name ?? "",
        companyName: org?.companyName ?? null,
        address: org?.companyAddress ?? null,
        city: org?.companyCity ?? null,
        zipCode: org?.companyZipCode ?? null,
        country: org?.companyCountry ?? null,
        logoPath: org?.logo ?? null,
      });
      apiLogger.info(
        { eventId, userId: session.user.id, bytes: pdf.length, includeSurveys, includeComments },
        "post-event-report:pdf-generated",
      );
      return new NextResponse(new Uint8Array(pdf), {
        status: 200,
        headers: {
          ...NO_STORE,
          "Content-Type": "application/pdf",
          "Content-Disposition": contentDisposition(`post-event-report-${event.slug}.pdf`),
        },
      });
    });
  } catch (error) {
    apiLogger.error({ err: error, eventId: eventIdForLog }, "post-event-report:failed");
    return NextResponse.json({ error: "Failed to build the post-event report" }, { status: 500 });
  }
}
