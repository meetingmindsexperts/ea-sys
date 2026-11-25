/**
 * Bulk email stays under the mail service's sending speed, and an email refused for speed is sent
 * again (Nov 25, 2026). On Nov 24 two webinar reminders came due in the same second, about 320
 * emails in 6 seconds against a limit of 14 a second: 102 were refused and never retried.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  bulkSendRate,
  createPacer,
  DEFAULT_BULK_SEND_RATE,
  isSendRateRefusal,
  SEND_RATE_RETRY_DELAYS_MS,
  sendWithRateRetry,
} from "@/lib/email-send-pacing";

function named(name: string, message = name): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

/** A clock the pacer sleeps on: sleeping moves it forward, and the waits are recorded. */
function fakeClock() {
  const clock = { t: 1_000_000, waits: [] as number[] };
  return {
    clock,
    deps: {
      now: () => clock.t,
      sleep: async (ms: number) => {
        clock.waits.push(ms);
      },
    },
  };
}

describe("the bulk speed", () => {
  it("is 10 a second by default, off under the test runner, and whatever the variable says", () => {
    expect(DEFAULT_BULK_SEND_RATE).toBeLessThan(14);
    expect(bulkSendRate({ NODE_ENV: "production" })).toBe(10);
    expect(bulkSendRate({ NODE_ENV: "test" })).toBe(0);
    expect(bulkSendRate({ NODE_ENV: "production", EMAIL_BULK_SEND_RATE: "5" })).toBe(5);
    expect(bulkSendRate({ NODE_ENV: "production", EMAIL_BULK_SEND_RATE: "0" })).toBe(0);
    expect(bulkSendRate({ NODE_ENV: "test", EMAIL_BULK_SEND_RATE: "8" })).toBe(8);
    // Nonsense falls back to the default, never to "no limit".
    expect(bulkSendRate({ NODE_ENV: "production", EMAIL_BULK_SEND_RATE: "fast" })).toBe(10);
    expect(bulkSendRate({ NODE_ENV: "production", EMAIL_BULK_SEND_RATE: "-3" })).toBe(10);
    // A fraction is a typo for "slow", never one email every 17 minutes.
    expect(bulkSendRate({ NODE_ENV: "production", EMAIL_BULK_SEND_RATE: "0.001" })).toBe(1);
  });
});

describe("the pacer", () => {
  it("the first email goes at once; the rest are spaced evenly however many ask together", async () => {
    const { clock, deps } = fakeClock();
    const pacer = createPacer(10, deps);
    // Two sends of 25 starting in the same instant: the Nov 24 collision.
    await Promise.all(Array.from({ length: 50 }, () => pacer.take()));
    expect(clock.waits).toHaveLength(49);
    expect(clock.waits[0]).toBe(100);
    expect(clock.waits[48]).toBe(4_900);
    // 50 emails are spread over 4.9 seconds: 10 a second, not 50 at once.
  });

  it("an idle line is clear again: no debt carried, no burst saved up", async () => {
    const { clock, deps } = fakeClock();
    const pacer = createPacer(10, deps);
    await pacer.take();
    clock.t += 60_000;
    await pacer.take();
    await pacer.take();
    expect(clock.waits).toEqual([100]);
  });

  it("off (0) never waits", async () => {
    const { clock, deps } = fakeClock();
    const pacer = createPacer(0, deps);
    await Promise.all(Array.from({ length: 30 }, () => pacer.take()));
    expect(clock.waits).toEqual([]);
  });
});

