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

/** Whole elements that only carry the site's styling or page furniture; their content goes too. */
const STYLING_TAGS = ["style", "script", "link", "meta", "title", "head", "noscript", "iframe", "svg", "canvas", "form", "button", "input", "select", "textarea"];

const LOOKS_STYLED = /\s(style|class|bgcolor|face|color|width|height)\s*=|<(style|font|link|meta)\b/i;

/** ProseMirror marks HTML copied from its own editor: our blocks keep their look when moved inside it. */
const FROM_OUR_EDITOR = /data-pm-slice=/;

export interface CleanedPaste {
  html: string;
  /** Whether anything of the website's styling was removed, so the editor can say so. */
  changed: boolean;
}

export function cleanPastedHtml(html: string): CleanedPaste {
  if (FROM_OUR_EDITOR.test(html)) return { html, changed: false };
  // Word and Outlook wrap their markup in conditional comments; none of it belongs in an email body.
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const cleaned = DOMPurify.sanitize(withoutComments, {
    FORBID_TAGS: [...STYLING_TAGS, "font"],
    FORBID_ATTR: STYLING_ATTRS,
    ALLOW_DATA_ATTR: false,
  });
  return { html: cleaned, changed: LOOKS_STYLED.test(withoutComments) };
}
