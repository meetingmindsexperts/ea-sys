/**
 * Which events use an entry barcode (owner, Oct 6, 2026): none for webinars.
 * A webinar has no door, so its confirmation email, thank-you page and
 * registrant portal never show one. The registration keeps its code
 * internally, so nothing in check-in or badges changes; only what attendees
 * see. Client-safe, no imports.
 */
export function eventUsesEntryBarcode(eventType: string | null | undefined): boolean {
  return eventType !== "WEBINAR";
}
