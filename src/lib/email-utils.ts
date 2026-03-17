/**
 * Client-safe email utilities.
 * These functions can be imported from client components without pulling in
 * server-only dependencies (fs, logger, Brevo SDK, etc.).
 */

/**
 * Strip the document wrapper (DOCTYPE, html, head, body tags) from a full
 * HTML email document, returning only the body content.
 * Used for loading existing full-document templates into the WYSIWYG editor.
 */
export function stripDocumentWrapper(html: string): string {
  // Try to extract content between <body...> and </body>
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (bodyMatch) {
    return bodyMatch[1].trim();
  }
  // If no body tag, return as-is (already a fragment)
  return html;
}
