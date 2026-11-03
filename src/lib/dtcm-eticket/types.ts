/**
 * Shapes for the DET eTicketing client (docs/DTCM_ETICKET_PLAN.md).
 * Client-safe: types and constants only.
 */

export type DetEnvironment = "staging" | "production";

export const DET_ENVIRONMENTS: readonly DetEnvironment[] = ["staging", "production"];

/** DET's hosts. Not editable in the UI: a typo here is a silent outage. */
export const DET_BASE_URLS: Record<DetEnvironment, string> = {
  production: "https://et-api.det.gov.ae",
  staging: "https://et-apiuat.detsandbox.com",
};

/** One environment's decrypted credentials, as the client needs them. */
export interface DetCredentials {
  organizationId: string;
  environment: DetEnvironment;
  clientId: string;
  clientSecret: string;
  apiKey: string;
  /** When these were saved; part of the token cache key, so a rotation retires old tokens everywhere. */
  version: string;
}

/** What GET returns per environment: never a secret, only whether one is saved. */
export interface DetEnvironmentStatus {
  configured: boolean;
  clientId: string | null;
  hasClientSecret: boolean;
  apiKeyLast4: string | null;
  configuredAt: string | null;
}

export interface DetCredentialsStatus {
  activeEnvironment: DetEnvironment;
  staging: DetEnvironmentStatus;
  production: DetEnvironmentStatus;
}

/** A performance as DET's map describes it, trimmed to what EA-SYS uses. */
export interface DetPerformanceSummary {
  performanceCode: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
  venueCode: string | null;
  sections: { code: string; name: string; categoryId: number | null; capacity: number | null; holds: number | null }[];
  priceTypes: { code: string; name: string | null; categoryId: number | null; price: number | null }[];
}

export interface DetOrderSummary {
  orderId: string;
  barcode: string | null;
  lineItemId: string | null;
  section: string | null;
  priceTypeCode: string | null;
  priceTypeName: string | null;
  customerId: string | null;
}

export interface DetCustomerInput {
  /** Sent as DET's `eventsairid`; EA-SYS passes the registration id (UAT-verified, any string). */
  externalId: string | null;
  title: string | null;
  firstName: string;
  lastName: string;
  email: string;
  /** ISO 3166-1 alpha-2; DET rejects longer values. */
  nationality: string;
  phoneNumber: string;
  /** ISO 3166-1 alpha-2 of the phone number's country. */
  countryCode: string;
}

export interface DetCustomer {
  id: string;
  account: string;
  aFile: string;
}

/** The step of a DET exchange that failed, for logs and for the row that records it. */
export type DetStage =
  | "config"
  | "token"
  | "performanceMap"
  | "performanceAvailabilities"
  | "createBasket"
  | "getBasket"
  | "deleteBasket"
  | "createCustomer"
  | "purchaseBasket"
  | "getOrder"
  | "reverseOrder";

/** DET's own error codes that callers branch on (verified in UAT, Nov 3 2026). */
export const DET_CODES = {
  /** "Basket is not found": purchased, deleted or expired. */
  BASKET_NOT_FOUND: "5001",
  /** "Section soldout" / "Seats are invalid": the offer cannot be made. */
  OFFER_INVALID: "5005",
  /** "Performance is not found": the code is wrong, or not this seller's. */
  PERFORMANCE_NOT_FOUND: "2001",
  /** "Order not found": never existed, or already reversed. */
  ORDER_NOT_FOUND: "4001",
} as const;
