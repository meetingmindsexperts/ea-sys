/**
 * An address fit for a log line: enough to recognise ("j***@gmail.com"), not
 * enough to copy. For log lines about someone who may have NO account, where
 * there is no user id to log instead (Sep 29, 2026; the GDPR backlog in
 * docs/ROADMAP.md asks for fewer raw emails in logs).
 */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return "";
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}
