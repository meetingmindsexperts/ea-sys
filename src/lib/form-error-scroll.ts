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
 * `data-form-error`), scrolls the first one's field into the middle of the
 * screen, and returns the field names for a short notice by the button.
 * Called a tick after the errors render.
 */
export function scrollToFirstFormError(root: ParentNode = document): string[] {
  const messages = [...root.querySelectorAll<HTMLElement>('[data-slot="form-message"], [data-form-error]')].filter(
    (el) => (el.textContent ?? "").trim() !== "" && el.getClientRects().length > 0,
  );
  if (messages.length === 0) return [];
  const first = messages[0];
  // The whole field when it fits on the screen (label, box and message
  // together); otherwise the message itself, so a tall section such as the
  // registration type cards does not push it to the bottom edge.
  const field = first.closest<HTMLElement>('[data-slot="form-item"], [data-form-error-section]');
  const fits = field && typeof window !== "undefined" && field.getBoundingClientRect().height <= window.innerHeight * 0.8;
  (fits ? field : first).scrollIntoView({ behavior: "smooth", block: "center" });
  return [...new Set(messages.map(fieldName).filter((n): n is string => !!n))];
}

/** The field's label, without the required star: "Country", "Title". */
function fieldName(message: HTMLElement): string | null {
  const own = message.getAttribute("data-form-error");
  if (own) return own;
  const label = message.closest('[data-slot="form-item"]')?.querySelector('[data-slot="form-label"]');
  const text = label?.textContent?.replace(/\*/g, "").trim();
  return text || null;
}

/** "Please fill in: Title, Country" or, past three, "Title, Country and 2 more". */
export function missingFieldsNotice(names: string[]): string {
  if (names.length === 0) return "Please check the highlighted fields.";
  const shown = names.slice(0, 3).join(", ");
  return names.length > 3 ? `Please fill in: ${shown} and ${names.length - 3} more` : `Please fill in: ${shown}`;
}
