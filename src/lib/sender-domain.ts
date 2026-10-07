/**
 * The one domain this deployment may send email from: the domain of
 * `EMAIL_FROM`, which is the identity SES (and the box's IAM role) allows.
 * Read on the server at request time, since master and the platform instance
 * share one image and differ only in their environment.
 *
 * Why it exists (Oct 7, 2026): an event's sender was set to an address on
 * another domain, and every send from it failed with a raw AWS
 * "not authorized to perform ses:SendEmail" error. The event settings now
 * name this domain beside the sender field.
 */
export function senderDomain(): string | null {
  const from = process.env.EMAIL_FROM ?? "";
  const match = /@([a-z0-9.-]+\.[a-z]{2,})/i.exec(from);
  return match ? match[1].toLowerCase() : null;
}

/** Does an address belong to the sending domain? True when no domain is configured. */
export function isAllowedSenderAddress(address: string, domain: string | null): boolean {
  if (!domain) return true;
  return address.trim().toLowerCase().endsWith(`@${domain}`);
}
