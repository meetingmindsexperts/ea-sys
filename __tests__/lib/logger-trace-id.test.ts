/**
 * TRACE CORRELATION (Oct 7, 2026). Every log line inside a traced request
 * carries the request's Sentry trace id, so an error in Sentry and its lines in
 * /logs can be matched by one id instead of by timestamp. These pin the mixin:
 * the id rides when there is one, nothing rides when there is not (never a
 * shared or zero id), and a failing lookup cannot break a log call.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Writable } from "stream";
import pino from "pino";
import { setTraceIdSource, traceMixin } from "@/lib/logger";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";

function capture(): { logger: pino.Logger; lines: () => Record<string, unknown>[] } {
  const out: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, done) {
      out.push(String(chunk));
      done();
    },
  });
  return {
    logger: pino({ mixin: traceMixin }, sink),
    lines: () => out.map((l) => JSON.parse(l)),
  };
}

afterEach(() => setTraceIdSource(() => undefined));

describe("logger trace correlation", () => {
  it("stamps the active trace id on the line", () => {
    setTraceIdSource(() => TRACE);
    const { logger, lines } = capture();
    logger.warn({ eventId: "e1" }, "registration:refused");
    expect(lines()[0]).toMatchObject({ traceId: TRACE, eventId: "e1", msg: "registration:refused" });
  });

  it("adds nothing outside a request", () => {
    const { logger, lines } = capture();
    logger.info("worker:job-done");
    expect(lines()[0]).not.toHaveProperty("traceId");
  });

  it("treats OpenTelemetry's all-zero id as no trace", () => {
    setTraceIdSource(() => "00000000000000000000000000000000");
    expect(traceMixin()).toEqual({});
  });

  it("never lets a failing lookup break the log call", () => {
    setTraceIdSource(() => {
      throw new Error("sentry not ready");
    });
    const { logger, lines } = capture();
    logger.error("still-logged");
    expect(lines()[0]).toMatchObject({ msg: "still-logged" });
    expect(lines()[0]).not.toHaveProperty("traceId");
  });
});
