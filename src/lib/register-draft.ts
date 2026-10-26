/**
 * The public registration form survives a reload (owner, Oct 26, 2026): what
 * the person typed, which step they were on, their category, billing choice,
 * promo code and uploaded document come back, so a phone that reloads the tab
 * (or a slip of the thumb) no longer sends them back to "Create your account".
 *
 * Stored in sessionStorage, so it lives in that browser TAB only: gone when
 * the tab closes, never shared with another tab, device or person, and
 * cleared the moment the registration succeeds. The owner chose to keep the
 * password too, so the form can reopen on the details step; it is therefore
 * readable by any script running on the page for as long as the tab is open,
 * which is the trade-off accepted for a form that does not reset.
 *
 * Every storage call is wrapped: private windows and blocked storage throw,
 * and then the form simply starts empty as before.
 *
 * Client-only (touches window); no imports.
 */

const VERSION = 1;

export interface RegisterDraft {
  v: number;
  savedAt: number;
  step: 1 | 2;
  values: Record<string, unknown>;
  billingSame: boolean;
  promoCode: string;
  supportingDoc: { url: string; filename: string } | null;
}

/** A draft older than this is ignored: a tab left open overnight starts fresh. */
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

export function registerDraftKey(slug: string, category: string): string {
  return `ea-sys:register-draft:${slug}:${category}`;
}

export function readRegisterDraft(key: string): RegisterDraft | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const draft = JSON.parse(raw) as RegisterDraft;
    if (draft?.v !== VERSION || typeof draft.values !== "object" || draft.values === null) return null;
    if (Date.now() - (draft.savedAt ?? 0) > MAX_AGE_MS) {
      window.sessionStorage.removeItem(key);
      return null;
    }
    return draft;
  } catch {
    return null;
  }
}

export function writeRegisterDraft(key: string, draft: Omit<RegisterDraft, "v" | "savedAt">): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify({ ...draft, v: VERSION, savedAt: Date.now() }));
  } catch {
    // Storage unavailable or full: the form works, it just will not survive a reload.
  }
}

export function clearRegisterDraft(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Nothing to clear.
  }
}
