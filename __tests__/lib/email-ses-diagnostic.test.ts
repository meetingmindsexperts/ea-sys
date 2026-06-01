/**
 * Unit tests for the SES identity diagnostic + AWS-shaped error capture.
 *
 * Sentry issue 121795612 (May 22 2026) showed UnrecognizedClientException
 * from SES inside sendEmail — but the catch block was logging fields shaped
 * for Postmark/SendGrid errors, so the structured log entry carried no AWS
 * request ID and no AWS error name. Debugging required reading a stack
 * trace alone. This suite pins:
 *
 * 1. logSesIdentityDiagnostic emits the right credential source classification
 *    for AKIA (long-term) vs ASIA (instance role / STS) key prefixes.
 * 2. The "env credentials in use" warn fires when env vars are set AND the
 *    resolved creds are long-term — the precedence trap that caused May 22.
 * 3. The sendEmail catch block extracts AWS SDK v3 error fields
 *    (error.name, $metadata.requestId, $fault) when SES throws.
 * 4. The EmailLog row's errorMessage carries the AWS requestId so an
 *    operator can correlate /logs to a support ticket without reading
 *    the stack trace.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logSesIdentityDiagnostic } from "@/lib/email";

// Lightweight fake matching the surface logSesIdentityDiagnostic touches:
// client.config.region + client.config.credentials. Both can be either a
// value or a () => Promise<value>, mirroring the AWS SDK contract.
function fakeClient(opts: {
  region?: string;
  creds?: {
    accessKeyId: string;
    sessionToken?: string;
    expiration?: Date;
  };
  credsThrows?: boolean;
  noCredsProvider?: boolean;
}): unknown {
  return {
    config: {
      region: async () => opts.region ?? "ap-south-1",
      credentials: opts.noCredsProvider
        ? "not-a-function"
        : async () => {
            if (opts.credsThrows) throw new Error("credentials resolver blew up");
            return opts.creds ?? { accessKeyId: "AKIATESTKEY12345" };
          },
    },
  };
}

// Capture the apiLogger calls by re-importing email.ts with the logger mocked.
// We can't vi.mock inside a sub-describe — must be at module scope.
const loggerCalls: Array<{ level: string; payload: Record<string, unknown> }> = [];
vi.mock("@/lib/logger", () => ({
  apiLogger: {
    info: (payload: Record<string, unknown>) => loggerCalls.push({ level: "info", payload }),
    warn: (payload: Record<string, unknown>) => loggerCalls.push({ level: "warn", payload }),
    error: (payload: Record<string, unknown>) => loggerCalls.push({ level: "error", payload }),
    debug: (payload: Record<string, unknown>) => loggerCalls.push({ level: "debug", payload }),
  },
}));

vi.mock("@/lib/email-log", () => ({
  logEmail: vi.fn(async () => undefined),
}));

beforeEach(() => {
  loggerCalls.length = 0;
});

afterEach(() => {
  delete process.env.AWS_ACCESS_KEY_ID;
});

describe("logSesIdentityDiagnostic — credential source classification", () => {
  it("classifies ASIA + sessionToken as temporary credentials (instance role)", async () => {
    const client = fakeClient({
      creds: {
        accessKeyId: "ASIA1234567890ABCDEF",
        sessionToken: "FwoGZXIvYXdz...",
        expiration: new Date(Date.now() + 3600_000),
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await logSesIdentityDiagnostic(client as any);

    const diag = loggerCalls.find((c) => c.payload.msg === "ses:identity-diagnostic");
    expect(diag, "diagnostic log must fire").toBeDefined();
    expect(diag!.payload).toMatchObject({
      keyPrefix: "ASIA",
      hasSessionToken: true,
      hasExpiration: true,
      credentialSource: "temporary credentials (instance role / STS / SSO)",
    });
    // No precedence-trap warn — env wasn't set.
    expect(loggerCalls.find((c) => c.payload.msg === "ses:env-credentials-in-use")).toBeUndefined();
  });

  it("classifies AKIA without sessionToken as long-term IAM user key", async () => {
    const client = fakeClient({
      creds: { accessKeyId: "AKIA0987654321FEDCBA" },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await logSesIdentityDiagnostic(client as any);

    const diag = loggerCalls.find((c) => c.payload.msg === "ses:identity-diagnostic");
    expect(diag!.payload).toMatchObject({
      keyPrefix: "AKIA",
      hasSessionToken: false,
      credentialSource: "long-term IAM user key (env var or shared credentials file)",
    });
  });

  it("fires the env-credentials-in-use warn when AWS_ACCESS_KEY_ID is set AND creds are long-term", async () => {
    process.env.AWS_ACCESS_KEY_ID = "AKIASTALETESTING1234";
    const client = fakeClient({
      creds: { accessKeyId: "AKIASTALETESTING1234" },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await logSesIdentityDiagnostic(client as any);

    const warn = loggerCalls.find((c) => c.payload.msg === "ses:env-credentials-in-use");
    expect(warn, "precedence-trap warn must fire").toBeDefined();
    expect(warn!.level).toBe("warn");
    expect(warn!.payload.envKeyPrefix).toBe("AKIA");
    expect(warn!.payload.resolvedKeyPrefix).toBe("AKIA");
  });

  it("does NOT fire the precedence-trap warn when sessionToken is present (instance role won)", async () => {
    process.env.AWS_ACCESS_KEY_ID = "AKIASTALETESTING1234";
    const client = fakeClient({
      creds: {
        accessKeyId: "ASIA1234567890ABCDEF",
        sessionToken: "FwoGZXI...",
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await logSesIdentityDiagnostic(client as any);

    expect(loggerCalls.find((c) => c.payload.msg === "ses:env-credentials-in-use")).toBeUndefined();
  });

  it("does not crash the caller when the credential resolver throws", async () => {
    const client = fakeClient({ credsThrows: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(logSesIdentityDiagnostic(client as any)).resolves.toBeUndefined();

    const fail = loggerCalls.find((c) => c.payload.msg === "ses:identity-diagnostic-failed");
    expect(fail, "must log the diagnostic failure rather than throw").toBeDefined();
    expect(fail!.level).toBe("warn");
  });

  it("logs a skip warn when the client has no credentials provider", async () => {
    const client = fakeClient({ noCredsProvider: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await logSesIdentityDiagnostic(client as any);

    const skip = loggerCalls.find((c) => c.payload.msg === "ses:identity-diagnostic-skipped");
    expect(skip, "must log a skip rather than blow up").toBeDefined();
  });
});

describe("sendEmail catch block — AWS SDK v3 error capture", () => {
  // sendEmail itself constructs a live SESv2Client and calls it. To exercise
  // the catch path without hitting AWS, mock the SDK so the constructed
  // client's .send rejects with an AWS-shaped error. We have to reset the
  // module so the new mock is used (sendEmail caches the client via a
  // module-level let).

  it("captures error.name + $metadata.requestId + $fault when SES throws", async () => {
    vi.resetModules();
    loggerCalls.length = 0;
    const logEmailMock = vi.fn(async () => undefined);
    vi.doMock("@/lib/email-log", () => ({ logEmail: logEmailMock }));
    vi.doMock("@/lib/logger", () => ({
      apiLogger: {
        info: (payload: Record<string, unknown>) => loggerCalls.push({ level: "info", payload }),
        warn: (payload: Record<string, unknown>) => loggerCalls.push({ level: "warn", payload }),
        error: (payload: Record<string, unknown>) => loggerCalls.push({ level: "error", payload }),
        debug: () => undefined,
      },
    }));
    vi.doMock("@aws-sdk/client-sesv2", () => {
      class SESv2Client {
        config = { region: async () => "ap-south-1", credentials: async () => ({ accessKeyId: "AKIATEST1234567890AB" }) };
        async send() {
          // Shape matches what AWS SDK v3 throws on a real credential rejection.
          const err = new Error("The security token included in the request is invalid.");
          err.name = "UnrecognizedClientException";
          // Cast through unknown — $metadata + $fault aren't part of Error.
          (err as unknown as { $metadata: unknown }).$metadata = {
            httpStatusCode: 403,
            requestId: "abcd1234-5678-90ef-ghij-klmnopqrstuv",
            attempts: 1,
          };
          (err as unknown as { $fault: string }).$fault = "client";
          throw err;
        }
      }
      class SendEmailCommand {
        constructor(public input: unknown) {}
      }
      return { SESv2Client, SendEmailCommand };
    });

    const { sendEmail } = await import("@/lib/email");
    const result = await sendEmail({
      to: [{ email: "x@example.com" }],
      subject: "test",
      htmlContent: "<p>x</p>",
      textContent: "x",
    });

    expect(result.success).toBe(false);

    const errLog = loggerCalls.find(
      (c) => c.level === "error" && c.payload.msg === "Failed to send email",
    );
    expect(errLog, "error log must fire").toBeDefined();
    expect(errLog!.payload).toMatchObject({
      awsErrorName: "UnrecognizedClientException",
      awsHttpStatus: 403,
      awsRequestId: "abcd1234-5678-90ef-ghij-klmnopqrstuv",
      awsFault: "client",
    });

    // EmailLog row must include the awsRequestId so /logs → support ticket
    // correlation is one grep, not a stack-trace dive.
    expect(logEmailMock).toHaveBeenCalled();
    const call = logEmailMock.mock.calls[0] as unknown as Array<{ errorMessage: string; status: string }>;
    const logRow = call[0];
    expect(logRow.status).toBe("FAILED");
    expect(logRow.errorMessage).toContain("awsRequestId=abcd1234-5678-90ef-ghij-klmnopqrstuv");
    expect(logRow.errorMessage).toContain("awsErrorName=UnrecognizedClientException");

    vi.doUnmock("@aws-sdk/client-sesv2");
    vi.doUnmock("@/lib/email-log");
    vi.doUnmock("@/lib/logger");
  });
});
