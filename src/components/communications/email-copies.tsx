/**
 * The Cc and Bcc lines under a sent email's "To" (Nov 12, 2026). One component
 * for every place a logged email is shown (the per-person Email History card,
 * the Activity timeline, the event's Email Activity table and the View email
 * dialog), so the four cannot word it differently.
 *
 * Renders nothing when the email had neither. Each is one comma-separated
 * string as sendEmail logged it. The Cc line can also hold a second "To"
 * recipient: an email addressed to two people (a group invoice to the
 * coordinator and the billing contact) is logged with the first as To and the
 * rest under cc, and the row cannot tell the two apart.
 *
 * A caller that is not gated by `emailLogs.read` or `communications.send` must
 * not hand the values to its viewer: see src/lib/email-copies-visibility.ts.
 */
interface EmailCopiesProps {
  cc?: string | null;
  bcc?: string | null;
  /** Classes for each line: size and colour to match the caller's "To", and whether a long list wraps or is cut. */
  className?: string;
}

export function EmailCopies({ cc, bcc, className = "break-all text-xs text-muted-foreground" }: EmailCopiesProps) {
  if (!cc && !bcc) return null;
  return (
    <>
      {cc && (
        <span className={`block ${className}`} title={cc}>
          Cc {cc}
        </span>
      )}
      {bcc && (
        <span className={`block ${className}`} title={bcc}>
          Bcc {bcc}
        </span>
      )}
    </>
  );
}
