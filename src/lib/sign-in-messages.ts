/**
 * What a sign-in page says for each refusal `authorize()` can give (its
 * CredentialsSignin `code`). One place, so the dashboard and event sign-in
 * pages cannot drift. Browser-safe: no server imports.
 */
export function signInErrorMessage(code: string | undefined): string {
  if (code === "RateLimited") return "Too many failed sign-in attempts. Please wait a few minutes and try again.";
  // Only reachable with the right password (src/lib/account-signup.ts).
  if (code === "EmailUnconfirmed") return "Confirm your email first: open the link we sent when you created the account, then sign in.";
  return "Invalid email or password";
}
