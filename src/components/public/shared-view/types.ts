/** What the public shared-view route returns, per kind. */
import type { SharedItem, ShareKind } from "@/lib/submission-share";
import type { RegistrationViewSummary, SharedRegistration } from "@/lib/registration-share";

export interface SharedEventBranding {
  name: string;
  startDate: string;
  endDate: string;
  timezone: string | null;
  bannerImage: string | null;
  bannerImageMobile: string | null;
  organizationName: string;
}

export interface SubmissionsPayload {
  event: SharedEventBranding;
  kind: ShareKind;
  fields: string[];
  items: SharedItem[];
  truncated: boolean;
  generatedAt: string;
}

export interface RegistrationsPayload {
  event: SharedEventBranding;
  kind: "REGISTRATIONS";
  label: string;
  fields: string[];
  summary: RegistrationViewSummary;
  items: SharedRegistration[];
  truncated: boolean;
  generatedAt: string;
}

export type SharedPayload = SubmissionsPayload | RegistrationsPayload;
