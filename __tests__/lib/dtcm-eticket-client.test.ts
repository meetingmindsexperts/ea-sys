/**
 * The DET eTicketing client against a stubbed fetch. The response shapes are
 * the ones DET's UAT returned on Nov 3, 2026 (docs/DTCM_ETICKET_PLAN.md §10).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { logger } = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: logger }));

import {
  clearDetTokenCache,
  createDetBasket,
  DetApiError,
  detBasketExists,
  getDetAccessToken,
  getDetOrder,
  getDetPerformance,
  purchaseDetBasket,
  reverseDetOrder,
} from "@/lib/dtcm-eticket/client";
import type { DetCredentials } from "@/lib/dtcm-eticket/types";

const creds: DetCredentials = {
  organizationId: "org-1",
  environment: "staging",
  clientId: "AMMEE1",
  clientSecret: "s3cret-value",
  apiKey: "apikey123secret",
  version: "2026-11-03T12:00:00.000Z",
};

const fetchMock = vi.fn();

function reply(status: number, body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return Promise.resolve(new Response(status === 204 ? null : text, { status }));
}

/** First call is always the token; then the given replies in order. */
function script(...replies: Array<[number, unknown]>) {
  fetchMock.mockImplementationOnce(() => reply(200, { access_token: "tok-1", expires_in: 3600 }));
  for (const [status, body] of replies) fetchMock.mockImplementationOnce(() => reply(status, body));
}

const detError = (code: string, message: string) => ({ code, httpStatusCode: 400, message, reference: "ref-1" });

beforeEach(() => {
  clearDetTokenCache();
  fetchMock.mockReset();
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("token", () => {
  it("is fetched once and reused", async () => {
    script();
    await getDetAccessToken(creds);
    await getDetAccessToken(creds);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://et-apiuat.detsandbox.com/adfs/oauth2/token?api_key=apikey123secret");
    expect(JSON.parse(init.body)).toMatchObject({ client_id: "AMMEE1", grant_type: "client_credentials", resource: "https://et-apiuat.detsandbox.com" });
  });

  it("is dropped on a 401 so the next call fetches a new one", async () => {
    script([401, { code: "401", message: "Unauthorized" }]);
    await expect(getDetPerformance(creds, "P1")).rejects.toBeInstanceOf(DetApiError);
    script([200, { performanceCode: "P1", name: "x", sections: [] }]);
    await getDetPerformance(creds, "P1");
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("/adfs/oauth2/token"))).toHaveLength(2);
  });

  it("uses the production host for production credentials", async () => {
    script();
    await getDetAccessToken({ ...creds, environment: "production" });
    expect(fetchMock.mock.calls[0][0]).toMatch(/^https:\/\/et-api\.det\.gov\.ae\/adfs\/oauth2\/token\?/);
  });
});

