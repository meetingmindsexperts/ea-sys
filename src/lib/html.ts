/**
 * Escape the five HTML-significant characters for safe interpolation of
 * untrusted text into an HTML string. Pure + client-safe. Shared helper — was
 * copy-pasted ("Local copy of the HTML-escape helper…") across the cert issue
 * worker, the cert resend route, and the email-tokens resolver.
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
