/**
 * The Cc and Bcc lines under a sent email's "To" (Nov 12, 2026). One component
 * for every place a logged email is shown (the per-person Email History card,
 * the Activity timeline, the event's Email Activity table and the View email
 * dialog), so the four cannot word it differently.
 *
 * Renders nothing when the email had neither. The addresses are stored as one
 * comma-separated string per kind, exactly as they were sent.
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
