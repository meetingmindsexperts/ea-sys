/**
 * The secret in a shared-view URL (/e/<slug>/shared/<token>), for both the
 * abstracts/proposals links and the registration views: 32 random bytes,
 * base64url (43 characters). Server-only (node:crypto); never import it from
 * a client component.
 */
import { randomBytes } from "node:crypto";

export function newShareToken(): string {
  return randomBytes(32).toString("base64url");
}

/** A token the public route will even look up; anything else is refused unread. */
export function isPlausibleShareToken(token: string): boolean {
  return token.length >= 20 && token.length <= 100;
}
