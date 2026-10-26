/**
 * After a submit that did not go through, take the person to the first thing
 * they have to fix, and say what it is (Oct 26, 2026; docs/ROADMAP.md "Public
 * forms on a phone").
 *
 * react-hook-form's own jump focuses the first invalid field, which does
 * nothing for a custom picker (Title, Country, Specialty, Role give it no
 * focusable ref) or for an error set in onSubmit (the registration type, an ID
 * number, the supporting document). On a phone the message was then 900 to
 * 2,000px above the button and the tap looked dead: two BHS2026 registrants
 * gave up that way on Oct 24.
 *
 * So this reads the PAGE, not the form state: every visible error message in
 * document order (`[data-slot="form-message"]`, plus anything marked
 * `data-form-error`), scrolls the first one's field into view, and returns the
 * notice for beside the button. Called a tick after the errors render.
 */
export function scrollToFirstFormError(root: ParentNode = document): string {
  const messages = [...root.querySelectorAll<HTMLElement>('[data-slot="form-message"], [data-form-error]')].filter(
    (el) => (el.textContent ?? "").trim() !== "" && el.getClientRects().length > 0,
  );
  if (messages.length === 0) return missingFieldsNotice([], null);
  const first = messages[0];
  // The whole field when it fits on the screen (label, box and message
  // together); otherwise the message itself, so a tall section such as the
  // registration type cards does not push it to the bottom edge.
  const field = first.closest<HTMLElement>('[data-slot="form-item"], [data-form-error-section]');
  const fits = field && typeof window !== "undefined" && field.getBoundingClientRect().height <= window.innerHeight * 0.8;
  (fits ? field : first).scrollIntoView({ behavior: "smooth", block: "center" });
  const firstMessage = (first.textContent ?? "").trim();
  // One problem: its own message says it best ("Country is required", "You
  // must agree to the terms and conditions"), and covers a field that is
  // filled in but wrong (review L3: a bad email read "Please fill in").
  if (messages.length === 1) return missingFieldsNotice([], firstMessage);
  // Several, all named: list them. Otherwise quote the first and count the
  // rest; the generic line is only for a page with no message at all (a
  // category with no label once produced "Please check the highlighted fields").
  const names = messages.map(fieldName);
  if (names.every((n): n is string => !!n)) return missingFieldsNotice([...new Set(names)], null);
  return missingFieldsNotice([], firstMessage, messages.length - 1);
}

/** The field's name: a `data-form-error` on the message, else its label without the star. */
function fieldName(message: HTMLElement): string | null {
  const own = message.getAttribute("data-form-error");
  if (own) return own;
  const label = message.closest('[data-slot="form-item"]')?.querySelector('[data-slot="form-label"]');
  const text = label?.textContent?.replace(/\*/g, "").trim();
  return text || null;
}

/**
 * "Please check: Title, Country" (past three, "... and 2 more"); or one
 * message quoted, plus how many others there are.
 */
export function missingFieldsNotice(names: string[], firstMessage: string | null = null, others = 0): string {
  if (names.length > 0) {
    const shown = names.slice(0, 3).join(", ");
    return names.length > 3 ? `Please check: ${shown} and ${names.length - 3} more` : `Please check: ${shown}`;
  }
  if (firstMessage) {
    const more = others > 0 ? ` (and ${others} more to fix above)` : "";
    return `${firstMessage.replace(/\.$/, "")}${more}`;
  }
  return "Please check the highlighted fields.";
}
