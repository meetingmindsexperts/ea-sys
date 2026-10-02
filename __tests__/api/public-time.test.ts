import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRateLimit, mockWarn } = vi.hoisted(() => ({
  mockRateLimit: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: init?.headers ?? {},
      json: async () => body,
    }),
  },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: mockWarn, info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/security", () => ({ checkRateLimit: mockRateLimit, getClientIp: () => "1.2.3.4" }));

import { GET } from "@/app/api/public/time/route";

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockReturnValue({ allowed: true });
});

describe("GET /api/public/time", () => {
  it("returns the server time, never cached", async () => {
    const before = Date.now();
    const res = (await GET(new Request("http://x/api/public/time"))) as unknown as {
      status: number;
      headers: Record<string, string>;
      json: () => Promise<{ now: number }>;
    };
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.now).toBeGreaterThanOrEqual(before);
    expect(res.headers["Cache-Control"]).toBe("no-store");
  });

  it("is rate-limited per IP and logs the refusal", async () => {
    mockRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 60 });
    const res = (await GET(new Request("http://x/api/public/time"))) as unknown as { status: number };
    expect(res.status).toBe(429);
    expect(mockWarn).toHaveBeenCalledWith(expect.objectContaining({ ip: "1.2.3.4" }), "public/time:rate-limited");
  });
});
