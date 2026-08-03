/**
 * Add-to-Calendar links + .ics generation (Aug 3, 2026, organizer feedback).
 *
 * EA-SYS previously had NO calendar feature — what registrants saw was their
 * email client AUTO-detecting the "Date: / Time:" text in the confirmation
 * email and minting its own (often wrongly-parsed) calendar chip. These
 * helpers produce explicit, timezone-correct artifacts instead: all times are
 * emitted in UTC (`YYYYMMDDTHHMMSSZ`), which every calendar client converts
 * to the viewer's local time correctly — timezone-proof by construction.
 *
 * Leaf module — pure string building, safe for client components and server
 * routes/emails alike.
 */

export interface CalendarEventInput {
  title: string;
  /** Plain text; newlines allowed (escaped for ICS). */
  description?: string;
  location?: string;
  start: Date;
  end: Date;
}

/** `YYYYMMDDTHHMMSSZ` — the UTC basic format both Google and ICS accept. */
export function utcStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function googleCalendarUrl(ev: CalendarEventInput): string {
  const p = new URLSearchParams({
    action: "TEMPLATE",
    text: ev.title,
    dates: `${utcStamp(ev.start)}/${utcStamp(ev.end)}`,
  });
  if (ev.description) p.set("details", ev.description);
  if (ev.location) p.set("location", ev.location);
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

export function outlookCalendarUrl(ev: CalendarEventInput): string {
  const p = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: ev.title,
    // Outlook deeplinks take ISO 8601; UTC (Z) keeps it timezone-proof.
    startdt: ev.start.toISOString(),
    enddt: ev.end.toISOString(),
  });
  if (ev.description) p.set("body", ev.description);
  if (ev.location) p.set("location", ev.location);
  return `https://outlook.live.com/calendar/0/deeplink/compose?${p.toString()}`;
}

/** RFC 5545 TEXT escaping: backslash, semicolon, comma, newline. */
function icsEscape(v: string): string {
  return v
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/**
 * A single-VEVENT calendar file. Works as a download (`.ics`) AND as an email
 * attachment — an attached invite gives Gmail/Outlook an authoritative event
 * to chip, overriding their own (wrong) text parsing.
 */
export function buildIcsContent(ev: CalendarEventInput, uid: string): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//EA-SYS//Event Registration//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${icsEscape(uid)}`,
    `DTSTAMP:${utcStamp(ev.start)}`,
    `DTSTART:${utcStamp(ev.start)}`,
    `DTEND:${utcStamp(ev.end)}`,
    `SUMMARY:${icsEscape(ev.title)}`,
    ...(ev.description ? [`DESCRIPTION:${icsEscape(ev.description)}`] : []),
    ...(ev.location ? [`LOCATION:${icsEscape(ev.location)}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  // RFC 5545 mandates CRLF line endings.
  return lines.join("\r\n") + "\r\n";
}
