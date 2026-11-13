import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { resolveRequestOrgId } from "@/lib/tenant/resolver";
import { resolvePublicEventOrg } from "@/lib/tenant/event-tenant";
import { DEFAULT_PUBLIC_PERSON_FIELDS, publicPersonFields, readPersonFields } from "@/lib/person-fields";

/**
 * GET /api/public/person-fields
 *
 * What the organisation's forms ask about a person: for Title, Role and
 * Specialty, the label and the answers on offer (Nov 13, 2026; step 1 of
 * docs/ORG_FIELDS_PLAN.md). Every specialty picker reads this, on the public
 * registration forms as well as in the dashboard, so there is no sign-in: the
 * answers are what the public form shows anyway. Retired answers are not sent.
 *
 * Whose list, in this order:
 *   1. the organisation of the event named by `?event=<slug>`: a public
 *      registration form belongs to its event, whoever is looking at it and
 *      whatever address it is served from;
 *   2. the signed-in person's organisation (the dashboard);
 *   3. the organisation whose address the request came to, as sign-in
 *      resolves it (sign-up, My account).
 * With none of them the answer is today's lists. When the read fails the
 * answer is 503, and the picker shows today's lists by itself: a form must
 * never lose its picker. (Before another organisation launches, that fallback
 * must stop being the medical list: docs/ORG_FIELDS_PLAN.md section 4.)
 */
export async function GET(req: Request) {
  const ip = getClientIp(req);
  // A venue or an office shares one address, and every form on it asks once
  // per five minutes per browser: wide, and only there to stop a flood.
  const { allowed, retryAfterSeconds } = checkRateLimit({ key: `person-fields:${ip}`, limit: 600, windowMs: 60_000 });
  if (!allowed) {
    apiLogger.warn({ msg: "public/person-fields:rate-limited", ip });
    return NextResponse.json(
      { error: "Too many requests", retryAfterSeconds, limit: 600, windowSeconds: 60 },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
    );
  }
  try {
    const slug = new URL(req.url).searchParams.get("event")?.trim().slice(0, 200) || null;
    // The event's organisation through the one sanctioned discovery read
    // (event-tenant.ts): a slug is unique inside an organisation, not across
    // them, so the address the request came to decides whose event it is.
    const organizationId = (slug ? await resolvePublicEventOrg(req, slug) : null) ?? (await auth())?.user?.organizationId ?? (await resolveRequestOrgId(req));
    if (!organizationId) return respond(DEFAULT_PUBLIC_PERSON_FIELDS);
    const org = await db.organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
    return respond(publicPersonFields(readPersonFields(org?.settings)));
  } catch (err) {
    // 503, not the default lists with a 200: the page would keep those as the
    // organisation's own for five minutes. The picker falls back to the
    // default lists by itself and asks again the next time it is opened.
    apiLogger.error({ err, msg: "public/person-fields:read-failed" });
    return NextResponse.json({ error: "The form fields could not be read" }, { status: 503 });
  }
}

function respond(fields: unknown) {
  const res = NextResponse.json({ fields });
  // Never kept by the browser: someone who has just saved the list in Settings
  // and opens a form must see it. (A first version kept it for a minute and
  // the form showed the old list straight after a save.) The page itself
  // holds the answer for five minutes, as it does every other read.
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}
