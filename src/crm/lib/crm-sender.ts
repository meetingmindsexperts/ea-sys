/**
 * The CRM's own sending identity, from CRM_EMAIL_FROM_ADDRESS / _NAME
 * (partnerships@meetingmindsdubai.com on prod). Every email the CRM sends goes
 * out under it: the deal and sponsor emails, and the copy of a sponsor's reply
 * forwarded to the team (Oct 27, 2026: the forward had no From, so it went out
 * under the event system's default sender). Null when unset.
 */
export function crmSenderFromEnv(): { email: string; name?: string } | null {
  const email = process.env.CRM_EMAIL_FROM_ADDRESS?.trim();
  if (!email) return null;
  return { email, name: process.env.CRM_EMAIL_FROM_NAME?.trim() || undefined };
}
