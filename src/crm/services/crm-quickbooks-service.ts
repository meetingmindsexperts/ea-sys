/**
 * CRM quotes to QuickBooks Estimates (Nov 4, 2026): the links a send needs and
 * the send itself. Errors as values; the routes map them to HTTP.
 *
 * Links (each records the QuickBooks company it was made in, so a sandbox link
 * never posts to the real books):
 *  - a sponsor company → an EXISTING QuickBooks customer (never created here);
 *  - a catalogue product → a QuickBooks product/service;
 *  - the organisation's VAT and no-VAT tax codes (CRM settings).
 *
 * THE SEND (`sendQuoteToQuickBooks`), the first EA-SYS write into QuickBooks:
 *   1. Readiness is judged by `quickBooksReadiness` (pure, shared with the
 *      screen), then checked live: the customer, products and the event's
 *      Class still exist and are active, and multi-currency allows the quote.
 *   2. The quote is claimed (`qboSendStartedAt`) by a conditional update, so a
 *      second click or a second tab stops there.
 *   3. Before creating, QuickBooks is asked for an Estimate with the quote's
 *      number. One carrying this quote's marker is ADOPTED: an earlier attempt
 *      made it and its answer was lost. One without the marker means the number
 *      is taken, and the send stops.
 *   4. The create carries a requestid that only moves on after a definite
 *      refusal, so QuickBooks answers a repeat with the first result.
 *   5. A sent quote is locked (crm-quote-service refuses edits and deletes);
 *      a change is made on the Estimate in QuickBooks.
 */
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { updateOrganizationSettings } from "@/lib/event-settings";
import { getCompanyInfo } from "@/lib/quickbooks/client";
import {
  buildEstimateBody,
  createEstimate,
  currentRealm,
  findClassByName,
  findEstimatesByDocNumber,
  getCustomer,
  getItems,
  listTaxCodes,
} from "@/lib/quickbooks/sales";
import { recordCrmActivity } from "@/crm/lib/crm-activity";
import {
  QBO_SEND_STALE_MS,
  TOTAL_TOLERANCE,
  estimateMarker,
  estimateRequestId,
  quickBooksReadiness,
  readCrmQuickBooksSettings,
  type CrmQuickBooksSettings,
  type QuickBooksProblem,
} from "@/crm/lib/quickbooks-rules";

export type CrmQuickBooksFailCode =
  | "QBO_NOT_CONNECTED"
  | "QBO_ERROR"
  | "COMPANY_NOT_FOUND"
  | "PRODUCT_NOT_FOUND"
  | "QBO_CUSTOMER_NOT_FOUND"
  | "QBO_ITEM_NOT_FOUND"
  | "QBO_TAX_CODE_NOT_FOUND"
  | "QUOTE_NOT_FOUND"
  | "QUOTE_ARCHIVED"
  | "QUOTE_ALREADY_SENT"
  | "QUOTE_SEND_IN_PROGRESS"
  | "QUOTE_NOT_READY"
  | "QBO_DOC_NUMBER_TAKEN"
  | "QBO_REFUSED"
  | "QBO_OUTCOME_UNKNOWN"
  | "UNKNOWN";

export interface CrmQuickBooksFail {
  ok: false;
  code: CrmQuickBooksFailCode;
  message: string;
  meta?: Record<string, unknown>;
}

interface Actor {
  organizationId: string;
  userId: string | null;
  source: "rest" | "mcp" | "agent" | "api";
}

const NOT_CONNECTED = new Set(["NOT_CONFIGURED", "NOT_CONNECTED", "ENVIRONMENT_MISMATCH", "APP_CHANGED", "REFRESH_EXPIRED"]);

/** A QuickBooks failure as this service's error value: "not connected" is the admin's to fix, the rest is QuickBooks'. */
function qboFail(res: { code: string; message: string }, organizationId: string, step: string): CrmQuickBooksFail {
  const notConnected = NOT_CONNECTED.has(res.code);
  apiLogger.warn({ msg: "crm-quickbooks:qbo-failed", organizationId, step, qboCode: res.code, message: res.message });
  return notConnected
    ? { ok: false, code: "QBO_NOT_CONNECTED", message: "QuickBooks is not connected. An admin connects it in Settings → Integrations.", meta: { qboCode: res.code } }
    : { ok: false, code: "QBO_ERROR", message: `QuickBooks did not answer: ${res.message}`, meta: { qboCode: res.code, step } };
}

