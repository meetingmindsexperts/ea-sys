/** An uploaded file (/uploads/…) or an https address: the only image URLs the
 *  branding settings accept (webinar page images, the kiosk background).
 *  Its own module so the badge reader, which the PDF renderer and the kiosk
 *  both load, does not pull in the webinar library for one check. */
export function isUploadOrHttpsUrl(value: string): boolean {
  return value.startsWith("/uploads/") || value.startsWith("https://");
}
