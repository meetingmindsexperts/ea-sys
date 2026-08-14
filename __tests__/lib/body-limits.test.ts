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
  UPLOAD_BODY_SIZE,
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

// ── Multipart uploads (Aug 14, 2026) ─────────────────────────────────────────
//
// Every upload route inherited the 1MB JSON default while advertising its own
// much larger cap — 10MB for certificate background PDFs and for reimbursement
// / speaker documents, 5MB for the registration supporting document, 2MB for
// media. Nineteen routes read formData(); all of them actually got 1MB, and
// the user saw a bare "Request body too large" naming no number.
//
// It survived because a ROUTE-HANDLER unit test cannot observe a
// MIDDLEWARE-imposed limit: the handler's own 5MB check is exercised in
// isolation and passes, while the real request never reaches it. These tests
// live here for that reason — this is the only layer where the ceiling is
// observable without an end-to-end run.
describe("multipart uploads get the upload ceiling", () => {
  const MULTIPART = "multipart/form-data; boundary=----WebKitFormBoundaryABC123";

  it("gives an upload route far more than the 1MB JSON default", () => {
    expect(maxBodySizeFor("/api/public/events/my-event/supporting-document", MULTIPART)).toBe(
      UPLOAD_BODY_SIZE,
    );
    expect(UPLOAD_BODY_SIZE).toBeGreaterThan(MAX_BODY_SIZE);
  });

  it("clears every cap the upload routes actually advertise", () => {
    // The numbers each route enforces itself. If any of these exceeds the
    // ceiling, that route is still silently broken — which is the whole defect.
    const advertised = {
      "certificate background PDF": 10 * 1024 * 1024,
      "reimbursement document": 10 * 1024 * 1024,
      "speaker profile document": 10 * 1024 * 1024,
      "registration supporting document": 5 * 1024 * 1024,
      "media library image": 2 * 1024 * 1024,
    };
    for (const [what, cap] of Object.entries(advertised)) {
      expect(UPLOAD_BODY_SIZE, `${what} (${cap} bytes) must fit`).toBeGreaterThanOrEqual(cap);
    }
  });

  it("applies regardless of path, so a NEW upload route is correct on day one", () => {
    // The point of keying on content-type rather than extending a prefix list:
    // the CRM-import entry was added only after an operator hit a bare 413, and
    // it fixed exactly one family while eighteen other routes stayed broken.
    expect(maxBodySizeFor("/api/some/route/invented/tomorrow", MULTIPART)).toBe(UPLOAD_BODY_SIZE);
  });

  it("does NOT hand the upload allowance to a JSON body", () => {
    // A plain JSON POST must stay on the 1MB default; otherwise this "fix"
    // would quietly raise the ceiling on every write endpoint in the app.
    expect(maxBodySizeFor("/api/events/evt-1/registrations", "application/json")).toBe(MAX_BODY_SIZE);
    expect(maxBodySizeFor("/api/events/evt-1/registrations", null)).toBe(MAX_BODY_SIZE);
    expect(maxBodySizeFor("/api/events/evt-1/registrations", undefined)).toBe(MAX_BODY_SIZE);
    expect(maxBodySizeFor("/api/events/evt-1/registrations", "")).toBe(MAX_BODY_SIZE);
  });

  it("matches the content-type case-insensitively and tolerates leading space", () => {
    // RFC 9110: the media type is case-insensitive. A client sending
    // "Multipart/Form-Data" is not a different kind of request.
    expect(maxBodySizeFor("/api/x", "Multipart/Form-Data; boundary=z")).toBe(UPLOAD_BODY_SIZE);
    expect(maxBodySizeFor("/api/x", "  multipart/form-data; boundary=z")).toBe(UPLOAD_BODY_SIZE);
  });

  it("is not fooled by a type that merely CONTAINS the word", () => {
    // Must anchor at the start: "application/multipart-form-data-ish" is not a
    // multipart upload. Same containment lesson as hostname suffix matching.
    expect(maxBodySizeFor("/api/x", "application/multipart/form-data")).toBe(MAX_BODY_SIZE);
    expect(maxBodySizeFor("/api/x", "text/multipart/form-data")).toBe(MAX_BODY_SIZE);
  });

  it("keeps the CRM JSON-import allowance, which is a different mechanism", () => {
    // Those routes post the CSV as a JSON string, not as multipart, so they
    // still need their prefix entry.
    expect(maxBodySizeFor("/api/crm/import/deals", "application/json")).toBe(IMPORT_BODY_SIZE);
  });

  it("an existing caller passing only a path keeps JSON behaviour", () => {
    // The contentType arg is optional; defaulting it to "upload" would have
    // silently widened every route.
    expect(maxBodySizeFor("/api/events/evt-1/registrations")).toBe(MAX_BODY_SIZE);
  });
});