function unknownFail(err: unknown, msg: string, context: Record<string, unknown>): CrmQuickBooksFail {
  apiLogger.error({ msg, ...context, err: err instanceof Error ? err.message : String(err) });
  return { ok: false, code: "UNKNOWN", message: "Something went wrong talking to QuickBooks" };
}

// ── Links ─────────────────────────────────────────────────────────────────────

/** Link a sponsor company to an existing QuickBooks customer, or unlink it (`customerId: null`). */
export async function linkCompanyToCustomer(
  args: Actor & { companyId: string; customerId: string | null },
): Promise<{ ok: true; company: { id: string; qboCustomerId: string | null; qboCustomerName: string | null; qboCustomerCurrency: string | null } } | CrmQuickBooksFail> {
  try {
    const company = await db.crmCompany.findFirst({
      where: { id: args.companyId, organizationId: args.organizationId },
      select: { id: true, name: true, qboCustomerId: true, qboCustomerName: true },
    });
    if (!company) {
      apiLogger.warn({ msg: "crm-quickbooks:company-not-found", companyId: args.companyId, organizationId: args.organizationId });
      return { ok: false, code: "COMPANY_NOT_FOUND", message: "Company not found" };
    }

    let data = { qboCustomerId: null as string | null, qboCustomerName: null as string | null, qboCustomerCurrency: null as string | null, qboRealmId: null as string | null };
    if (args.customerId) {
      const [realm, customer] = await Promise.all([currentRealm(args.organizationId), getCustomer(args.organizationId, args.customerId)]);
      if (!realm.ok) return qboFail(realm, args.organizationId, "link-company:realm");
      if (!customer.ok) return qboFail(customer, args.organizationId, "link-company:customer");
      if (!customer.data || !customer.data.active) {
        apiLogger.warn({ msg: "crm-quickbooks:customer-not-found", customerId: args.customerId, organizationId: args.organizationId });
        return { ok: false, code: "QBO_CUSTOMER_NOT_FOUND", message: "That QuickBooks customer was not found or is inactive" };
      }
      data = { qboCustomerId: customer.data.id, qboCustomerName: customer.data.displayName, qboCustomerCurrency: customer.data.currency, qboRealmId: realm.data.realmId };
    }

    const updated = await db.crmCompany.update({
      where: { id: company.id },
      data,
      select: { id: true, qboCustomerId: true, qboCustomerName: true, qboCustomerCurrency: true },
    });
    void recordCrmActivity({
      organizationId: args.organizationId,
      entityType: "COMPANY",
      entityId: company.id,
      action: data.qboCustomerId ? "QUICKBOOKS_LINKED" : "QUICKBOOKS_UNLINKED",
      actorId: args.userId,
      changes: { source: args.source, qboCustomer: { from: company.qboCustomerName, to: data.qboCustomerName } },
    });
    apiLogger.info({ msg: "crm-quickbooks:company-linked", organizationId: args.organizationId, companyId: company.id, qboCustomerId: data.qboCustomerId });
    return { ok: true, company: updated };
  } catch (err) {
    return unknownFail(err, "crm-quickbooks:link-company-failed", { organizationId: args.organizationId, companyId: args.companyId });
  }
}

/** Link a catalogue product to a QuickBooks product/service, or unlink it (`itemId: null`). */
export async function linkProductToItem(
  args: Actor & { productId: string; itemId: string | null },
): Promise<{ ok: true; product: { id: string; qboItemId: string | null; qboItemName: string | null } } | CrmQuickBooksFail> {
  try {
    const product = await db.crmProduct.findFirst({
      where: { id: args.productId, organizationId: args.organizationId },
      select: { id: true },
    });
    if (!product) {
      apiLogger.warn({ msg: "crm-quickbooks:product-not-found", productId: args.productId, organizationId: args.organizationId });
      return { ok: false, code: "PRODUCT_NOT_FOUND", message: "Product not found" };
    }

    let data = { qboItemId: null as string | null, qboItemName: null as string | null, qboRealmId: null as string | null };
    if (args.itemId) {
      const [realm, items] = await Promise.all([currentRealm(args.organizationId), getItems(args.organizationId, [args.itemId])]);
      if (!realm.ok) return qboFail(realm, args.organizationId, "link-product:realm");
      if (!items.ok) return qboFail(items, args.organizationId, "link-product:item");
      const item = items.data[0];
      if (!item || !item.active) {
        apiLogger.warn({ msg: "crm-quickbooks:item-not-found", itemId: args.itemId, organizationId: args.organizationId });
        return { ok: false, code: "QBO_ITEM_NOT_FOUND", message: "That QuickBooks product/service was not found or is inactive" };
      }
      data = { qboItemId: item.id, qboItemName: item.name, qboRealmId: realm.data.realmId };
    }

    const updated = await db.crmProduct.update({ where: { id: product.id }, data, select: { id: true, qboItemId: true, qboItemName: true } });
    apiLogger.info({ msg: "crm-quickbooks:product-linked", organizationId: args.organizationId, productId: product.id, qboItemId: data.qboItemId, userId: args.userId });
    return { ok: true, product: updated };
  } catch (err) {
    return unknownFail(err, "crm-quickbooks:link-product-failed", { organizationId: args.organizationId, productId: args.productId });
  }
}

