/**
 * onRequestError used to forward to Sentry only, so an uncaught request error
 * never reached the SystemLog table or the admin alert (audit, Nov 10, 2026).
 * It now writes "request:unhandled-error" first, on the Node runtime only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockLogger, mockCapture } = vi.hoisted(() => ({
  mockLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  mockCapture: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@sentry/nextjs", () => ({ captureRequestError: mockCapture }));

import { onRequestError } from "@/instrumentation";

const request = {
  path: "/api/events/evt1/registrations?token=secret",
  method: "POST",
  headers: {},
};
const context = {
  routerKind: "App Router",
  routePath: "/api/events/[eventId]/registrations",
  routeType: "route",
};

describe("onRequestError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("forwards to Sentry, then logs the error with its route", async () => {
    const err = new Error("boom");

    await onRequestError(err, request, context);

    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      {
        err,
        path: "/api/events/evt1/registrations",
        method: "POST",
        routeType: "route",
        routePath: "/api/events/[eventId]/registrations",
      },
      "request:unhandled-error",
    );
    expect(mockCapture).toHaveBeenCalledWith(err, request, context);
    // Sentry first: the logger forwards to Sentry too and the first capture wins.
    expect(mockCapture.mock.invocationCallOrder[0]).toBeLessThan(
      mockLogger.error.mock.invocationCallOrder[0],
    );
  });

  it("never logs the query string, which can carry a token", async () => {
    await onRequestError(new Error("boom"), request, context);

    expect(JSON.stringify(mockLogger.error.mock.calls[0][0])).not.toContain("secret");
  });

  it("keeps the router-state-header skip: no log, no Sentry", async () => {
    await onRequestError(
      new Error("The router state header was sent but could not be parsed."),
      request,
      context,
    );

    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("does not load the logger on Edge, and still forwards to Sentry", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    const err = new Error("edge boom");

    await onRequestError(err, request, context);

    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockCapture).toHaveBeenCalledWith(err, request, context);
  });

  it("a logging failure never throws out of the hook, and Sentry still gets the error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockLogger.error.mockImplementationOnce(() => {
      throw new Error("log stream closed");
    });
    const err = new Error("boom");

    await expect(onRequestError(err, request, context)).resolves.toBeUndefined();

    expect(mockCapture).toHaveBeenCalledWith(err, request, context);
    expect(consoleError).toHaveBeenCalledWith(
      "request:unhandled-error-log-failed",
      expect.any(Error),
    );
  });
});
