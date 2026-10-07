/**
 * One shared registration view: update or delete (Sep 29, 2026;
 * docs/REGISTRATION_SHARE_PLAN.md). The view is looked up within the
 * access-scoped event, so another event's view id is a 404.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { runWithTenant } from "@/lib/tenant-context";
import { resolveShareEvent } from "@/lib/share-link-access";
import { registrationViewBodySchema, SPONSOR_NEEDS_FINANCE, toViewInput, viewDisclosesSponsors, viewErrorResponse } from "@/lib/registration-share-http";
import { can } from "@/lib/permissions/can";
import { deleteRegistrationView, listRegistrationViews, updateRegistrationView } from "@/services/registration-share-service";

interface RouteParams {
  params: Promise<{ eventId: string; viewId: string }>;
}

export async function PUT(req: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const [{ eventId, viewId }, body] = await Promise.all([params, req.json().catch(() => null)]);
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const gate = requirePermission(session, "registrations.share", { route: "events/[eventId]/registration-shares/[viewId]:PUT", eventId });
    if (!gate.ok) return gate.response;
    const r = await resolveShareEvent(session, "events/[eventId]/registration-shares/[viewId]:PUT", eventId, gate.eventWhere);
    if (r.error) return r.error;

    const parsed = registrationViewBodySchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "registration-shares:invalid-input", eventId, viewId, errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }
    if (viewDisclosesSponsors(parsed.data) && !can(gate.principal, "finance.view")) {
      apiLogger.warn({ msg: "registration-shares:sponsor-needs-finance", eventId, userId: session.user.id });
      return NextResponse.json(SPONSOR_NEEDS_FINANCE, { status: 403 });
    }
    const scope = { eventId: r.event.id, slug: r.event.slug, organizationId: r.event.organizationId, userId: session.user.id };
    return await runWithTenant(r.event.organizationId, async () => {
      const result = await updateRegistrationView(scope, viewId, toViewInput(parsed.data));
      if (!result.ok) {
        apiLogger.warn({ msg: "registration-shares:update-refused", eventId, viewId, code: result.code });
        return viewErrorResponse(result.code, result.message);
      }
      return NextResponse.json(await listRegistrationViews(r.event.id, r.event.slug));
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "registration-shares:put-failed" });
    return NextResponse.json({ error: "Failed to save the shared view" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { eventId, viewId } = await params;
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const gate = requirePermission(session, "registrations.share", { route: "events/[eventId]/registration-shares/[viewId]:DELETE", eventId });
    if (!gate.ok) return gate.response;
    const r = await resolveShareEvent(session, "events/[eventId]/registration-shares/[viewId]:DELETE", eventId, gate.eventWhere);
    if (r.error) return r.error;
    const scope = { eventId: r.event.id, slug: r.event.slug, organizationId: r.event.organizationId, userId: session.user.id };
    return await runWithTenant(r.event.organizationId, async () => {
      const result = await deleteRegistrationView(scope, viewId);
      if (!result.ok) {
        apiLogger.warn({ msg: "registration-shares:delete-refused", eventId, viewId, code: result.code });
        return viewErrorResponse(result.code, result.message);
      }
      return NextResponse.json(await listRegistrationViews(r.event.id, r.event.slug));
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "registration-shares:delete-failed" });
    return NextResponse.json({ error: "Failed to remove the shared view" }, { status: 500 });
  }
}
