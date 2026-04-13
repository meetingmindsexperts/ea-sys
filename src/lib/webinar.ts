export const WEBINAR_HIDDEN_MODULES = [
  "Accommodation",
  "Check-In",
  "Promo Codes",
  "Abstracts",
  "Reviewers",
] as const;

export const WEBINAR_HIDDEN_SETTINGS_TABS = [
  "abstract-themes",
  "review-criteria",
] as const;

export function isWebinar(
  event: { eventType?: string | null } | null | undefined,
): boolean {
  return event?.eventType === "WEBINAR";
}

export function webinarModuleFilter(eventType: string | null | undefined) {
  const isWebinarEvent = eventType === "WEBINAR";
  const hidden = new Set<string>(WEBINAR_HIDDEN_MODULES);
  return (item: { name: string; webinarOnly?: boolean }) => {
    if (isWebinarEvent) {
      return !hidden.has(item.name);
    }
    // Non-webinar event: drop items marked webinarOnly
    return !item.webinarOnly;
  };
}

export type WebinarAutoRecording = "none" | "local" | "cloud";

export interface WebinarSettings {
  autoCreated?: boolean;
  sessionId?: string;
  autoProvisionZoom?: boolean;
  defaultPasscode?: string;
  waitingRoom?: boolean;
  autoRecording?: WebinarAutoRecording;
  automationEnabled?: boolean;
}

export function readWebinarSettings(
  settings: unknown,
): WebinarSettings | null {
  if (!settings || typeof settings !== "object") return null;
  const w = (settings as Record<string, unknown>).webinar;
  if (!w || typeof w !== "object") return null;
  return w as WebinarSettings;
}
