/**
 * HTTP glue shared by the registration-view routes: the body schema (typed
 * into the service's input) and the error-code → status map. Kept out of the
 * service, which knows nothing about HTTP.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { LABEL_MAX } from "@/lib/registration-share";
import type { RegistrationShareErrorCode, RegistrationViewInput } from "@/services/registration-share-service";

const ids = z.array(z.string().min(1).max(100)).max(200);

export const registrationViewBodySchema = z.object({
  label: z.string().max(LABEL_MAX + 20),
  enabled: z.boolean(),
  expiresAt: z.string().datetime().nullable(),
  statuses: z.array(z.string().max(40)).max(20),
  fields: z.array(z.string().max(40)).max(40),
  ticketTypeIds: ids,
  sponsorIds: ids,
  promoCodeIds: ids,
  includeFaculty: z.boolean(),
});

/**
 * Does this view publish sponsor attribution? The `sponsor` field shows it, and
 * a sponsor filter reveals it by elimination. Attribution is finance data
 * (FINANCIAL_KEYS strips `sponsorId`), so the routes refuse such a view to a
 * person without `finance.view` (Phase 6 review LOW, Oct 7, 2026): otherwise a
 * custom role could put on a public link what its own screens hide.
 */
export function viewDisclosesSponsors(body: Pick<z.infer<typeof registrationViewBodySchema>, "fields" | "sponsorIds">): boolean {
  return body.fields.includes("sponsor") || body.sponsorIds.length > 0;
}

export const SPONSOR_NEEDS_FINANCE = {
  error: "Sharing sponsor attribution needs access to finance. Remove the Sponsor column and any sponsor filter.",
  code: "SPONSOR_NEEDS_FINANCE",
} as const;

export function toViewInput(body: z.infer<typeof registrationViewBodySchema>): RegistrationViewInput {
  return { ...body, expiresAt: body.expiresAt ? new Date(body.expiresAt) : null };
}

const STATUS: Record<RegistrationShareErrorCode, number> = {
  UNKNOWN_STATUS: 400,
  UNKNOWN_FIELD: 400,
  NO_STATUS: 400,
  INVALID_LABEL: 400,
  UNKNOWN_FILTER: 400,
  EXPIRY_IN_PAST: 400,
  LABEL_TAKEN: 409,
  TOO_MANY_VIEWS: 409,
  NOT_FOUND: 404,
};

export function viewErrorResponse(code: RegistrationShareErrorCode, message: string): NextResponse {
  return NextResponse.json({ error: message, code }, { status: STATUS[code] });
}