describe("errors", () => {
  it("carry the stage, HTTP status and DET's code and reference", async () => {
    script([400, detError("5005", "One or more parameters in the offer request were invalid. Section soldout.")]);
    const err = await createDetBasket(creds, { performanceCode: "P1", area: "SVIP1", priceTypeCode: "C" }).catch((e) => e);
    expect(err).toBeInstanceOf(DetApiError);
    expect(err).toMatchObject({ stage: "createBasket", httpStatus: 400, detCode: "5005", detReference: "ref-1" });
    expect(err.message).toContain("Section soldout");
  });

  it("strip DET's HTML gateway page to its text", async () => {
    script([403, "<h1>Developer Inactive</h1>"]);
    const err = await getDetPerformance(creds, "P1").catch((e) => e);
    expect(err.message).toContain("Developer Inactive");
    expect(err.message).not.toContain("<h1>");
  });

  it("mark a request with no answer, which is what makes a purchase ambiguous", async () => {
    script();
    fetchMock.mockImplementationOnce(() => Promise.reject(new DOMException("timed out", "TimeoutError")));
    const err = await purchaseDetBasket(creds, "b1", { id: "c1", account: "0", aFile: "tel" }, 0).catch((e) => e);
    expect(err).toMatchObject({ stage: "purchaseBasket", httpStatus: null, isNoResponse: true });
  });

  it("log why a request got no answer, with any quoted credential redacted", async () => {
    script();
    await getDetAccessToken(creds);
    logger.warn.mockClear();
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND et.example apikey123secret"), { code: "ENOTFOUND" });
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError("fetch failed for ?api_key=apikey123secret", { cause })));
    await getDetPerformance(creds, "P1").catch(() => {});
    expect(logger.warn).toHaveBeenCalledWith({
      msg: "dtcm-eticket:no-response",
      stage: "performanceMap",
      environment: "staging",
      timedOut: false,
      errorName: "TypeError",
      errorMessage: "fetch failed for ?api_key=***",
      causeCode: "ENOTFOUND",
      causeMessage: "getaddrinfo ENOTFOUND et.example ***",
    });
  });

  it("log a timeout by name, with no cause to report", async () => {
    script();
    await getDetAccessToken(creds);
    logger.warn.mockClear();
    fetchMock.mockImplementationOnce(() => Promise.reject(new DOMException("timed out", "TimeoutError")));
    await getDetPerformance(creds, "P1").catch(() => {});
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "dtcm-eticket:no-response", timedOut: true, errorName: "TimeoutError", causeCode: null }),
    );
  });

  it("never log the API key, the secret or a request body", async () => {
    script([400, detError("5005", "Section soldout")]);
    await createDetBasket(creds, { performanceCode: "P1", area: "A", priceTypeCode: "C" }).catch(() => {});
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error("ECONNREFUSED")));
    await getDetPerformance(creds, "P1").catch(() => {});
    const logged = JSON.stringify([...logger.warn.mock.calls, ...logger.info.mock.calls, ...logger.error.mock.calls]);
    expect(logged).not.toContain("apikey123secret");
    expect(logged).not.toContain("s3cret-value");
  });
});

describe("outcome unknown: the errors a purchase may NOT be retried after (review HIGH 1, 2)", () => {
  const customer = { id: "c1", account: "0", aFile: "tel" };
  const purchase = () => purchaseDetBasket(creds, "b1", customer, 0).catch((e) => e);

  it("a gateway 504 on purchase", async () => {
    script([504, "<html>Gateway Time-out</html>"]);
    expect(await purchase()).toMatchObject({ httpStatus: 504, outcomeUnknown: true, isNoResponse: false });
  });

  it("a 200 whose body is cut off mid-read", async () => {
    script();
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(new Response(new ReadableStream({ start: (c) => c.error(new Error("socket reset")) }), { status: 200 })),
    );
    expect(await purchase()).toMatchObject({ httpStatus: 200, bodyLost: true, outcomeUnknown: true });
  });

  it("a 200 that is not JSON, and a 200 without the order id", async () => {
    script([200, "<html>ok</html>"]);
    expect(await purchase()).toMatchObject({ outcomeUnknown: true });
    fetchMock.mockImplementationOnce(() => reply(200, { status: "done" }));
    expect(await purchase()).toMatchObject({ outcomeUnknown: true });
  });

  it("but a 400 from DET is a definite refusal", async () => {
    script([400, detError("5005", "Section soldout")]);
    expect(await purchase()).toMatchObject({ httpStatus: 400, outcomeUnknown: false });
  });
});

