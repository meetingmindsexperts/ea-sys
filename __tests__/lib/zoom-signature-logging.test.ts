/**
 * Zoom SDK signature: which credentials signed the join, and saying so.
 *
 * Background (2026-08-19). A webinar would not join. The server side was
 * entirely clean: a signature was produced, the route answered 200 with
 * mode "sdk", and no log line anywhere recorded WHICH credential pair had been
 * used. The cause, development credentials selected on a production
 * deployment, could only be found by querying Organization.settings in the
 * production database while a live test was blocked.
 *
 * The failure is invisible by construction: signing with the wrong key
 * SUCCEEDS locally and is only rejected later, inside the attendee's browser,
 * where we have no logs. So the guard has to fire at signing time.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockLogger, mockGetZoomCredentials, mockDecrypt } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockGetZoomCredentials: vi.fn(),
  mockDecrypt: vi.fn((v: string) => `decrypted:${v}`),
}));

vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/zoom/client", () => ({ getZoomCredentials: mockGetZoomCredentials }));
vi.mock("@/lib/eventsair-client", () => ({ decryptSecret: mockDecrypt }));

import { generateZoomSignatureForOrg } from "@/lib/zoom/signature";

const ORG = "org_1";
const MEETING = "81527033195";

const CREDS = {
  accountId: "acct",
  clientId: "cid",
  clientSecretEncrypted: "enc",
  sdkKeyDev: "DEVKEY1234567890abcde",
  sdkSecretDevEncrypted: "devsecret",
  sdkKeyProd: "PRODKEY1234567890abcdef",
  sdkSecretProdEncrypted: "prodsecret",
};

/** vi.stubEnv, not Object.defineProperty: process.env rejects a non-writable
 *  descriptor, and stubEnv restores cleanly for the next file in the run. */
function setNodeEnv(value: string) {
  vi.stubEnv("NODE_ENV", value);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDecrypt.mockImplementation((v: string) => `decrypted:${v}`);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("generateZoomSignatureForOrg — credential mode is recorded", () => {
  it("records which mode signed the join, so /logs can answer it", async () => {
    setNodeEnv("production");
    mockGetZoomCredentials.mockResolvedValue({ ...CREDS, sdkMode: "prod" });

    const result = await generateZoomSignatureForOrg(ORG, MEETING, 0);

    expect(result?.sdkKey).toBe(CREDS.sdkKeyProd);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "prod", meetingNumber: MEETING, role: 0 }),
      "zoom:signature-generated",
    );
  });

  it("logs a key PREFIX, never the whole credential", async () => {
    setNodeEnv("production");
    mockGetZoomCredentials.mockResolvedValue({ ...CREDS, sdkMode: "prod" });

    await generateZoomSignatureForOrg(ORG, MEETING, 0);

    const [payload] = mockLogger.info.mock.calls[0];
    expect(payload.sdkKeyPrefix).toBe("PRODKE");
    // The point of the prefix is to tell dev and prod apart at a glance
    // without pasting a credential into a log surface many people can read.
    expect(JSON.stringify(payload)).not.toContain(CREDS.sdkKeyProd);
  });
});

describe("dev credentials on a production deployment", () => {
  it("is an ERROR, because every join on this deployment will be rejected", async () => {
    setNodeEnv("production");
    mockGetZoomCredentials.mockResolvedValue({ ...CREDS, sdkMode: "dev" });

    const result = await generateZoomSignatureForOrg(ORG, MEETING, 0);

    // It still returns a signature. That is exactly the trap: the server
    // succeeds and Zoom rejects it later in the browser, so the alarm has to
    // be raised here or nowhere.
    expect(result).not.toBeNull();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "dev", organizationId: ORG }),
      expect.stringContaining("zoom:sdk-dev-credentials-on-production"),
    );
  });

  it("treats an ABSENT sdkMode as dev, and still warns", async () => {
    // `sdkMode || "dev"` means an org that never set the field is on dev
    // credentials without anyone choosing that.
    setNodeEnv("production");
    mockGetZoomCredentials.mockResolvedValue({ ...CREDS });

    await generateZoomSignatureForOrg(ORG, MEETING, 0);

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "dev" }),
      expect.stringContaining("zoom:sdk-dev-credentials-on-production"),
    );
  });

  it("stays quiet on dev credentials OUTSIDE production", async () => {
    // Local development is where dev credentials are correct. Alarming here
    // would train everyone to ignore the line that matters in production.
    setNodeEnv("development");
    mockGetZoomCredentials.mockResolvedValue({ ...CREDS, sdkMode: "dev" });

    await generateZoomSignatureForOrg(ORG, MEETING, 0);

    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "dev" }),
      "zoom:signature-generated",
    );
  });

  it("stays quiet on prod credentials in production", async () => {
    setNodeEnv("production");
    mockGetZoomCredentials.mockResolvedValue({ ...CREDS, sdkMode: "prod" });

    await generateZoomSignatureForOrg(ORG, MEETING, 0);

    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});

describe("failure paths still log", () => {
  it("names the mode when the selected pair is not configured", async () => {
    setNodeEnv("production");
    mockGetZoomCredentials.mockResolvedValue({
      ...CREDS,
      sdkMode: "prod",
      sdkKeyProd: undefined,
      sdkSecretProdEncrypted: undefined,
    });

    const result = await generateZoomSignatureForOrg(ORG, MEETING, 0);

    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "prod" }),
      expect.stringContaining("SDK credentials not configured"),
    );
  });

  it("names the mode when decryption throws", async () => {
    // Without the mode on this line, a decrypt failure told you something
    // broke but not which of the two secrets to go and re-enter.
    setNodeEnv("production");
    mockGetZoomCredentials.mockResolvedValue({ ...CREDS, sdkMode: "prod" });
    mockDecrypt.mockImplementation(() => {
      throw new Error("bad ciphertext");
    });

    const result = await generateZoomSignatureForOrg(ORG, MEETING, 0);

    expect(result).toBeNull();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "prod" }),
      "zoom:signature-generation-failed",
    );
  });
});