/** The VAT and no-VAT codes a quote's tax maps to, checked against QuickBooks and stored with the VAT code's rate. */
export async function saveQuickBooksTaxCodes(
  args: Actor & { vatTaxCodeId: string; noVatTaxCodeId: string },
): Promise<{ ok: true; settings: CrmQuickBooksSettings } | CrmQuickBooksFail> {
  try {
    const [realm, codes] = await Promise.all([currentRealm(args.organizationId), listTaxCodes(args.organizationId)]);
    if (!realm.ok) return qboFail(realm, args.organizationId, "tax-codes:realm");
    if (!codes.ok) return qboFail(codes, args.organizationId, "tax-codes:list");

    const vat = codes.data.find((c) => c.id === args.vatTaxCodeId && c.active);
    const noVat = codes.data.find((c) => c.id === args.noVatTaxCodeId && c.active);
    if (!vat || !noVat || vat.rate === null) {
      apiLogger.warn({ msg: "crm-quickbooks:tax-code-not-found", organizationId: args.organizationId, vat: args.vatTaxCodeId, noVat: args.noVatTaxCodeId });
      return { ok: false, code: "QBO_TAX_CODE_NOT_FOUND", message: "Pick an active VAT code with a rate, and an active no-VAT code" };
    }

    const settings: CrmQuickBooksSettings = {
      realmId: realm.data.realmId,
      vatTaxCodeId: vat.id,
      vatTaxCodeName: vat.name,
      vatRate: vat.rate,
      noVatTaxCodeId: noVat.id,
      noVatTaxCodeName: noVat.name,
    };
    await updateOrganizationSettings(args.organizationId, (current) => ({ ...current, crmQuickBooks: settings }));
    apiLogger.info({ msg: "crm-quickbooks:tax-codes-saved", organizationId: args.organizationId, userId: args.userId, vatRate: vat.rate });
    return { ok: true, settings };
  } catch (err) {
    return unknownFail(err, "crm-quickbooks:tax-codes-failed", { organizationId: args.organizationId });
  }
}

// ── Readiness + send ──────────────────────────────────────────────────────────

const SEND_SELECT = {
  id: true,
  dealId: true,
  number: true,
  currency: true,
  quoteDate: true,
  validUntil: true,
  taxRate: true,
  total: true,
  notes: true,
  archivedAt: true,
  qboEstimateId: true,
  qboEstimateNumber: true,
  qboSentAt: true,
  qboSendStartedAt: true,
  qboSendAttempt: true,
  lines: {
    orderBy: { sortOrder: "asc" },
    select: {
      name: true,
      description: true,
      quantity: true,
      unitPrice: true,
      amount: true,
      crmProductId: true,
      crmProduct: { select: { name: true, qboItemId: true, qboRealmId: true } },
    },
  },
  deal: {
    select: {
      status: true,
      company: { select: { name: true, qboCustomerId: true, qboCustomerCurrency: true, qboRealmId: true } },
      event: { select: { code: true } },
      org: { select: { settings: true } },
    },
  },
} satisfies Prisma.CrmQuoteSelect;

async function loadQuote(organizationId: string, dealId: string, quoteId: string) {
  return db.crmQuote.findFirst({ where: { id: quoteId, dealId, organizationId }, select: SEND_SELECT });
}
type SendQuote = NonNullable<Awaited<ReturnType<typeof loadQuote>>>;

