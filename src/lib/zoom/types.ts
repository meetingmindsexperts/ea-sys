/**
 * Zoom API TypeScript types.
 */

// ── OAuth ──────────────────────────────────────────────────────────

export interface ZoomOAuthTokenResponse {
  access_token: string;
  token_type: "bearer";
  expires_in: number; // seconds
  scope: string;
}

export interface ZoomOrgCredentials {
  accountId: string;
  clientId: string;
  clientSecretEncrypted: string;
  configuredAt: string; // ISO date
  // Meeting SDK credentials (for embedding in browser)
  sdkKey?: string;
  sdkSecretEncrypted?: string;
}

// ── Meeting / Webinar creation ─────────────────────────────────────

export interface CreateZoomMeetingParams {
  topic: string;
  startTime: string; // ISO 8601
  duration: number; // minutes
  timezone?: string;
  passcode?: string;
  waitingRoom?: boolean;
  autoRecording?: "none" | "local" | "cloud";
  agenda?: string;
}

export interface CreateZoomWebinarParams extends CreateZoomMeetingParams {
  /** For webinar series (recurring): Zoom type 9 */
  recurrence?: ZoomRecurrence;
}

export interface ZoomRecurrence {
  type: 1 | 2 | 3; // 1=daily, 2=weekly, 3=monthly
  repeat_interval: number;
  end_date_time?: string; // ISO 8601
  end_times?: number; // 1–60
  weekly_days?: string; // "1,2,3" (Sun=1..Sat=7)
  monthly_day?: number; // 1–31
}

// ── Zoom API responses ─────────────────────────────────────────────

export interface ZoomMeetingResponse {
  id: number;
  uuid: string;
  host_id: string;
  topic: string;
  type: number; // 1=instant, 2=scheduled, 3=recurring-no-fixed, 8=recurring-fixed
  start_time: string;
  duration: number;
  timezone: string;
  join_url: string;
  start_url: string;
  password?: string;
  status: string;
  settings: {
    waiting_room?: boolean;
    auto_recording?: string;
  };
}

export interface ZoomWebinarResponse extends ZoomMeetingResponse {
  type: number; // 5=webinar, 6=recurring-no-fixed, 9=recurring-fixed
  occurrences?: ZoomOccurrence[];
  recurrence?: ZoomRecurrence;
  registration_url?: string;
}

export interface ZoomOccurrence {
  occurrence_id: string;
  start_time: string;
  duration: number;
  status: "available" | "deleted";
}

export interface ZoomPanelist {
  id: string;
  email: string;
  name: string;
  join_url: string;
}

export interface ZoomUserResponse {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  type: number;
  account_id: string;
}

// ── Zoom event settings (stored in Event.settings JSON) ────────────

export interface ZoomEventSettings {
  enabled: boolean;
  defaultMeetingType?: "MEETING" | "WEBINAR";
  autoCreateForSessions?: boolean;
}

// ── Zoom API error ─────────────────────────────────────────────────

export interface ZoomApiError {
  code: number;
  message: string;
}
