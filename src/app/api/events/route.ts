import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { resolveActingOrgId } from "@/lib/platform-operator";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { buildEventAccessWhere } from "@/lib/event-access";
import { EVENT_LIST_SELECT } from "@/lib/event-visibility";
import { isTeamRole } from "@/lib/auth-guards";
import { principalFromApiKey, refuseOutOfScope, requirePermission } from "@/lib/permissions/require-permission";
import { validateApiKey } from "@/lib/api-key";
import { eventOrderBy, parseEventSort } from "@/lib/event-sort";
import { createEvent } from "@/services/event-service";

const createEventSchema = z.object({
  name: z.string().min(2).max(255),
  description: z.string().max(2000).optional(),
  eventType: z.enum(["CONFERENCE", "WEBINAR", "HYBRID"]).optional(),
  tag: z.string().max(255).optional(),
  specialty: z.string().max(255).optional(),
  code: z.string().max(20).optional(),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
  venue: z.string().max(255).optional(),
  address: z.string().max(500).optional(),
  city: z.string().max(255).optional(),
  country: z.string().max(255).optional(),
});

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const slug = searchParams.get("slug") ?? undefined;
    const orderBy = eventOrderBy(parseEventSort({
      sort: searchParams.get("sort") ?? undefined,
      order: searchParams.get("order") ?? undefined,
    }));

    // Session auth covers all roles (ADMIN, ORGANIZER, REVIEWER, SUBMITTER).
    // REVIEWER and SUBMITTER have organizationId=null, so getOrgContext() would
    // incorrectly return null for them — handle session auth separately here.
    const session = await auth();
    if (session?.user) {
      // Org override, platform-operator only. Org-null roles (REVIEWER /
      // SUBMITTER / REGISTRANT) carry no own org, so the override cannot apply
      // to them and the nullish fallback keeps their existing behaviour.
      const user = { ...session.user };
      if (user.organizationId) {
        user.organizationId = resolveActingOrgId(req, session.user, user.organizationId, {
          route: "events:GET",
        });
      }

      // An org-null role (REVIEWER / SUBMITTER / REGISTRANT) reaches this route
      // for the same event picker everyone uses, but must not receive the
      // organiser payload: no registration or speaker headcounts, and none of
      // the Event row's configuration (settings JSON, bank details, tax config,
      // sender address) that a bare `include` would ship to their browser.
      if (!isTeamRole(user.role)) {
        const events = await db.event.findMany({
          where: { ...buildEventAccessWhere(user), ...(slug && { slug }) },
          orderBy,
          select: EVENT_LIST_SELECT,
        });
        return NextResponse.json(events);
      }

      // Staff: every event the person holds `events.read` on (WEBINARS reads
      // every org event, the desk view; ONSITE its assigned ones). A role that
      // holds none (CRM_USER, HR_USER) gets an empty list, never a 403.
      const gate = requirePermission({ ...session, user }, "events.read", { route: "events:GET", onMissing: "hide" });
      if (!gate.ok) return gate.response;
      const events = await db.event.findMany({
        where: { ...gate.eventWhere, ...(slug && { slug }) },
        orderBy,
        include: {
          _count: { select: { registrations: true, speakers: true } },
          organization: { select: { name: true } },
        },
      });
      return NextResponse.json(events);
    }

    // No session — check for API key (external tools like n8n)
    const rawKey =
      req.headers.get("x-api-key") ??
      req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
      null;

    if (!rawKey) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await validateApiKey(rawKey);
    if (!result) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const gate = requirePermission(principalFromApiKey(result.organizationId, result.grants), "events.read", {
      route: "events:GET",
      onMissing: "hide",
    });
    if (!gate.ok) return gate.response;
    const events = await db.event.findMany({
      where: { ...gate.eventWhere, ...(slug && { slug }) },
      orderBy,
      include: {
        _count: { select: { registrations: true, speakers: true } },
      },
    });

    return NextResponse.json(events);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching events" });
    return NextResponse.json(
      { error: "Failed to fetch events" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events:POST" });
    if ("error" in orgGuard) return orgGuard.error;

    const gate = requirePermission(session, "events.create", { route: "events:POST" });
    if (!gate.ok) return gate.response;

    const body = await req.json();
    const validated = createEventSchema.safeParse(body);

    if (!validated.success) {
        apiLogger.warn({ msg: "events:zod-validation-failed", errors: validated.error.flatten() });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { name, description, eventType, tag, specialty, code, startDate, endDate, venue, address, city, country } =
      validated.data;

    // The resulting-object rule (custom roles plan §3.2): a create under a
    // webinar-only grant must produce a webinar. An omitted type is stored as
    // null, which is not a webinar, so it is refused too: a hard refusal, not
    // a silent coercion.
    const outOfScope = refuseOutOfScope(gate.principal, "events.create", { eventType: eventType ?? "" }, { route: "events:POST" });
    if (outOfScope) return outOfScope;

    const result = await createEvent({
      organizationId: orgGuard.orgId,
      userId: session.user.id,
      name,
      description,
      eventType: eventType ?? null,
      tag,
      specialty,
      code,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      venue,
      address,
      city,
      country,
      source: "rest",
    });
    if (!result.ok) {
      // The service logs the refusal with its code.
      const status = result.code === "INVALID_DATE_RANGE" || result.code === "INVALID_SLUG" ? 400 : 409;
      return NextResponse.json({ error: result.message, code: result.code }, { status });
    }

    return NextResponse.json(result.event, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating event" });
    return NextResponse.json(
      { error: "Failed to create event" },
      { status: 500 }
    );
  }
}
