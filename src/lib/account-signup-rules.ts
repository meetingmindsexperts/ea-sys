/**
 * The /signup password rule, shared by the form and the route (Nov 5, 2026).
 * Longer than the registration form's 6: this account starts with nothing but
 * its password. Kept apart from account-signup.ts, which reads the database
 * and cannot ship in the browser bundle.
 */
export const SIGNUP_PASSWORD_MIN = 8;
export const SIGNUP_PASSWORD_MAX = 128;
