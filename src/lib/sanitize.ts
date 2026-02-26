import DOMPurify from "isomorphic-dompurify";

/**
 * Sanitizes HTML content to prevent XSS attacks.
 * Allows safe HTML tags for styling (p, div, span, a, strong, em, etc.)
 * but strips all scripts, event handlers, iframes, and other dangerous content.
 */
export function sanitizeHtml(dirty: string): string {
  return DOMPurify.sanitize(dirty, {
    ALLOWED_TAGS: [
      "p", "div", "span", "br", "hr",
      "h1", "h2", "h3", "h4", "h5", "h6",
      "a", "strong", "em", "b", "i", "u", "s",
      "ul", "ol", "li",
      "table", "thead", "tbody", "tr", "th", "td",
      "img", "figure", "figcaption",
      "blockquote", "pre", "code",
      "small", "sub", "sup",
    ],
    ALLOWED_ATTR: [
      "href", "target", "rel", "src", "alt", "width", "height",
      "class", "style", "id",
    ],
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: ["target"],
  });
}
