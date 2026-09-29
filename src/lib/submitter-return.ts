/**
 * Where a password reset started, so it can finish back there (Sep 29, 2026).
 *
 * A presenter who forgets their password on the abstract (or session proposal)
 * signup page used to be sent, after resetting it, to the generic event login,
 * which does not set them up as a presenter. The reset now carries `from` from
 * the forgot page, through the emailed link, to the reset page, which returns
 * them to `/e/<slug>/<from>/register` to sign in there.
 *
 * An ALLOW-LIST, not a path: the value ends up in a redirect, so only these two
 * words are ever accepted and anything else means "the event login", as before.
 *
 * Client-safe: no imports.
 */
export const SUBMITTER_RETURN_VALUES = ["abstract", "proposal"] as const;
export type SubmitterReturn = (typeof SUBMITTER_RETURN_VALUES)[number];

export function parseSubmitterReturn(value: string | null | undefined): SubmitterReturn | null {
  return (SUBMITTER_RETURN_VALUES as readonly string[]).includes(value ?? "")
    ? (value as SubmitterReturn)
    : null;
}

/** The page to sign in on after a reset: the signup it came from, or the event login. */
export function signInPathAfterReset(slug: string, from: SubmitterReturn | null): string {
  return from ? `/e/${slug}/${from}/register` : `/e/${slug}/login`;
}
