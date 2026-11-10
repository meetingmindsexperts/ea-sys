/**
 * The client half of Send to all (Nov 10, 2026).
 *
 * The server sends for 30 seconds per request and answers where to carry on;
 * the hook chains those requests behind one press, and the page reports the
 * whole press in ONE toast, the worst outcome first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface MutationOptions {
  mutationFn: () => Promise<unknown>;
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

import { queryKeys, useSendReviewerInvitations, type SendInvitationsOutcome } from "@/hooks/use-api";
import { sendInvitationsReport } from "@/app/(dashboard)/events/[eventId]/reviewers/send-report";

const round = (over: Record<string, unknown> = {}) => ({ emailed: 0, failed: 0, remaining: 0, nextAfter: null, results: [], ...over });
const answer = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
const refusal = (status: number, error: string) => Promise.resolve({ ok: false, status, json: () => Promise.resolve({ error }) });

const fetchMock = vi.fn();
const bodies = () => fetchMock.mock.calls.map(([, init]) => JSON.parse((init as { body: string }).body));
// The mocked useMutation only captures the options, so this is a plain call, not a React render.
const mount: (eventId: string) => unknown = useSendReviewerInvitations;
const send = () => {
  mount("ev1");
  return captured.options!.mutationFn() as Promise<SendInvitationsOutcome>;
};

beforeEach(() => {
  fetchMock.mockReset();
  invalidateQueries.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("useSendReviewerInvitations", () => {
  it("carries on from where the last request stopped, and adds the rounds up", async () => {
    fetchMock
      .mockReturnValueOnce(answer(round({ emailed: 2, nextAfter: "r2", remaining: 2 })))
      .mockReturnValueOnce(answer(round({ emailed: 1, failed: 1, results: [
        { reviewerId: "r3", ok: true, kind: "portal" },
        { reviewerId: "r4", ok: false, message: "The template has an unknown token" },
      ] })));

    const total = await send();

    expect(fetchMock.mock.calls[0][0]).toBe("/api/events/ev1/reviewers/send-invitations");
    expect(bodies()).toEqual([{}, { after: "r2" }]);
    expect(total).toEqual({ emailed: 3, failed: 1, firstFailure: "The template has an unknown token", interrupted: null });
  });

  it("a refused first request throws, so the page shows the refusal", async () => {
    fetchMock.mockReturnValueOnce(refusal(403, "You do not have permission"));
    await expect(send()).rejects.toThrow("You do not have permission");
  });

  it("a later request failing keeps what already went and says the send stopped", async () => {
    fetchMock
      .mockReturnValueOnce(answer(round({ emailed: 3, nextAfter: "r3", remaining: 4 })))
      .mockReturnValueOnce(refusal(502, "Bad gateway"));
    expect(await send()).toMatchObject({ emailed: 3, interrupted: "Bad gateway" });
  });

  it("a cursor that never ends stops at 40 requests", async () => {
    fetchMock.mockImplementation(() => answer(round({ emailed: 1, nextAfter: "r1", remaining: 1 })));
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

describe("sendInvitationsReport", () => {
  const outcome = (over: Partial<SendInvitationsOutcome>): SendInvitationsOutcome => ({ emailed: 0, failed: 0, firstFailure: null, interrupted: null, ...over });

  it("a failure leads, with its reason, whatever else happened", () => {
    const report = sendInvitationsReport(outcome({ emailed: 5, failed: 10, firstFailure: "The template has an unknown token" }));
    expect(report.level).toBe("error");
    expect(report.lines).toEqual(["10 could not be sent: The template has an unknown token", "Invitation emailed to 5 reviewers"]);
  });

  it("an interrupted send is an error that says how to finish it", () => {
    const report = sendInvitationsReport(outcome({ emailed: 3, interrupted: "Bad gateway" }));
    expect(report.level).toBe("error");
    expect(report.lines[0]).toContain("Bad gateway");
    expect(report.lines[0]).toContain("use the Send button on the rows it did not reach");
  });

  it("a clean send is one success line, and an empty list says so", () => {
    expect(sendInvitationsReport(outcome({ emailed: 1 }))).toEqual({ level: "success", lines: ["Invitation emailed to 1 reviewer"] });
    expect(sendInvitationsReport(outcome({}))).toEqual({ level: "info", lines: ["There is nobody to send to"] });
  });
});
