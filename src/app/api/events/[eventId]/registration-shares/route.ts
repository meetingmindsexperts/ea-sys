/**
 * Shared registration views, list + create (Sep 29, 2026;
 * docs/REGISTRATION_SHARE_PLAN.md). Same boundary as the abstracts share
 * routes: `registrations.share` (admins and organisers) + the access-scoped event.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { runWithTenant } from "@/lib/tenant-context";
import { resolveShareEvent } from "@/lib/share-link-access";
import { registrationViewBodySchema, toViewInput, viewErrorResponse } from "@/lib/registration-share-http";
import { createRegistrationView, listRegistrationViews } from "@/services/registration-share-service";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { eventId } = await params;
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const gate = requirePermission(session, "registrations.share", { route: "events/[eventId]/registration-shares:GET", eventId });
    if (!gate.ok) return gate.response;
    const r = await resolveShareEvent(session, "events/[eventId]/registration-shares:GET", eventId, gate.eventWhere);
    if (r.error) return r.error;
    return await runWithTenant(r.event.organizationId, async () => {
      const data = await listRegistrationViews(r.event.id, r.event.slug);
      return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "registration-shares:get-failed" });
    return NextResponse.json({ error: "Failed to load shared views" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const [{ eventId }, body] = await Promise.all([params, req.json().catch(() => null)]);
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const gate = requirePermission(session, "registrations.share", { route: "events/[eventId]/registration-shares:POST", eventId });
    if (!gate.ok) return gate.response;
    const r = await resolveShareEvent(session, "events/[eventId]/registration-shares:POST", eventId, gate.eventWhere);
    if (r.error) return r.error;

    const parsed = registrationViewBodySchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "registration-shares:invalid-input", eventId, errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }
    const scope = { eventId: r.event.id, slug: r.event.slug, organizationId: r.event.organizationId, userId: session.user.id };
    return await runWithTenant(r.event.organizationId, async () => {
      const result = await createRegistrationView(scope, toViewInput(parsed.data));
      if (!result.ok) {
        apiLogger.warn({ msg: "registration-shares:create-refused", eventId, code: result.code });
        return viewErrorResponse(result.code, result.message);
      }
      return NextResponse.json({ id: result.id, ...(await listRegistrationViews(r.event.id, r.event.slug)) }, { status: 201 });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "registration-shares:post-failed" });
    return NextResponse.json({ error: "Failed to create the shared view" }, { status: 500 });
  }
}
