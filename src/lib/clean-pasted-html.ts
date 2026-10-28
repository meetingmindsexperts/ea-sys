import DOMPurify from "isomorphic-dompurify";

/**
 * Text pasted from a website into an email editor (owner, Oct 28, 2026). A website styles itself with
 * stylesheets, classes, web fonts and fixed widths that email apps ignore or mangle, so the pasted
 * copy keeps its structure (headings, bold, italic, links, lists, tables, images, line breaks) and
 * loses the site's styling. Styled emails still come from the editor's own tools and layout blocks,
 * the event's email branding, or designed HTML pasted into the Source view, which this never sees.
 * Client-safe: isomorphic-dompurify is plain DOMPurify in the browser.
 */

/** Presentation the website brings along: attributes that style, size or name things for its own CSS. */
const STYLING_ATTRS = [
  "style",
  "class",
  "id",
  "width",
  "height",
  "bgcolor",
  "background",
  "color",
  "face",
  "size",
  "align",
  "valign",
  "border",
  "cellpadding",
  "cellspacing",
];

/** Whole elements that only carry the site's styling or page furniture. */
const STYLING_TAGS = ["style", "script", "link", "meta", "title", "head", "noscript", "iframe", "svg", "canvas", "form", "button", "input", "select", "textarea"];

/** Of those, the ones whose text would land in the email as stray words (every option of a dropdown). */
const DROP_WITH_CONTENT = ["select", "textarea", "button"];

/** ProseMirror marks HTML copied from its own editor: our blocks keep their look when moved inside it. */
const FROM_OUR_EDITOR = /data-pm-slice=/;

export interface CleanedPaste {
  html: string;
  /** Whether anything was removed or rewritten, so the editor can say so and offer the original. */
  changed: boolean;
}

/** What an inline style says about emphasis, the part of it worth keeping as real tags. */
function emphasisOf(style: string) {
  const s = style.toLowerCase().replace(/\s+/g, "");
  const weight = /font-weight:(bold|bolder|[6-9]00)/.test(s);
  const normalWeight = /font-weight:(normal|[1-4]00)/.test(s);
  return {
    bold: weight,
    notBold: normalWeight,
    italic: /font-style:italic/.test(s),
    underline: /text-decoration[a-z-]*:[^;]*underline/.test(s),
  };
}

function unwrap(el: Element) {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

function wrapChildren(el: Element, tag: string) {
  const wrapper = el.ownerDocument.createElement(tag);
  while (el.firstChild) wrapper.appendChild(el.firstChild);
  el.appendChild(wrapper);
}

/**
 * Google Docs and Word carry bold, italic and underline in inline styles, and Google Docs wraps the
 * whole paste in `<b style="font-weight:normal">`. With the styles gone that wrapper would make the
 * whole paste bold and the real emphasis would vanish (review HIGH, Oct 28), so emphasis becomes tags
 * first and a not-bold `<b>` is unwrapped.
 */
function keepEmphasis(root: DocumentFragment) {
  for (const el of Array.from(root.querySelectorAll("[style]"))) {
    const e = emphasisOf(el.getAttribute("style") ?? "");
    const tag = el.tagName.toLowerCase();
    if ((tag === "b" || tag === "strong") && e.notBold) {
      unwrap(el);
      continue;
    }
    if (e.bold && tag !== "b" && tag !== "strong") wrapChildren(el, "strong");
    if (e.italic && tag !== "i" && tag !== "em") wrapChildren(el, "em");
    if (e.underline && tag !== "u") wrapChildren(el, "u");
  }
}

export function cleanPastedHtml(html: string): CleanedPaste {
  if (FROM_OUR_EDITOR.test(html)) return { html, changed: false };
  // Word and Outlook wrap their markup in conditional comments; none of it belongs in an email body.
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  // First pass keeps the styles, so emphasis can be read off them; the second strips them.
  const fragment = DOMPurify.sanitize(withoutComments, {
    FORBID_TAGS: [...STYLING_TAGS, "font"],
    ADD_FORBID_CONTENTS: DROP_WITH_CONTENT,
    RETURN_DOM_FRAGMENT: true,
  });
  keepEmphasis(fragment);
  const holder = fragment.ownerDocument.createElement("div");
  holder.appendChild(fragment);
  const cleaned = DOMPurify.sanitize(holder.innerHTML, { FORBID_ATTR: STYLING_ATTRS, ALLOW_DATA_ATTR: false });
  // Changed means the paste differs from what it would have been without the clean-up.
  return { html: cleaned, changed: cleaned !== DOMPurify.sanitize(withoutComments) };
}
