import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { getClientIp } from "@/lib/security";
import { addGroupMembers, type AddGroupMembersErrorCode } from "@/services/group-registration-service";
import { titleEnum } from "@/lib/schemas";

/**
 * POST /api/registrant/my-group/[groupId]/members
 *
 * The coordinator adds people to a group they already own.
 *
 * Authorization is the `coordinatorUserId` link, checked inside the service —
 * a REGISTRANT is org-null by design, so there is no org to scope on
 * (docs/MULTI_TENANCY_IMPACT.md §8.1). A group they don't coordinate returns
 * 404, not 403, so this can't be used to probe for group ids.
 *
 * All the money consequences (seat claims, and whether the addition reissues
 * an unpaid invoice or raises a supplementary one alongside a settled one)
 * live in `addGroupMembers`. This route only handles auth, shape, rate limit
 * and HTTP mapping.
 */

const attendeeSchema = z.object({
  title: titleEnum.optional().nullable(),
  firstName: z.string().trim().min(1, "First name is required").max(100),
  lastName: z.string().trim().min(1, "Last name is required").max(100),
  email: z.string().trim().toLowerCase().email("A valid email is required"),
  additionalEmail: z.string().trim().toLowerCase().email().optional().nullable().or(z.literal("")),
  organization: z.string().trim().max(200).optional().nullable(),
  jobTitle: z.string().trim().max(200).optional().nullable(),
  phone: z.string().trim().max(50).optional().nullable(),
  city: z.string().trim().max(100).optional().nullable(),
  state: z.string().trim().max(100).optional().nullable(),
  zipCode: z.string().trim().max(20).optional().nullable(),
  country: z.string().trim().max(100).optional().nullable(),
  role: z.string().trim().max(50).optional().nullable(),
  specialty: z.string().trim().max(100).optional().nullable(),
  customSpecialty: z.string().trim().max(100).optional().nullable(),
});

const bodySchema = z.object({
  members: z
    .array(z.object({ ticketTypeId: z.string().min(1), attendee: attendeeSchema }))
    .min(1, "Add at least one person")
    // The service enforces the event's real cap; this is only a shape bound so
    // an absurd payload can't reach the transaction.
    .max(50, "Add at most 50 people at a time"),
});

/** Service rejection → HTTP status. */
const STATUS_FOR_CODE: Record<AddGroupMembersErrorCode, number> = {
  GROUP_NOT_FOUND: 404,
  NO_MEMBERS: 400,
  GROUP_SIZE_OUT_OF_BOUNDS: 400,
  TICKET_TYPE_NOT_FOUND: 400,
  TICKET_TYPE_IS_FACULTY: 400,
  SALES_NOT_STARTED: 400,
  SALES_ENDED: 400,
  DUPLICATE_IN_GROUP: 400,
  ALREADY_REGISTERED: 409,
  SOLD_OUT: 409,
  EVENT_FULL: 409,
  MIXED_CURRENCY: 400,
  UNKNOWN: 500,
};

interface RouteParams {
  params: Promise<{ groupId: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ groupId }, session] = await Promise.all([params, auth()]);
    if (!session?.user?.id) {
      apiLogger.warn({ msg: "my-group-add-members:unauthorized", groupId });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Adding members claims seats and can cancel + reissue an invoice, so this
    // is deliberately tighter than the read routes.
    const limit = checkRateLimit({
      key: `my-group-add-members:${session.user.id}`,
      limit: 20,
      windowMs: 60 * 60 * 1000,
    });
    if (!limit.allowed) {
      apiLogger.warn({ msg: "my-group-add-members:rate-limited", userId: session.user.id, groupId });
      return NextResponse.json(
        { error: "Too many requests. Please try again later.", code: "RATE_LIMITED" },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
      );
    }

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      apiLogger.warn({
        msg: "my-group-add-members:invalid-input",
        groupId,
        errors: parsed.error.flatten().fieldErrors,
      });
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const result = await addGroupMembers({
      groupId,
      coordinatorUserId: session.user.id,
      members: parsed.data.members.map((m) => ({
        ticketTypeId: m.ticketTypeId,
        attendee: {
          ...m.attendee,
          additionalEmail: m.attendee.additionalEmail || null,
        },
      })),
      requestIp: getClientIp(req),
    });

    if (!result.ok) {
      const status = STATUS_FOR_CODE[result.code] ?? 400;
      apiLogger.warn({
        msg: "my-group-add-members:rejected",
        groupId,
        code: result.code,
        status,
      });
      return NextResponse.json(
        { error: result.message, code: result.code, meta: result.meta },
        { status },
      );
    }

    return NextResponse.json(result.result, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "my-group-add-members:failed" });
    return NextResponse.json({ error: "Failed to add members" }, { status: 500 });
  }
}