describe("hardening (review LOW 5, 6, 7)", () => {
  it("strips the API key and secret from a message, even when DET echoes them", async () => {
    script([502, "<p>Bad gateway for /baskets?api_key=apikey123secret (client_secret=s3cret-value)</p>"]);
    const err = await createDetBasket(creds, { performanceCode: "P1", area: "A", priceTypeCode: "C" }).catch((e) => e);
    expect(err.message).not.toContain("apikey123secret");
    expect(err.message).not.toContain("s3cret-value");
    expect(err.message).toContain("***");
  });

  it("reads a numeric DET code as a code", async () => {
    script([400, { code: 5001, message: "Basket is not found." }]);
    expect(await detBasketExists(creds, "b1")).toBe(false);
  });

  it("fetches a new token after a rotation (a new save time), in any process", async () => {
    script();
    await getDetAccessToken(creds);
    fetchMock.mockImplementationOnce(() => reply(200, { access_token: "tok-2", expires_in: 3600 }));
    expect(await getDetAccessToken({ ...creds, clientSecret: "rotated", version: "2026-11-04T09:00:00.000Z" })).toBe("tok-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("calls", () => {
  it("creates a basket as the seller, one seat, and returns its id", async () => {
    script([200, { id: "5094379", offers: [] }]);
    expect(await createDetBasket(creds, { performanceCode: "PDUB01DEC2023B", area: "SVIP2", priceTypeCode: "C" })).toBe("5094379");
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body).toMatchObject({ Channel: "API", Seller: "AMMEE1", Performancecode: "PDUB01DEC2023B", Area: "SVIP2" });
    expect(body.Demand[0]).toMatchObject({ PriceTypeCode: "C", Quantity: 1, Admits: 1 });
  });

  it("reads a purchased basket as gone (5001), and an open one as there", async () => {
    script([400, detError("5001", "Basket is not found.")]);
    expect(await detBasketExists(creds, "b1")).toBe(false);
    fetchMock.mockImplementationOnce(() => reply(200, { id: "b2", offers: [] }));
    expect(await detBasketExists(creds, "b2")).toBe(true);
  });

  it("does not read another failure as 'basket gone'", async () => {
    script([500, { code: "9999", message: "boom" }]);
    await expect(detBasketExists(creds, "b1")).rejects.toBeInstanceOf(DetApiError);
  });

  it("purchases with an EXTERNAL payment of the given amount", async () => {
    script([200, { orderId: "68163" }]);
    expect(await purchaseDetBasket(creds, "5094379", { id: "2604840", account: "0", aFile: "tel" }, 0)).toBe("68163");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      Seller: "AMMEE1",
      customer: { ID: "2604840", Account: "0", AFile: "tel" },
      Payments: [{ Amount: 0, MeansOfPayment: "EXTERNAL" }],
    });
  });

  it("reads the barcode and line item from an order, and null for 4001", async () => {
    script([
      200,
      {
        id: "68163",
        orderLines: [
          {
            orderLineItems: [
              {
                id: "294675",
                barcode: "ccfa6a61-6fe0-4707-a3b1-49faa1fce5e3",
                priceTypeCode: "C",
                priceTypeName: "Comps",
                customer: { id: 2604840 },
                seat: { section: "SVIP2" },
              },
            ],
          },
        ],
      },
    ]);
    expect(await getDetOrder(creds, "68163")).toEqual({
      orderId: "68163",
      barcode: "ccfa6a61-6fe0-4707-a3b1-49faa1fce5e3",
      lineItemId: "294675",
      section: "SVIP2",
      priceTypeCode: "C",
      priceTypeName: "Comps",
      customerId: "2604840",
    });
    fetchMock.mockImplementationOnce(() => reply(400, detError("4001", "Order not found")));
    expect(await getDetOrder(creds, "68163")).toBeNull();
  });

  it("answers 'not-found' for 4001 on reverse, never claiming it was reversed", async () => {
    script([204, ""]);
    expect(await reverseDetOrder(creds, "68163", 0)).toBe("reversed");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      Seller: "AMMEE1",
      refunds: [{ Amount: "0", MeansOfPayment: "EXTERNAL" }],
    });
    fetchMock.mockImplementationOnce(() => reply(400, detError("4001", "Order not found")));
    // DET says the same for a second reverse and for an order it never had (wrong environment).
    expect(await reverseDetOrder(creds, "68163", 0)).toBe("not-found");
  });

  it("summarises a performance map, naming each price type", async () => {
    script([
      200,
      {
        performanceCode: "PDUB01DEC2023B",
        name: "Batch 3 API upgrade",
        startDate: "2023-12-01T19:30:00",
        venueCode: "DWTC",
        sections: [{ code: "SVIP2", name: "VIP2", categoryId: 78, capacity: 160000, holds: 0 }],
        priceTypes: [{ priceTypeId: 2254, priceTypeCode: "C", priceTypeName: "Comps" }],
        ticketPrices: [{ categoryId: 78, typeCode: "C", price: 0 }],
      },
    ]);
    const p = await getDetPerformance(creds, "PDUB01DEC2023B");
    expect(p).toMatchObject({ name: "Batch 3 API upgrade", venueCode: "DWTC", endDate: null });
    expect(p.sections).toEqual([{ code: "SVIP2", name: "VIP2", categoryId: 78, capacity: 160000, holds: 0 }]);
    expect(p.priceTypes).toEqual([{ code: "C", name: "Comps", categoryId: 78, price: 0 }]);
  });
});
