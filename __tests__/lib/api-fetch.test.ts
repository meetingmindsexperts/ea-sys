/**
 * Tests for the typed `ApiError`-throwing fetch helper. The status +
 * code preservation is what lets mutations branch on STALE_WRITE /
 * BILLING_ACCOUNT_INACTIVE / etc. instead of dumping a generic toast,
 * so it's the safety net for every onError that does anything
 * non-trivial.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApiError, apiFetch, apiPostJson, apiPutJson, apiDelete } from "@/lib/api-fetch";

const originalFetch = global.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
  global.fetch = originalFetch;
});

function mockFetch(response: {
  ok: boolean;
  status?: number;
  body?: unknown;
  bodyText?: string;
}) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: async () => {
      if (response.bodyText !== undefined) throw new Error("invalid JSON");
      return response.body;
    },
  } as Response);
}

describe("apiFetch — success path", () => {
  it("returns the parsed JSON body on 2xx", async () => {
    mockFetch({ ok: true, body: { hello: "world" } });
    const out = await apiFetch<{ hello: string }>("/api/x");
    expect(out).toEqual({ hello: "world" });
  });
});

describe("apiFetch — error path", () => {
  it("throws ApiError carrying status + code + raw data", async () => {
    mockFetch({
      ok: false,
      status: 409,
      body: { error: "Stale write", code: "STALE_WRITE", extra: "foo" },
    });
    try {
      await apiFetch("/api/x");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const e = err as ApiError;
      expect(e.status).toBe(409);
      expect(e.code).toBe("STALE_WRITE");
      expect(e.message).toBe("Stale write");
      expect(e.data).toEqual({ error: "Stale write", code: "STALE_WRITE", extra: "foo" });
    }
  });

  it("falls back to 'Request failed' when server returns no error message", async () => {
    mockFetch({ ok: false, status: 500, body: {} });
    await expect(apiFetch("/api/x")).rejects.toMatchObject({
      message: "Request failed",
      status: 500,
      code: undefined,
    });
  });

  it("still throws ApiError when the error body isn't valid JSON", async () => {
    // .json() rejects -> we catch and use {} -> still throw a sensible ApiError.
    mockFetch({ ok: false, status: 502, bodyText: "<html>bad gateway</html>" });
    await expect(apiFetch("/api/x")).rejects.toMatchObject({
      message: "Request failed",
      status: 502,
    });
  });

  it("code is undefined when server doesn't supply one (vs. mistyping it as the string 'undefined')", async () => {
    mockFetch({ ok: false, status: 400, body: { error: "bad" } });
    try {
      await apiFetch("/api/x");
    } catch (err) {
      expect((err as ApiError).code).toBeUndefined();
    }
  });
});

describe("apiPostJson / apiPutJson / apiDelete — request shape", () => {
  it("apiPutJson sends method=PUT + Content-Type + serialized body", async () => {
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as Response);
    global.fetch = spy;
    await apiPutJson("/api/x", { foo: 1 });
    const [, init] = spy.mock.calls[0];
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ foo: 1 }));
  });

  it("apiPostJson with no body sends method=POST and OMITS Content-Type (empty-body action routes)", async () => {
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as Response);
    global.fetch = spy;
    await apiPostJson("/api/x");
    const [, init] = spy.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
  });

  it("apiDelete sends method=DELETE with no body", async () => {
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ removed: true }),
    } as Response);
    global.fetch = spy;
    const out = await apiDelete<{ removed: boolean }>("/api/x");
    const [, init] = spy.mock.calls[0];
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
    expect(out).toEqual({ removed: true });
  });
});