function readinessFor(quote: SendQuote, realmId: string) {
  return quickBooksReadiness({
    realmId,
    dealStatus: quote.deal.status,
    company: quote.deal.company,
    quote: { currency: quote.currency, taxRate: quote.taxRate === null ? null : Number(quote.taxRate) },
    lines: quote.lines.map((l) => ({ name: l.name, crmProductId: l.crmProductId, product: l.crmProduct })),
    settings: readCrmQuickBooksSettings(quote.deal.org.settings),
  });
}

export interface QuoteQuickBooksState {
  sent: boolean;
  estimateId: string | null;
  estimateNumber: string | null;
  sentAt: string | null;
  problems: QuickBooksProblem[];
}

/** What the deal screen shows for one quote: sent, or the problems still standing. No QuickBooks call beyond the realm. */
export async function getQuoteQuickBooksState(
  args: { organizationId: string; dealId: string; quoteId: string },
): Promise<{ ok: true; state: QuoteQuickBooksState } | CrmQuickBooksFail> {
  try {
    const quote = await loadQuote(args.organizationId, args.dealId, args.quoteId);
    if (!quote) {
      apiLogger.warn({ msg: "crm-quickbooks:state-quote-not-found", ...args });
      return { ok: false, code: "QUOTE_NOT_FOUND", message: "Quote not found" };
    }
    if (quote.qboEstimateId) {
      return {
        ok: true,
        state: { sent: true, estimateId: quote.qboEstimateId, estimateNumber: quote.qboEstimateNumber, sentAt: quote.qboSentAt?.toISOString() ?? null, problems: [] },
      };
    }
    const realm = await currentRealm(args.organizationId);
    if (!realm.ok) return qboFail(realm, args.organizationId, "state:realm");
    const readiness = readinessFor(quote, realm.data.realmId);
    return { ok: true, state: { sent: false, estimateId: null, estimateNumber: null, sentAt: null, problems: readiness.ok ? [] : readiness.problems } };
  } catch (err) {
    return unknownFail(err, "crm-quickbooks:state-failed", args);
  }
}

export interface SentEstimate {
  estimateId: string;
  estimateNumber: string | null;
  adopted: boolean;
  /** Set when QuickBooks' total differs from the quote's: the Estimate exists, someone should look. */
  totalWarning: string | null;
}

/** Hand the claim back, recording why, so the next click can try again. */
async function releaseClaim(quoteId: string, error: string, nextAttempt: boolean) {
  await db.crmQuote
    .updateMany({
      where: { id: quoteId, qboEstimateId: null },
      data: { qboSendStartedAt: null, qboLastError: error.slice(0, 500), ...(nextAttempt ? { qboSendAttempt: { increment: 1 } } : {}) },
    })
    .catch((err: unknown) => apiLogger.error({ msg: "crm-quickbooks:release-failed", quoteId, err: err instanceof Error ? err.message : String(err) }));
}

