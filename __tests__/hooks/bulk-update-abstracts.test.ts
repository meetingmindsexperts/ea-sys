/**
 * The client half of the bulk status change (Nov 19, 2026): the server works
 * for about 25 seconds per request and answers the ids it did not reach; the
 * hook sends those again and adds the rounds up.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BulkAbstractUpdateInput, BulkAbstractUpdateOutcome } from "@/hooks/use-api";

interface MutationOptions {
  mutationFn: (input: BulkAbstractUpdateInput) => Promise<unknown>;
  onSettled?: () => void;
}

const { captured, invalidateQueries } = vi.hoisted(() => ({
  captured: { options: null as MutationOptions | null },
  invalidateQueries: vi.fn(),
}));

vi.mock("@tanstack/react-query", async (orig) => {
  const actual = await orig<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries }),
    useMutation: (options: MutationOptions) => {
      captured.options = options;
      return {};
    },
  };
});

import { queryKeys, useBulkUpdateAbstracts } from "@/hooks/use-api";

const round = (over: Record<string, unknown> = {}) => ({ changed: [], unchanged: [], skipped: [], remaining: [], emailed: 0, emailFailed: 0, ...over });
const answer = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
const refusal = (status: number, error: string) => Promise.resolve({ ok: false, status, json: () => Promise.resolve({ error }) });

const fetchMock = vi.fn();
const bodies = () => fetchMock.mock.calls.map(([, init]) => JSON.parse((init as { body: string }).body));
// The mocked useMutation only captures the options, so this is a plain call, not a React render.
const mount: (eventId: string) => unknown = useBulkUpdateAbstracts;
const run = (input: BulkAbstractUpdateInput) => {
  mount("ev1");
  return captured.options!.mutationFn(input) as Promise<BulkAbstractUpdateOutcome>;
};
const INPUT: BulkAbstractUpdateInput = { abstractIds: ["a1", "a2", "a3"], status: "ACCEPTED", notifyAuthors: true };

beforeEach(() => {
  fetchMock.mockReset();
  invalidateQueries.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("useBulkUpdateAbstracts", () => {
  it("sends again what the server did not reach, with the same choices, and adds the rounds up", async () => {
    fetchMock
      .mockReturnValueOnce(answer(round({ changed: ["a1"], remaining: ["a2", "a3"], emailed: 1 })))
      .mockReturnValueOnce(answer(round({ changed: ["a3"], skipped: [{ abstractId: "a2", code: "INSUFFICIENT_REVIEWS", message: "x" }], emailed: 1 })));

    const total = await run(INPUT);

    expect(fetchMock.mock.calls[0][0]).toBe("/api/events/ev1/abstracts/bulk-update");
    expect(bodies()).toEqual([INPUT, { ...INPUT, abstractIds: ["a2", "a3"] }]);
    expect(total).toEqual({
      changed: ["a1", "a3"], unchanged: [], skipped: [{ abstractId: "a2", code: "INSUFFICIENT_REVIEWS", message: "x" }],
      remaining: [], emailed: 2, emailFailed: 0, interrupted: null,
    });
  });

  it("a refused first request throws, so the dialog shows the refusal", async () => {
    fetchMock.mockReturnValueOnce(refusal(403, "You do not have permission"));
    await expect(run(INPUT)).rejects.toThrow("You do not have permission");
  });

  it("a later request failing keeps what was done and names what was not reached", async () => {
    fetchMock
      .mockReturnValueOnce(answer(round({ changed: ["a1"], remaining: ["a2", "a3"] })))
      .mockReturnValueOnce(refusal(502, "Bad gateway"));
    expect(await run(INPUT)).toMatchObject({ changed: ["a1"], remaining: ["a2", "a3"], interrupted: "Bad gateway" });
  });

  it("a server that reaches nothing does not loop for ever", async () => {
    fetchMock.mockImplementation(() => answer(round({ remaining: ["a1", "a2", "a3"] })));
    const total = await run(INPUT);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(total).toMatchObject({ interrupted: "The change made no progress", remaining: ["a1", "a2", "a3"] });
  });

  it("refreshes the abstracts when the change settles, finished or not", () => {
    mount("ev1");
    captured.options!.onSettled!();
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.abstracts("ev1") });
  });
});
