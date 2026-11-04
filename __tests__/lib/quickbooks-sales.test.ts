/**
 * QuickBooks sales calls (Nov 4, 2026): the query quoting, the Estimate body,
 * and how a create's failure is judged. Network is stubbed; no Intuit calls.
 *
 * The judgement that matters: a 4xx is a definite refusal (nothing was made,
 * safe to report "not sent"), while a network error, a 5xx or an unreadable
 * 2xx may have created the Estimate, so the caller must look before retrying.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const { getAccessToken } = vi.hoisted(() => ({ getAccessToken: vi.fn() }));
vi.mock("@/lib/quickbooks/connection", () => ({ getAccessToken, saveConnection: vi.fn() }));

import { buildEstimateBody, createEstimate, qboLiteral } from "@/lib/quickbooks/sales";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  getAccessToken.mockResolvedValue({ ok: true, accessToken: "t", realmId: "realm-1", environment: "sandbox" });
});

describe("qboLiteral", () => {
  it("quotes a typed name so it cannot end the literal", () => {
    expect(qboLiteral("O'Brien")).toBe("'O\\'Brien'");
    expect(qboLiteral("a\\' OR 1=1")).toBe("'a\\\\\\' OR 1=1'");
  });

  it("caps a pasted essay", () => {
    expect(qboLiteral("x".repeat(500)).length).toBe(102);
  });
});

describe("buildEstimateBody", () => {
  const input = {
    customerId: "c-1",
    docNumber: "Q-2026-0006",
    txnDate: "2026-11-04",
    expirationDate: "2026-12-04",
    currency: "USD",
    classId: "cls-1",
    customerMemo: "Thank you",
    privateNote: "EA-SYS quote q-1",
    lines: [{ itemId: "i-1", description: "Sponsorship - Gold", quantity: 1, unitPrice: 75000, amount: 75000, taxCodeId: "tc-5" }],
  };

  it("maps the quote onto the Estimate, VAT-exclusive, with the class on every line", () => {
    const body = buildEstimateBody(input);
    expect(body).toMatchObject({
      CustomerRef: { value: "c-1" },
      DocNumber: "Q-2026-0006",
      TxnDate: "2026-11-04",
      ExpirationDate: "2026-12-04",
      CurrencyRef: { value: "USD" },
      ClassRef: { value: "cls-1" },
      CustomerMemo: { value: "Thank you" },
      PrivateNote: "EA-SYS quote q-1",
      GlobalTaxCalculation: "TaxExcluded",
      Line: [
        {
          DetailType: "SalesItemLineDetail",
          Amount: 75000,
          Description: "Sponsorship - Gold",
          SalesItemLineDetail: { ItemRef: { value: "i-1" }, Qty: 1, UnitPrice: 75000, TaxCodeRef: { value: "tc-5" }, ClassRef: { value: "cls-1" } },
        },
      ],
    });
  });

  it("leaves out the currency, class and memo when there are none", () => {
    const body = buildEstimateBody({ ...input, currency: null, classId: null, customerMemo: null });
    expect(body).not.toHaveProperty("CurrencyRef");
    expect(body).not.toHaveProperty("ClassRef");
    expect(body).not.toHaveProperty("CustomerMemo");
  });
});

describe("createEstimate", () => {
  it("posts with the requestid and returns the Estimate", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ Estimate: { Id: "77", DocNumber: "Q-2026-0006", TotalAmt: 78750, PrivateNote: "EA-SYS quote q-1" } }), { status: 200 }),
    );
    const res = await createEstimate("org-1", { DocNumber: "Q-2026-0006" }, "crmq-q-1-0");
    expect(res).toMatchObject({ ok: true, data: { id: "77", docNumber: "Q-2026-0006", totalAmt: 78750 }, realmId: "realm-1" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/v3/company/realm-1/estimate?requestid=crmq-q-1-0");
    expect(init).toMatchObject({ method: "POST" });
  });

  it("a 400 is a definite refusal, with QuickBooks' own reason", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ Fault: { Error: [{ Message: "Object Not Found", Detail: "Item 9 is inactive" }] } }), { status: 400 }),
    );
    const res = await createEstimate("org-1", {}, "r");
    expect(res).toMatchObject({ ok: false, outcomeUnknown: false, message: "Object Not Found: Item 9 is inactive" });
  });

  it("a network error, a 5xx or an unreadable 2xx may have created it", async () => {
    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await createEstimate("org-1", {}, "r")).toMatchObject({ ok: false, outcomeUnknown: true });

    fetchMock.mockResolvedValueOnce(new Response("oops", { status: 503 }));
    expect(await createEstimate("org-1", {}, "r")).toMatchObject({ ok: false, outcomeUnknown: true });

    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 200 }));
    expect(await createEstimate("org-1", {}, "r")).toMatchObject({ ok: false, outcomeUnknown: true });
  });

  it("not connected is a definite no, and makes no call", async () => {
    getAccessToken.mockResolvedValue({ ok: false, code: "NOT_CONNECTED", message: "no" });
    expect(await createEstimate("org-1", {}, "r")).toMatchObject({ ok: false, code: "NOT_CONNECTED", outcomeUnknown: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