/** Live checks the stored links cannot answer: still active, currency still allowed, the event's Class exists. */
async function liveChecks(
  organizationId: string,
  quote: SendQuote,
  plan: { customerId: string; itemIds: string[] },
): Promise<{ ok: true; currency: string | null; classId: string | null } | CrmQuickBooksFail> {
  const eventCode = quote.deal.event?.code?.trim() || null;
  const [customer, items, company, klass] = await Promise.all([
    getCustomer(organizationId, plan.customerId),
    getItems(organizationId, [...new Set(plan.itemIds)]),
    getCompanyInfo(organizationId),
    eventCode ? findClassByName(organizationId, eventCode) : Promise.resolve(null),
  ]);
  if (!customer.ok) return qboFail(customer, organizationId, "send:customer");
  if (!items.ok) return qboFail(items, organizationId, "send:items");
  if (!company.ok) return qboFail(company, organizationId, "send:company");
  if (klass && !klass.ok) return qboFail(klass, organizationId, "send:class");

  const problems: string[] = [];
  if (!customer.data || !customer.data.active) problems.push("The linked QuickBooks customer is gone or inactive. Link the company again.");
  else if (customer.data.currency && customer.data.currency !== quote.currency) {
    problems.push(`The QuickBooks customer is now in ${customer.data.currency}, but the quote is in ${quote.currency}.`);
  }
  const active = new Set(items.data.filter((i) => i.active).map((i) => i.id));
  const inactive = [...new Set(plan.itemIds)].filter((id) => !active.has(id));
  if (inactive.length > 0) problems.push("A linked QuickBooks product/service is gone or inactive. Link the product again.");

  const home = company.data.homeCurrency;
  const multi = company.data.multiCurrencyEnabled === true;
  if (!multi && home && quote.currency !== home) {
    problems.push(`The quote is in ${quote.currency}, but multi-currency is off in QuickBooks and its currency is ${home}.`);
  }
  if (eventCode && klass?.ok && !klass.data) {
    problems.push(`QuickBooks has no active Class named ${eventCode} for this deal's event.`);
  }

  if (problems.length > 0) {
    apiLogger.warn({ msg: "crm-quickbooks:send-live-check-failed", organizationId, quoteId: quote.id, problems });
    return { ok: false, code: "QUOTE_NOT_READY", message: problems[0]!, meta: { problems: problems.map((message) => ({ code: "LIVE_CHECK", message })) } };
  }
  return { ok: true, currency: multi ? quote.currency : null, classId: klass?.ok && klass.data ? klass.data.id : null };
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

async function recordSent(args: Actor & { dealId: string }, quote: SendQuote, sent: SentEstimate, sentByName: string | null) {
  void recordCrmActivity({
    organizationId: args.organizationId,
    entityType: "DEAL",
    entityId: args.dealId,
    action: "QUICKBOOKS_ESTIMATE_SENT",
    actorId: args.userId,
    changes: {
      source: args.source,
      quoteNumber: quote.number,
      estimateNumber: sent.estimateNumber,
      adopted: sent.adopted,
      ...(sent.totalWarning ? { warning: sent.totalWarning } : {}),
      ...(sentByName ? { sentBy: sentByName } : {}),
    },
  });
  apiLogger.info({
    msg: "crm-quickbooks:estimate-sent",
    organizationId: args.organizationId,
    dealId: args.dealId,
    quoteId: quote.id,
    estimateId: sent.estimateId,
    adopted: sent.adopted,
    totalWarning: sent.totalWarning,
  });
}

async function userName(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const user = await db.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } });
  const name = user ? `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() : "";
  return name || null;
}

/** Send one saved quote to QuickBooks as an Estimate. See the module header for the rules. */
export async function sendQuoteToQuickBooks(
  args: Actor & { dealId: string; quoteId: string },
): Promise<{ ok: true; estimate: SentEstimate } | CrmQuickBooksFail> {
  const ctx = { organizationId: args.organizationId, dealId: args.dealId, quoteId: args.quoteId };
  try {
    const quote = await loadQuote(args.organizationId, args.dealId, args.quoteId);
    if (!quote) {
      apiLogger.warn({ msg: "crm-quickbooks:send-quote-not-found", ...ctx });
      return { ok: false, code: "QUOTE_NOT_FOUND", message: "Quote not found" };
    }
    if (quote.archivedAt) {
      apiLogger.warn({ msg: "crm-quickbooks:send-quote-archived", ...ctx });
      return { ok: false, code: "QUOTE_ARCHIVED", message: "This quote was deleted" };
    }
    if (quote.qboEstimateId) {
      apiLogger.warn({ msg: "crm-quickbooks:send-already-sent", ...ctx, estimateId: quote.qboEstimateId });
      return { ok: false, code: "QUOTE_ALREADY_SENT", message: "This quote is already in QuickBooks", meta: { estimateId: quote.qboEstimateId } };
    }

    const realm = await currentRealm(args.organizationId);
    if (!realm.ok) return qboFail(realm, args.organizationId, "send:realm");

    const readiness = readinessFor(quote, realm.data.realmId);
    if (!readiness.ok) {
      apiLogger.warn({ msg: "crm-quickbooks:send-not-ready", ...ctx, codes: readiness.problems.map((p) => p.code) });
      return { ok: false, code: "QUOTE_NOT_READY", message: readiness.problems[0]!.message, meta: { problems: readiness.problems } };
    }

    const live = await liveChecks(args.organizationId, quote, readiness.plan);
    if (!live.ok) return live;

    // The claim: a second click, a second tab or a retried request stops here.
    const claim = await db.crmQuote.updateMany({
      where: {
        id: quote.id,
        organizationId: args.organizationId,
        archivedAt: null,
        qboEstimateId: null,
        OR: [{ qboSendStartedAt: null }, { qboSendStartedAt: { lt: new Date(Date.now() - QBO_SEND_STALE_MS) } }],
      },
      data: { qboSendStartedAt: new Date() },
    });
    if (claim.count === 0) {
      apiLogger.warn({ msg: "crm-quickbooks:send-in-progress", ...ctx });
      return { ok: false, code: "QUOTE_SEND_IN_PROGRESS", message: "This quote is being sent right now. Refresh in a moment." };
    }

    const sentByName = await userName(args.userId);
    const marker = estimateMarker(quote.id);

    // An Estimate with this number may already exist: ours from a lost answer, or someone else's.
    const existing = await findEstimatesByDocNumber(args.organizationId, quote.number);
    if (!existing.ok) {
      await releaseClaim(quote.id, `Lookup failed: ${existing.message}`, false);
      return qboFail(existing, args.organizationId, "send:lookup");
    }
    const ours = existing.data.find((e) => e.privateNote?.includes(marker));
    if (!ours && existing.data.length > 0) {
      await releaseClaim(quote.id, `QuickBooks already has an Estimate numbered ${quote.number}`, false);
      apiLogger.warn({ msg: "crm-quickbooks:doc-number-taken", ...ctx, estimateIds: existing.data.map((e) => e.id) });
      return {
        ok: false,
        code: "QBO_DOC_NUMBER_TAKEN",
        message: `QuickBooks already has an Estimate numbered ${quote.number} that EA-SYS did not make. Ask finance to check it.`,
      };
    }

    let estimate = ours ?? null;
    if (!estimate) {
      const body = buildEstimateBody({
        customerId: readiness.plan.customerId,
        docNumber: quote.number,
        txnDate: dateOnly(quote.quoteDate),
        expirationDate: dateOnly(quote.validUntil),
        currency: live.currency,
        classId: live.classId,
        customerMemo: quote.notes,
        privateNote: `${marker}${sentByName ? `, sent by ${sentByName}` : ""}`,
        lines: quote.lines.map((l, i) => ({
          itemId: readiness.plan.itemIds[i]!,
          description: l.description ? `${l.name}\n${l.description}` : l.name,
          quantity: l.quantity,
          unitPrice: Number(l.unitPrice),
          amount: Number(l.amount),
          taxCodeId: readiness.plan.taxCodeId,
        })),
      });
      const created = await createEstimate(args.organizationId, body, estimateRequestId(quote.id, quote.qboSendAttempt));
      if (!created.ok) {
        if (created.outcomeUnknown) {
          await releaseClaim(quote.id, "QuickBooks did not confirm. Sending again checks QuickBooks first, so it never makes a second Estimate.", false);
          return {
            ok: false,
            code: "QBO_OUTCOME_UNKNOWN",
            message: "QuickBooks did not confirm the Estimate. Send again: EA-SYS checks QuickBooks first and never makes a second one.",
          };
        }
        if (NOT_CONNECTED.has(created.code)) {
          await releaseClaim(quote.id, created.message, false);
          return qboFail(created, args.organizationId, "send:create");
        }
        await releaseClaim(quote.id, `QuickBooks refused: ${created.message}`, true);
        apiLogger.warn({ msg: "crm-quickbooks:estimate-refused", ...ctx, status: created.status, message: created.message });
        return { ok: false, code: "QBO_REFUSED", message: `QuickBooks refused the Estimate: ${created.message}` };
      }
      estimate = created.data;
    }

    const quoteTotal = Number(quote.total);
    const totalWarning =
      estimate.totalAmt !== null && Math.abs(estimate.totalAmt - quoteTotal) > TOTAL_TOLERANCE
        ? `QuickBooks' total is ${estimate.totalAmt.toFixed(2)}, the quote's is ${quoteTotal.toFixed(2)}. Check the Estimate's VAT.`
        : null;

    await db.crmQuote.update({
      where: { id: quote.id },
      data: {
        qboEstimateId: estimate.id,
        qboEstimateNumber: estimate.docNumber,
        qboRealmId: realm.data.realmId,
        qboEnvironment: realm.data.environment,
        qboSentAt: new Date(),
        qboSentById: args.userId,
        qboSentByName: sentByName,
        qboSendStartedAt: null,
        qboLastError: totalWarning,
      },
    });

    const sent: SentEstimate = { estimateId: estimate.id, estimateNumber: estimate.docNumber, adopted: Boolean(ours), totalWarning };
    await recordSent(args, quote, sent, sentByName);
    return { ok: true, estimate: sent };
  } catch (err) {
    // The claim is left to go stale: whether the Estimate was made is unknown,
    // and the next send's number lookup settles it.
    return unknownFail(err, "crm-quickbooks:send-failed", ctx);
  }
}
