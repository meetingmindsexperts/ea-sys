import type { CreateRegistrationErrorCode } from "@/services/registration-service";

/**
 * HTTP status for each `createRegistration()` error code, shared by the
 * dashboard create route and the desk walk-in route. Compile-time exhaustive
 * via `Record<CreateRegistrationErrorCode, number>`.
 */
export const HTTP_STATUS_FOR_REGISTRATION_ERROR: Record<CreateRegistrationErrorCode, number> = {
  EVENT_NOT_FOUND: 404,
  TICKET_TYPE_NOT_FOUND: 404,
  TICKET_TYPE_IS_FACULTY: 400,
  SALES_NOT_STARTED: 400,
  SALES_ENDED: 400,
  SOLD_OUT: 400,
  EVENT_FULL: 400,
  PRICING_TIER_NOT_FOUND: 404,
  ALREADY_REGISTERED: 400,
  INVALID_PAYMENT_STATUS: 400,
  INCLUSIVE_REQUIRES_SPONSOR: 400,
  SPONSOR_NOT_FOUND: 400,
  BILLING_ACCOUNT_NOT_FOUND: 404,
  BILLING_ACCOUNT_INACTIVE: 400,
  INVALID_PROMO_CODE: 400,
  PROMO_CODE_NOT_APPLICABLE: 400,
  PROMO_CODE_NOT_SPONSOR: 400,
  PROMO_CODE_EXHAUSTED: 409,
  PROMO_CODE_EMAIL_LIMIT: 409,
  PRICE_CHANGED: 409,
  UNKNOWN: 500,
};
