/**
 * How the email editor (src/components/ui/tiptap-editor.tsx) renders a link's
 * style (Nov 18, 2026). A link keeps its own style: every link used to be
 * given the cerulean one, so a pasted red link turned blue on reopening and
 * was saved blue by the next visual edit (MEHFC 2027 invitations).
 *
 * Client-safe: no imports.
 */

/** What a link looks like when it has no style of its own (the brand cerulean). */
export const LINK_DEFAULT_STYLE = "color: #00aade; text-decoration: underline;";

/**
 * A link's style as rendered: its own, with the cerulean colour and underline
 * in front for whichever of the two it does not set itself (review of
 * ae8a3d5e: a link styled only `font-weight: 700` showed in the mail client's
 * own blue). Its own declarations come last, so they win.
 */
export function linkStyle(own: unknown): string {
  const style = typeof own === "string" ? own.trim() : "";
  if (!style) return LINK_DEFAULT_STYLE;
  const sets = (prop: string) => new RegExp(`(^|;)\\s*${prop}\\s*:`, "i").test(style);
  const defaults = [
    sets("color") ? null : "color: #00aade;",
    sets("text-decoration") ? null : "text-decoration: underline;",
  ].filter(Boolean);
  return defaults.length === 0 ? style : `${defaults.join(" ")} ${style}`;
}
