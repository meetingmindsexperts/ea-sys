import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { checkRateLimit } from "@/lib/security";
import { runWithTenantLane } from "@/lib/tenant-lane";
import { MAX_PERSON_FIELD_ANSWER, MAX_PERSON_FIELD_OPTIONS, readPersonFields } from "@/lib/person-fields";
import { countSpecialtyUse, saveSpecialtyAnswers, type SaveSpecialtyAnswersErrorCode } from "@/services/person-field-service";

/**
 * The organisation's Specialty answers, for Settings, Form fields (Nov 13,
 * 2026; step 1 of docs/ORG_FIELDS_PLAN.md). GET the list with how many records
 * store each answer; PUT the list as a whole. Both need `formFields.manage`
 * (admins and organisers, or a custom role given it): the forms themselves
 * read the answers from the public route, which needs no key.
 */

const answerList = z
  .array(z.object({ answer: z.string().max(MAX_PERSON_FIELD_ANSWER + 20), retired: z.boolean().optional() }))
  .max(MAX_PERSON_FIELD_OPTIONS);

const putSchema = z.object({
  specialty: z.object({
    answers: answerList,
    allowOther: z.boolean(),
    // The list as the screen loaded it. The whole list is replaced, so a save
    // made from an older copy is refused (LIST_CHANGED), never applied.
    expected: z.object({ answers: answerList, allowOther: z.boolean() }),
  }),
});

/** Exhaustive over the service's error union, so a new code fails the build. */
const HTTP_STATUS: Record<SaveSpecialtyAnswersErrorCode, number> = {
  ORGANIZATION_NOT_FOUND: 404,
  TOO_MANY: 400,
  INVALID_ANSWER: 400,
  RESERVED_ANSWER: 400,
  DUPLICATE_ANSWER: 409,
  NOTHING_OFFERED: 400,
  LIST_CHANGED: 409,
  ANSWER_IN_USE: 409,
  UNKNOWN: 500,
};

async function specialtyWithUse(organizationId: string) {
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
  const field = readPersonFields(org?.settings).specialty;
  const use = await countSpecialtyUse(db, organizationId, field.options.map((o) => o.key));
  return {
    label: field.label,
    allowOther: field.allowOther,
    answers: field.options.map((o) => ({ answer: o.key, retired: o.retired, records: use.get(o.key) ?? 0 })),
  };
}

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const gate = requirePermission(session, "formFields.manage", { route: "organization/person-fields:GET" });
    if (!gate.ok) return gate.response;
    const organizationId = session.user.organizationId;
    if (!organizationId) {
      apiLogger.warn({ userId: session.user.id, role: session.user.role }, "person-fields:list-no-org");
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    // The session's lane: the record counts read contacts, attendees and speakers.
    return await runWithTenantLane(organizationId, { route: "organization/person-fields:GET", userId: session.user.id }, async () =>
      NextResponse.json({ specialty: await specialtyWithUse(organizationId) }),
    );
  } catch (err) {
    apiLogger.error({ err }, "person-fields:list-failed");
    return NextResponse.json({ error: "Failed to load the form fields" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const [session, body] = await Promise.all([auth(), req.json().catch(() => null)]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const gate = requirePermission(session, "formFields.manage", { route: "organization/person-fields:PUT" });
    if (!gate.ok) return gate.response;
    const organizationId = session.user.organizationId;
    if (!organizationId) {
      apiLogger.warn({ userId: session.user.id, role: session.user.role }, "person-fields:update-no-org");
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { allowed, retryAfterSeconds } = checkRateLimit({ key: `person-fields-update:${organizationId}`, limit: 60, windowMs: 3600_000 });
    if (!allowed) {
      apiLogger.warn({ organizationId, userId: session.user.id }, "person-fields:update-rate-limited");
      return NextResponse.json(
        { error: "Too many requests", retryAfterSeconds, limit: 60, windowSeconds: 3600 },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const parsed = putSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ errors: parsed.error.flatten(), organizationId }, "person-fields:update-validation-failed");
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }

    const userId = session.user.id;
    return await runWithTenantLane(organizationId, { route: "organization/person-fields:PUT", userId }, async () => {
      const result = await saveSpecialtyAnswers({
        organizationId,
        actorUserId: userId,
        answers: parsed.data.specialty.answers,
        allowOther: parsed.data.specialty.allowOther,
        expected: parsed.data.specialty.expected,
      });
      if (!result.ok) {
        apiLogger.warn({ msg: "person-fields:update-rejected", organizationId, userId, code: result.code });
        return NextResponse.json(
          { error: result.message, code: result.code, ...(result.inUse ? { inUse: result.inUse } : {}) },
          { status: HTTP_STATUS[result.code] },
        );
      }
      return NextResponse.json({ specialty: await specialtyWithUse(organizationId) });
    });
  } catch (err) {
    apiLogger.error({ err }, "person-fields:update-failed");
    return NextResponse.json({ error: "Failed to save the form fields" }, { status: 500 });
  }
}
