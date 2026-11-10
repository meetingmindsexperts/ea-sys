/**
 * The client half of "Send assignments" (review of 428991e8, Nov 10, 2026).
 *
 * The server sends for 30 seconds per request and answers where to carry on;
 * the hook chains those requests behind one press, and the page reports the
 * whole press in ONE toast, the worst outcome first. Neither had a test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface MutationOptions {
  mutationFn: (reviewerIds?: string[]) => Promise<unknown>;
  onSettled?: () => void;
  onSuccess?: () => void;
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

import { queryKeys, useSendReviewerAssignments, type SendAssignmentsOutcome } from "@/hooks/use-api";
import { sendAssignmentsReport } from "@/app/(dashboard)/events/[eventId]/reviewers/send-report";

const round = (over: Record<string, unknown> = {}) => ({
  emailed: 0, failed: 0, busy: 0, notSetUp: 0, notRecorded: 0, remaining: 0, nextAfter: null, results: [], ...over,
});
const answer = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
const refusal = (status: number, error: string) => Promise.resolve({ ok: false, status, json: () => Promise.resolve({ error }) });

const fetchMock = vi.fn();
const bodies = () => fetchMock.mock.calls.map(([, init]) => JSON.parse((init as { body: string }).body));
// The mocked useMutation only captures the options, so this is a plain call, not a React render.
const mount: (eventId: string) => unknown = useSendReviewerAssignments;
const send = (reviewerIds?: string[]) => {
  mount("ev1");
  return captured.options!.mutationFn(reviewerIds) as Promise<SendAssignmentsOutcome>;
};

beforeEach(() => {
  fetchMock.mockReset();
  invalidateQueries.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("useSendReviewerAssignments", () => {
  it("carries on from where the last request stopped, and adds the rounds up", async () => {
    fetchMock
      .mockReturnValueOnce(answer(round({ emailed: 2, notSetUp: 1, nextAfter: "r3", results: [{ reviewerId: "r1", ok: true, reclaimed: true }] })))
      .mockReturnValueOnce(answer(round({ emailed: 1, failed: 1, busy: 1, results: [
        { reviewerId: "r4", ok: false, code: "IN_PROGRESS", message: "busy" },
        { reviewerId: "r5", ok: false, code: "SEND_FAILED", message: "The template has an unknown token" },
      ] })));

    const total = await send(["r1", "r3", "r4", "r5"]);

    expect(fetchMock.mock.calls[0][0]).toBe("/api/events/ev1/reviewers/send-assignments");
    expect(bodies()).toEqual([{ reviewerIds: ["r1", "r3", "r4", "r5"] }, { reviewerIds: ["r1", "r3", "r4", "r5"], after: "r3" }]);
    expect(total).toEqual({
      emailed: 3, failed: 1, busy: 1, notSetUp: 1, notRecorded: 0, reclaimed: 1,
      // A skip (busy, not set up, nothing pending) is never shown as the failure's reason.
      firstFailure: "The template has an unknown token",
      interrupted: null,
    });
  });

  it("Send all names nobody, and one answer with no cursor is one request", async () => {
    fetchMock.mockReturnValueOnce(answer(round({ emailed: 4 })));
    expect(await send()).toMatchObject({ emailed: 4, interrupted: null });
    expect(bodies()).toEqual([{}]);
  });

  it("a refused first request throws, so the page shows the refusal", async () => {
    fetchMock.mockReturnValueOnce(refusal(403, "You do not have permission"));
    await expect(send()).rejects.toThrow("You do not have permission");
  });

  it("a later request failing keeps what already went and says the send stopped", async () => {
    fetchMock
      .mockReturnValueOnce(answer(round({ emailed: 3, nextAfter: "r3" })))
      .mockReturnValueOnce(refusal(502, "Bad gateway"));
    expect(await send()).toMatchObject({ emailed: 3, interrupted: "Bad gateway" });
  });

  it("a cursor that never ends stops at 40 requests", async () => {
    fetchMock.mockImplementation(() => answer(round({ emailed: 1, nextAfter: "r1" })));
    const total = await send();
    expect(fetchMock).toHaveBeenCalledTimes(40);
    expect(total).toMatchObject({ emailed: 40, interrupted: "The send is taking unusually long" });
  });

  it("refreshes the reviewers list when the send settles, failed or not", () => {
    mount("ev1");
    expect(captured.options!.onSuccess).toBeUndefined();
    captured.options!.onSettled!();
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.reviewers("ev1") });
  });
});

describe("sendAssignmentsReport", () => {
  const outcome = (over: Partial<SendAssignmentsOutcome>): SendAssignmentsOutcome => ({
    emailed: 0, failed: 0, busy: 0, notSetUp: 0, notRecorded: 0, reclaimed: 0, firstFailure: null, interrupted: null, ...over,
  });

  it("a failure leads, with its reason, whatever else happened", () => {
    const report = sendAssignmentsReport(outcome({ emailed: 5, failed: 10, notSetUp: 3, busy: 1, firstFailure: "The template has an unknown token" }));
    expect(report.level).toBe("error");
    expect(report.lines).toHaveLength(4);
    expect(report.lines[0]).toBe("10 could not be sent: The template has an unknown token");
    expect(report.lines[3]).toBe("Assignments emailed to 5 reviewers");
  });

  it("'do not send to them again' is an error and is never behind a notice", () => {
    const report = sendAssignmentsReport(outcome({ emailed: 2, notRecorded: 1, notSetUp: 2, reclaimed: 1 }));
    expect(report.level).toBe("error");
    expect(report.lines[0]).toContain("Do not send to them again");
  });

  it("an interrupted send is an error; accounts not set up are a warning; busy is a notice", () => {
    expect(sendAssignmentsReport(outcome({ emailed: 3, interrupted: "Bad gateway" })).level).toBe("error");
    expect(sendAssignmentsReport(outcome({ emailed: 3, notSetUp: 1 })).level).toBe("warning");
    expect(sendAssignmentsReport(outcome({ emailed: 3, reclaimed: 1 })).level).toBe("warning");
    expect(sendAssignmentsReport(outcome({ busy: 2 })).level).toBe("info");
  });

  it("a clean send is one success line, and nothing to send says so", () => {
    expect(sendAssignmentsReport(outcome({ emailed: 1 }))).toEqual({ level: "success", lines: ["Assignments emailed to 1 reviewer"] });
    expect(sendAssignmentsReport(outcome({}))).toEqual({ level: "info", lines: ["Nothing new to send"] });
  });
});
