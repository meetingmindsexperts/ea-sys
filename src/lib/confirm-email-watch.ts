/**
 * When a page that is waiting on an email confirmation should be told the
 * address is now confirmed (Nov 23, 2026; the webinar page's "Already
 * registered for this webinar?" notice, src/components/registrant/
 * confirm-email-notice.tsx).
 *
 * Only a CHANGE counts, and only once. The page answers by loading again to
 * let the person in; an account that was confirmed all along has nothing new
 * to be let in for, so telling the page then would reload it for ever (a
 * confirmed account that simply has not registered sees the same screen).
 *
 * No imports: it runs in the browser bundle and under the unit suite alike.
 */
export interface ConfirmationWatch {
  /** The address has been seen unconfirmed since this notice appeared. */
  sawUnconfirmed: boolean;
  /** The page has been told already. */
  told: boolean;
}

export const NEW_CONFIRMATION_WATCH: ConfirmationWatch = { sawUnconfirmed: false, told: false };

/** `confirmed` is the latest answer, or undefined while there is none yet. */
export function watchConfirmation(
  watch: ConfirmationWatch,
  confirmed: boolean | undefined,
): { watch: ConfirmationWatch; tell: boolean } {
  if (confirmed === undefined) return { watch, tell: false };
  if (!confirmed) return { watch: { ...watch, sawUnconfirmed: true }, tell: false };
  if (!watch.sawUnconfirmed || watch.told) return { watch, tell: false };
  return { watch: { ...watch, told: true }, tell: true };
}
