import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildLoginRedirect,
  handleUnauthorized,
  httpStatusOf,
  resetSessionExpiryLatch,
  shouldRetryQuery,
} from "@/lib/session-expiry";
import { ApiError } from "@/lib/api-fetch";

const root = process.cwd();
const readSource = (rel: string) => readFileSync(join(root, rel), "utf8");

/** Strip comments so a source assertion cannot pass on its own explanation. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

beforeEach(() => {
  resetSessionExpiryLatch();
});

describe("httpStatusOf", () => {
  it("reads the status off an ApiError (api-fetch.ts / CRM)", () => {
    expect(httpStatusOf(new ApiError("Unauthorized", 401))).toBe(401);
  });

  it("reads the status off a hand-rolled Error & { status } (invoices-client)", () => {
    const err = new Error("Forbidden") as Error & { status?: number };
    err.status = 403;
    expect(httpStatusOf(err)).toBe(403);
  });

  it("returns undefined for errors that carry no status", () => {
    // A network failure, or any thrown value that never saw an HTTP response.
    expect(httpStatusOf(new Error("Failed to fetch"))).toBeUndefined();
    expect(httpStatusOf("boom")).toBeUndefined();
    expect(httpStatusOf(null)).toBeUndefined();
    expect(httpStatusOf(undefined)).toBeUndefined();
  });

  it("ignores a non-numeric status rather than trusting it", () => {
    expect(httpStatusOf({ status: "401" })).toBeUndefined();
  });
});

describe("buildLoginRedirect", () => {
  it("sends a dashboard path to the staff login, carrying it back", () => {
    expect(buildLoginRedirect("/crm/companies")).toBe(
      "/login?callbackUrl=%2Fcrm%2Fcompanies&reason=expired",
    );
  });

  it("preserves the query string so filters survive the round trip", () => {
    // The observed case was someone re-opening one specific contact. Dropping
    // them on an unfiltered list would repeat the frustration differently.
    expect(buildLoginRedirect("/crm/contacts", "?q=ahmed&status=open")).toBe(
      "/login?callbackUrl=%2Fcrm%2Fcontacts%3Fq%3Dahmed%26status%3Dopen&reason=expired",
    );
  });

  it("never redirects a login page to itself", () => {
    expect(buildLoginRedirect("/login")).toBeNull();
    expect(buildLoginRedirect("/login", "?callbackUrl=%2Fcrm")).toBeNull();
  });

  it("redirects the other auth pages, which cannot loop", () => {
    // Deliberate: only /login can loop. These make no client queries today,
    // so this asserts the choice rather than a behaviour anyone relies on.
    expect(buildLoginRedirect("/forgot-password")).toBe(
      "/login?callbackUrl=%2Fforgot-password&reason=expired",
    );
  });

  it("NEVER redirects the check-in kiosk", () => {
    // Load-bearing. The kiosk is attendee-facing and full-screen with a
    // PIN-gated exit; bouncing it would put a staff password box in front of
    // a queue of delegates. It has its own "Kiosk needs attention" state.
    expect(buildLoginRedirect("/events/abc123/check-in/kiosk")).toBeNull();
  });

  it("sends a public event page to that event's own branded login", () => {
    expect(buildLoginRedirect("/e/my-conf/my-registration")).toBe(
      "/e/my-conf/login?redirect=%2Fe%2Fmy-conf%2Fmy-registration&reason=expired",
    );
  });

  it("does not loop on the event login page", () => {
    expect(buildLoginRedirect("/e/my-conf/login")).toBeNull();
  });

  it("declines when a public path carries no slug", () => {
    expect(buildLoginRedirect("/e")).toBeNull();
    expect(buildLoginRedirect("/e/")).toBeNull();
  });

  it("declines a path that is not absolute", () => {
    expect(buildLoginRedirect("crm/companies")).toBeNull();
    expect(buildLoginRedirect("https://evil.example/x")).toBeNull();
  });
});

describe("handleUnauthorized", () => {
  it("navigates once and reports that it handled the error", () => {
    const navigate = vi.fn();
    const handled = handleUnauthorized(
      { pathname: "/crm/deals", search: "" },
      navigate,
    );
    expect(handled).toBe(true);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(
      "/login?callbackUrl=%2Fcrm%2Fdeals&reason=expired",
    );
  });

  it("latches, so a burst of 401s starts exactly one navigation", () => {
    // Fifteen CRM routes failed inside ninety seconds in production. Without
    // the latch each one would kick off its own navigation.
    const navigate = vi.fn();
    for (let i = 0; i < 15; i++) {
      handleUnauthorized({ pathname: "/crm/deals", search: "" }, navigate);
    }
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("does NOT latch when it declines to redirect", () => {
    // Otherwise one 401 on the kiosk would permanently disable the redirect
    // for every other tab in the session.
    const navigate = vi.fn();
    expect(
      handleUnauthorized({ pathname: "/events/e1/check-in/kiosk", search: "" }, navigate),
    ).toBe(false);
    expect(navigate).not.toHaveBeenCalled();

    expect(
      handleUnauthorized({ pathname: "/crm/deals", search: "" }, navigate),
    ).toBe(true);
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});

describe("shouldRetryQuery", () => {
  it("never retries an auth failure", () => {
    expect(shouldRetryQuery(0, new ApiError("Unauthorized", 401))).toBe(false);
    expect(shouldRetryQuery(0, new ApiError("Forbidden", 403))).toBe(false);
  });

  it("keeps exactly the single retry the app has always had", () => {
    // query-core evaluates shouldRetry BEFORE incrementing, so failureCount
    // is 0 on the first failure. `failureCount < 1` == the previous retry: 1.
    const err = new ApiError("Server error", 500);
    expect(shouldRetryQuery(0, err)).toBe(true);
    expect(shouldRetryQuery(1, err)).toBe(false);
  });

  it("still retries errors that carry no status (network blips)", () => {
    expect(shouldRetryQuery(0, new Error("Failed to fetch"))).toBe(true);
  });
});

describe("wiring", () => {
  // These pin the RELATIONSHIP, not the unit. Every helper above can be
  // perfect while nothing calls it, which is the exact failure this change
  // exists to fix.

  it("fetchApi attaches the HTTP status, so core dashboard 401s are recognised", () => {
    // Before this change fetchApi threw a bare Error with no status, so a
    // handler keyed on status would have covered the CRM and silently missed
    // every core dashboard hook. Reverting it is the regression to catch.
    const src = codeOnly(readSource("src/hooks/use-api.ts"));
    expect(src).toContain("throw new ApiError(message, res.status, data)");
    expect(src).not.toMatch(/throw new Error\(\s*error\.error/);
  });

  it("providers.tsx routes both query AND mutation failures through the handler", () => {
    const src = codeOnly(readSource("src/components/providers.tsx"));
    // A mutation-only or query-only wiring would leave half the app broken.
    expect(src.match(/handleExpiredSession\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect(src).toContain("handleUnauthorized(");
    expect(src).toContain("retry: shouldRetryQuery");
  });
});