describe("which refusals are sent again", () => {
  it("a speed refusal, and never the daily quota, a paused account or a bad address", () => {
    expect(isSendRateRefusal(named("TooManyRequestsException", "Maximum sending rate exceeded."))).toBe(true);
    expect(isSendRateRefusal(named("ThrottlingException"))).toBe(true);
    expect(isSendRateRefusal(named("LimitExceededException"))).toBe(false);
    expect(isSendRateRefusal(named("TooManyRequestsException", "Daily message quota exceeded."))).toBe(false);
    expect(isSendRateRefusal(named("SendingPausedException"))).toBe(false);
    expect(isSendRateRefusal(named("MessageRejected"))).toBe(false);
    expect(isSendRateRefusal(new Error("socket hang up"))).toBe(false);
    expect(isSendRateRefusal(null)).toBe(false);
  });
});

describe("sending again after a speed refusal", () => {
  const noWait = { sleep: async () => {}, random: () => 0 };

  it("refused twice, then sent: the caller sees a sent email", async () => {
    const send = vi.fn().mockRejectedValueOnce(named("TooManyRequestsException")).mockRejectedValueOnce(named("TooManyRequestsException")).mockResolvedValue("sent");
    const retries: number[] = [];
    const waits: number[] = [];
    const result = await sendWithRateRetry(send, {
      stream: "bulk",
      sleep: async (ms) => {
        waits.push(ms);
      },
      random: () => 0,
      onRetry: ({ attempt }) => retries.push(attempt),
    });
    expect(result).toBe("sent");
    expect(send).toHaveBeenCalledTimes(3);
    expect(retries).toEqual([1, 2]);
    expect(waits).toEqual([1_000, 2_000]);
  });

  it("every try takes its turn in the line (a retry never jumps it)", async () => {
    const turns = vi.fn(async () => {});
    const send = vi.fn().mockRejectedValueOnce(named("TooManyRequestsException")).mockResolvedValue("sent");
    await sendWithRateRetry(send, { stream: "bulk", beforeAttempt: turns, ...noWait });
    expect(turns).toHaveBeenCalledTimes(2);
  });

  it("still refused when the tries run out: the refusal is thrown, after 5 tries for bulk and 3 for transactional", async () => {
    const bulk = vi.fn().mockRejectedValue(named("TooManyRequestsException"));
    await expect(sendWithRateRetry(bulk, { stream: "bulk", ...noWait })).rejects.toMatchObject({ name: "TooManyRequestsException" });
    expect(bulk).toHaveBeenCalledTimes(SEND_RATE_RETRY_DELAYS_MS.bulk.length + 1);
    expect(bulk).toHaveBeenCalledTimes(5);
    const single = vi.fn().mockRejectedValue(named("TooManyRequestsException"));
    await expect(sendWithRateRetry(single, { stream: "transactional", ...noWait })).rejects.toMatchObject({ name: "TooManyRequestsException" });
    expect(single).toHaveBeenCalledTimes(3);
  });

  it("any other failure is thrown at once, never sent twice", async () => {
    const send = vi.fn().mockRejectedValue(named("MessageRejected"));
    await expect(sendWithRateRetry(send, { stream: "bulk", ...noWait })).rejects.toMatchObject({ name: "MessageRejected" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("the waits are spread, so refused emails do not all come back in the same instant", async () => {
    const waits: number[] = [];
    const send = vi.fn().mockRejectedValueOnce(named("TooManyRequestsException")).mockResolvedValue("sent");
    await sendWithRateRetry(send, { stream: "bulk", sleep: async (ms) => void waits.push(ms), random: () => 1 });
    expect(waits).toEqual([1_500]);
  });
});

describe("sendEmail: the one sender applies both rules", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    delete process.env.EMAIL_BULK_SEND_RATE;
  });

  /** email.ts with the SES client mocked: `plan` says, per call, whether the service refuses. */
  async function loadSender(plan: { refusals: number }) {
    vi.resetModules();
    const calls = { n: 0, at: [] as number[] };
    const warns: Record<string, unknown>[] = [];
    vi.doMock("@/lib/email-log", () => ({ logEmail: vi.fn(async () => undefined) }));
    vi.doMock("@/lib/logger", () => ({
      apiLogger: { info: () => undefined, warn: (p: Record<string, unknown>) => warns.push(p), error: () => undefined, debug: () => undefined },
    }));
    vi.doMock("@aws-sdk/client-sesv2", () => {
      class SESv2Client {
        config = { region: async () => "ap-south-1", credentials: async () => ({ accessKeyId: "ASIATEST", sessionToken: "t" }) };
        async send() {
          calls.n += 1;
          calls.at.push(Date.now());
          if (calls.n <= plan.refusals) {
            const err = new Error("Maximum sending rate exceeded.");
            err.name = "TooManyRequestsException";
            throw err;
          }
          return { MessageId: `m${calls.n}` };
        }
      }
      class SendEmailCommand {
        constructor(public input: unknown) {}
      }
      return { SESv2Client, SendEmailCommand };
    });
    const { sendEmail } = await import("@/lib/email");
    return { sendEmail, calls, warns };
  }

  const email = (to: string, stream: "bulk" | "transactional") => ({
    to: [{ email: to }],
    subject: "Reminder",
    htmlContent: "<p>x</p>",
    textContent: "x",
    stream,
    noEntityContext: true,
  });

  it("a reminder the service refuses for speed is sent again and arrives; the retry is logged", async () => {
    vi.useFakeTimers();
    const { sendEmail, calls, warns } = await loadSender({ refusals: 2 });
    const pending = sendEmail(email("a@example.com", "bulk"));
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await pending;
    expect(result.success).toBe(true);
    expect(calls.n).toBe(3);
    expect(warns.filter((w) => w.msg === "email:send-rate-refused-retrying")).toHaveLength(2);
  });

  it("still refused after every try: the email is failed once, and the breaker hears one failure, not five", async () => {
    vi.useFakeTimers();
    const { sendEmail, calls } = await loadSender({ refusals: 99 });
    const pending = sendEmail(email("a@example.com", "bulk"));
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;
    expect(result.success).toBe(false);
    expect(calls.n).toBe(5);
    // One exhausted email is one failure: four more exhausted emails are needed before the bulk
    // breaker (threshold 5) opens, so the next email is still tried.
    const next = sendEmail(email("b@example.com", "bulk"));
    await vi.advanceTimersByTimeAsync(60_000);
    await next;
    expect(calls.n).toBe(10);
  });

  it("two bulk sends starting together share the speed: 10 emails at 5 a second take about 2 seconds", async () => {
    process.env.EMAIL_BULK_SEND_RATE = "5";
    vi.useFakeTimers();
    const { sendEmail, calls } = await loadSender({ refusals: 0 });
    const started = Date.now();
    const sends = Promise.all([
      ...Array.from({ length: 5 }, (_, i) => sendEmail(email(`first${i}@example.com`, "bulk"))),
      ...Array.from({ length: 5 }, (_, i) => sendEmail(email(`second${i}@example.com`, "bulk"))),
    ]);
    await vi.advanceTimersByTimeAsync(10_000);
    const results = await sends;
    expect(results.every((r) => r.success)).toBe(true);
    const offsets = calls.at.map((t) => t - started).sort((a, b) => a - b);
    expect(offsets).toHaveLength(10);
    // Never two in the same 200 ms turn.
    for (let i = 1; i < offsets.length; i++) expect(offsets[i] - offsets[i - 1]).toBeGreaterThanOrEqual(200);
    expect(offsets[9]).toBeGreaterThanOrEqual(1_800);
  });

  it("a transactional email is never paced, even while bulk is", async () => {
    process.env.EMAIL_BULK_SEND_RATE = "1";
    vi.useFakeTimers();
    const { sendEmail, calls } = await loadSender({ refusals: 0 });
    const started = Date.now();
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => sendEmail(email(`t${i}@example.com`, "transactional"))));
    expect(results.every((r) => r.success)).toBe(true);
    expect(calls.at.every((t) => t - started < 50)).toBe(true);
  });
});
