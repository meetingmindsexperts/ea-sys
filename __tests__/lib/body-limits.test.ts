/**
 * Per-route body-size limits.
 *
 * The failure this pins is a silent one in BOTH directions: a route that should
 * accept a large body starts 413ing (an operator sees "Request body too large"
 * on a perfectly ordinary CSV and has nothing to act on), or the large-body
 * allowance quietly widens to routes that were never meant to buffer 8MB.
 */
import { describe, it, expect } from "vitest";
import {
  maxBodySizeFor,
  MAX_BODY_SIZE,
  IMPORT_BODY_SIZE,
  LARGE_BODY_PREFIXES,
} from "@/lib/body-limits";

describe("maxBodySizeFor", () => {
  it("allows the larger body on every CRM import route", () => {
    for (const type of ["companies", "contacts", "deals"]) {
      expect(maxBodySizeFor(`/api/crm/import/${type}`)).toBe(IMPORT_BODY_SIZE);
    }
  });

  it("keeps the 1MB default for the rest of the API — including the CRM's own writes", () => {
    for (const path of [
      "/api/crm/deals",
      "/api/crm/contacts",
      "/api/crm/deals/export",
      "/api/events/abc/registrations",
      "/api/upload/photo",
      "/api/mcp",
    ]) {
      expect(maxBodySizeFor(path)).toBe(MAX_BODY_SIZE);
    }
  });

  it("does not match a look-alike prefix", () => {
    // "/api/crm/imports" and "/api/crm/import-log" must NOT inherit the allowance.
    expect(maxBodySizeFor("/api/crm/imports/deals")).toBe(MAX_BODY_SIZE);
    expect(maxBodySizeFor("/api/crm/import-log")).toBe(MAX_BODY_SIZE);
  });

  it("keeps the large-body allow-list short and specific", () => {
    // Not style policing: every entry is a path where an unauthenticated request
    // can make the box buffer 8MB before any handler runs. Growing this list
    // should be a deliberate decision, so it fails the test first.
    //
    // NOTE this asserts the LIST, not a guarantee about bytes: the proxy check
    // reads `content-length`, so a chunked request bypasses it and nginx's 10MB
    // is the real ceiling. Don't read this test as proof of an 8MB bound.
    expect(LARGE_BODY_PREFIXES).toEqual(["/api/crm/import/"]);
    expect(IMPORT_BODY_SIZE).toBeGreaterThan(MAX_BODY_SIZE);
    // …and still under nginx's client_max_body_size (10MB), or nginx rejects it
    // first and the app's friendlier error never renders.
    expect(IMPORT_BODY_SIZE).toBeLessThan(10 * 1_048_576);
  });
});
