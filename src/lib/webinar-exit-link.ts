/**
 * The exit button on the webinar's thank-you screen (Nov 5, 2026). Each
 * organisation sets its website once (Organization.settings.website, Settings
 * → Organisation); a webinar may point somewhere else instead
 * (settings.webinar.exitUrl, the console's End-of-webinar card). Neither set,
 * no button. Never a hard-coded address: on the platform instance every
 * tenant's attendees would land on one company's site.
 *
 * Both are free JSON keys that other writers can reach (the general event
 * settings save, clone, an organisation import), so the public read checks the
 * address again rather than trusting what is stored.
 */
import { z } from "zod";

const MAX_URL_LENGTH = 500;

/** An absolute https address with a host. Nothing else becomes a link on a public page. */
export function isHttpsLink(value: string): boolean {
  if (value.length > MAX_URL_LENGTH) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/** The settings field: an https address, or "" to clear it. */
export const exitLinkField = z
  .string()
  .trim()
  .max(MAX_URL_LENGTH)
  .refine((v) => v === "" || isHttpsLink(v), { message: "Must be a full https:// address" });

export interface WebinarExitLink {
  url: string;
  /** "Visit meetingmindsgroup.com": the site's own name, so no tenant's wording is baked in. */
  label: string;
}

function readString(source: unknown, key: string): string | null {
  if (!source || typeof source !== "object") return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && isHttpsLink(value.trim()) ? value.trim() : null;
}

/** The organisation's website, or null when unset or not a safe https address. */
export function readOrgWebsite(orgSettings: unknown): string | null {
  return readString(orgSettings, "website");
}

/** The webinar's exit button: its own link first, else the organisation's website, else none. */
export function resolveWebinarExitLink(args: { orgSettings: unknown; eventSettings: unknown }): WebinarExitLink | null {
  const webinar =
    args.eventSettings && typeof args.eventSettings === "object"
      ? (args.eventSettings as Record<string, unknown>).webinar
      : null;
  const url = readString(webinar, "exitUrl") ?? readOrgWebsite(args.orgSettings);
  if (!url) return null;
  return { url, label: `Visit ${new URL(url).hostname.replace(/^www\./, "")}` };
}
