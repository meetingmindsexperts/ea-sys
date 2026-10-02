import { describe, it, expect, vi, beforeEach } from "vitest";
import { isStreamArriving } from "@/lib/webinar/stream-probe";

const fetchSpy = vi.fn();

beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
});

describe("isStreamArriving", () => {
  it("reuses a result for 3 s, so 5k pollers cost one probe", async () => {
    fetchSpy.mockResolvedValue({ ok: true });
    expect(await isStreamArriving("key-cache")).toBe(true);
    fetchSpy.mockResolvedValue({ ok: false });
    expect(await isStreamArriving("key-cache")).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("fresh: true asks MediaMTX again (the room toggle acts on the answer)", async () => {
    fetchSpy.mockResolvedValue({ ok: true });
    await isStreamArriving("key-fresh");
    fetchSpy.mockResolvedValue({ ok: false });
    expect(await isStreamArriving("key-fresh", { fresh: true })).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("an unreachable MediaMTX means not live", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await isStreamArriving("key-down", { fresh: true })).toBe(false);
  });
});
