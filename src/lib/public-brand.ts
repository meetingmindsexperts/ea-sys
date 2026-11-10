/**
 * The attendee-facing brand: the name and logo HCPs see (Nov 10, 2026, owner:
 * "the HCP portal is a product of Meeting Minds Experts, the staff tool is MM
 * Group"). The organisation's own name and logo stay for staff screens and
 * money documents; this sits beside them in `Organization.settings.publicBrand`
 * and is set in Settings, Organization. Either half left empty falls back to
 * the organisation's own, so an organisation that never sets it looks as before.
 *
 * Read by the sign-in pages, the catalogue, the event pages, their link
 * previews, the HCP portal's sidebar, the check-in kiosk and desk, and the
 * password reset email to an attendee.
 *
 * Client-safe: no database import.
 */
import { z } from "zod";

export interface PublicBrand {
  name: string;
  logo: string | null;
}

export const PUBLIC_BRAND_SETTINGS_KEY = "publicBrand";

export const publicBrandSettingsSchema = z.object({
  name: z.string().trim().max(120).optional(),
  // Our own uploads or an https address: it renders on every public page, so a
  // third-party http or protocol-relative URL would hand every visitor's IP out.
  logo: z
    .string()
    .max(500)
    .regex(/^(\/uploads\/|https:\/\/)/, "Upload the logo, or use an https:// address")
    .nullable()
    .optional(),
});

/** What a page shows when no organisation answers for this address. */
export const NO_ORGANISATION_BRAND: PublicBrand = { name: "Events", logo: null };

export function readPublicBrand(settings: unknown, org: { name: string; logo: string | null }): PublicBrand {
  const raw = (settings as Record<string, unknown> | null)?.[PUBLIC_BRAND_SETTINGS_KEY];
  const parsed = publicBrandSettingsSchema.safeParse(raw ?? {});
  const brand = parsed.success ? parsed.data : {};
  return { name: brand.name?.trim() || org.name, logo: brand.logo || org.logo };
}
