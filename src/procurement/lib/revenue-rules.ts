/**
 * Revenue and margin, pure (spec §6b; owner decisions of 17 September 2026).
 * The service reads registrations and deals and hands them here; every rule
 * that decides a figure lives in this file so each is a table of test cases.
 *
 *   Actual revenue is money that has really come in or been signed for:
 *   a registration once PAID, at its price after the promo discount and net
 *   of refunds, without VAT; a CRM deal once WON. Nothing here is typed.
 *
 *   A won deal is split across income accounts by its products (quantity x
 *   unit price, each under its product's account). The difference between the
 *   deal's value and its products is its own "not itemised" figure, never
 *   spread across accounts by guesswork. A product whose In-House/Out-Sourced
 *   and category pair has no account is "no income account".
 *
 *   Amounts convert to the budget's reporting currency only where the rate is
 *   a fact (AED, USD and SAR are pegged). Anything else is listed as not
 *   converted and left out of the totals rather than priced at an invented
 *   rate.
 *
 *   Margin compares revenue with expense on the same ex-VAT basis. Planned:
 *   planned revenue less planned expense and contingency. Forecast: for each
 *   income account the larger of planned and actual, less the expense
 *   forecast (the same "larger of plan and what is known" the expense side
 *   uses), so early selling does not read as a loss and an overrun shows.
 *
 * Client-safe.
 */
import { AED_PEG_RATES, Decimal, money, storedString, toStored, type MoneyInput } from "./money";
import { DELEGATE_SALES_ACCOUNT, incomeAccountForCrmProduct } from "./income-accounts";

/** The rate from `from` to `to` when it is a fact, else null. */
export function pegRate(from: string, to: string): Decimal | null {
  if (from === to) return new Decimal(1);
  const a = AED_PEG_RATES[from];
  const b = AED_PEG_RATES[to];
  if (a === undefined || b === undefined) return null;
  return money(a).div(money(b));
}

export interface PaidRegistration {
  /** readRegistrationBasePrice(): the list price the registration was sold at. */
  basePrice: number;
  discountAmount: MoneyInput | null;
  /** Gross, VAT included, as refunds are recorded. */
  refundedAmount: MoneyInput | null;
  currency: string;
}

/**
 * What a paid registration earned, without VAT: price less discount, less the
 * refunds netted back out of VAT at the event's rate. Never below zero.
 */
export function registrationRevenue(reg: PaidRegistration, taxRatePercent: MoneyInput | null): Decimal {
  const taxable = Decimal.max(0, money(reg.basePrice).minus(money(reg.discountAmount ?? 0)));
  const refundedGross = money(reg.refundedAmount ?? 0);
  const refundedNet = refundedGross.div(new Decimal(1).plus(money(taxRatePercent ?? 0).div(100)));
  return toStored(Decimal.max(0, taxable.minus(refundedNet)));
}

export interface WonDealProduct {
  productName: string;
  category: string | null;
  source: "IN_HOUSE" | "OUTSOURCED" | null;
  quantity: number;
  unitPrice: MoneyInput;
  currency: string;
}
export interface WonDeal {
  dealValue: MoneyInput | null;
  currency: string;
  products: WonDealProduct[];
}

export interface NotConverted {
  from: "registrations" | "deals";
  currency: string;
  amount: string;
}
export interface UnmappedProduct {
  productName: string;
  category: string | null;
  source: "IN_HOUSE" | "OUTSOURCED" | null;
  amount: string;
}

export interface RevenueActuals {
  /** Income account code to amount, reporting currency, 4 dp strings. */
  byAccount: Record<string, string>;
  /** Won deals' value not covered by their products; negative when products exceed the value. */
  notItemised: string;
  noAccount: { amount: string; products: UnmappedProduct[] };
  notConverted: NotConverted[];
  /** Everything counted: accounts, not itemised and no account. */
  total: string;
  paidRegistrations: number;
  wonDeals: number;
}

export function aggregateActuals(input: {
  reportingCurrency: string;
  taxRatePercent: MoneyInput | null;
  registrations: PaidRegistration[];
  deals: WonDeal[];
}): RevenueActuals {
  const byAccount = new Map<string, Decimal>();
  const add = (code: string, v: Decimal) => byAccount.set(code, (byAccount.get(code) ?? new Decimal(0)).plus(v));
  const notConverted = new Map<string, Decimal>();
  const skip = (from: NotConverted["from"], currency: string, v: Decimal) => {
    const k = `${from}|${currency}`;
    notConverted.set(k, (notConverted.get(k) ?? new Decimal(0)).plus(v));
  };
  let notItemised = new Decimal(0);
  let noAccount = new Decimal(0);
  const unmapped: UnmappedProduct[] = [];

  for (const r of input.registrations) {
    const earned = registrationRevenue(r, input.taxRatePercent);
    const rate = pegRate(r.currency, input.reportingCurrency);
    if (!rate) skip("registrations", r.currency, earned);
    else add(DELEGATE_SALES_ACCOUNT, earned.mul(rate));
  }

  for (const d of input.deals) {
    const dealRate = pegRate(d.currency, input.reportingCurrency);
    if (!dealRate) {
      // Neither the value nor the split can be priced: the whole deal is left out and listed.
      const itemsTotal = d.products.reduce((a, p) => a.plus(money(p.unitPrice).mul(p.quantity)), new Decimal(0));
      skip("deals", d.currency, d.dealValue === null ? itemsTotal : money(d.dealValue));
      continue;
    }
    let itemised = new Decimal(0);
    for (const p of d.products) {
      const amount = money(p.unitPrice).mul(p.quantity);
      const rate = pegRate(p.currency, input.reportingCurrency);
      if (!rate) {
        skip("deals", p.currency, amount);
        continue;
      }
      const inReporting = amount.mul(rate);
      itemised = itemised.plus(inReporting);
      const account = incomeAccountForCrmProduct(p.source, p.category);
      if (account) {
        add(account, inReporting);
      } else {
        noAccount = noAccount.plus(inReporting);
        unmapped.push({ productName: p.productName, category: p.category, source: p.source, amount: storedString(inReporting) });
      }
    }
    if (d.dealValue !== null) notItemised = notItemised.plus(money(d.dealValue).mul(dealRate).minus(itemised));
  }

  const accounts = Object.fromEntries([...byAccount].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, storedString(v)]));
  const total = [...byAccount.values()].reduce((a, v) => a.plus(v), new Decimal(0)).plus(notItemised).plus(noAccount);
  return {
    byAccount: accounts,
    notItemised: storedString(notItemised),
    noAccount: { amount: storedString(noAccount), products: unmapped },
    notConverted: [...notConverted].map(([k, v]) => {
      const [from, currency] = k.split("|") as [NotConverted["from"], string];
      return { from, currency, amount: storedString(v) };
    }),
    total: storedString(total),
    paidRegistrations: input.registrations.length,
    wonDeals: input.deals.length,
  };
}

export interface MarginInput {
  /** Planned revenue per income account, reporting currency. */
  plannedByAccount: Record<string, MoneyInput>;
  actuals: Pick<RevenueActuals, "byAccount" | "notItemised" | "noAccount">;
  plannedExpenseTotal: MoneyInput;
  contingencyAmount: MoneyInput;
  forecastExpenseTotal: MoneyInput;
  targetMarginPercent: MoneyInput | null;
}

export interface MarginView {
  plannedRevenue: string;
  plannedCost: string;
  plannedMargin: string;
  plannedMarginPercent: string | null;
  forecastRevenue: string;
  forecastCost: string;
  forecastMargin: string;
  forecastMarginPercent: string | null;
  /** Set only when a target exists: the forecast margin is below it (or there is cost and no revenue). */
  belowTarget: boolean;
}

const pct = (margin: Decimal, revenue: Decimal): string | null => (revenue.gt(0) ? margin.div(revenue).mul(100).toFixed(2) : null);

export function marginView(input: MarginInput): MarginView {
  const plannedRevenue = Object.values(input.plannedByAccount).reduce<Decimal>((a, v) => a.plus(money(v)), new Decimal(0));
  const plannedCost = money(input.plannedExpenseTotal).plus(money(input.contingencyAmount));
  const plannedMargin = plannedRevenue.minus(plannedCost);

  const codes = new Set([...Object.keys(input.plannedByAccount), ...Object.keys(input.actuals.byAccount)]);
  let forecastRevenue = new Decimal(0);
  for (const code of codes) {
    forecastRevenue = forecastRevenue.plus(Decimal.max(money(input.plannedByAccount[code] ?? 0), money(input.actuals.byAccount[code] ?? 0)));
  }
  forecastRevenue = forecastRevenue.plus(money(input.actuals.notItemised)).plus(money(input.actuals.noAccount.amount));
  const forecastCost = Decimal.max(money(input.forecastExpenseTotal), plannedCost);
  const forecastMargin = forecastRevenue.minus(forecastCost);
  const forecastMarginPercent = pct(forecastMargin, forecastRevenue);

  let belowTarget = false;
  if (input.targetMarginPercent !== null && input.targetMarginPercent !== undefined && input.targetMarginPercent !== "") {
    belowTarget = forecastMarginPercent === null ? forecastCost.gt(0) : money(forecastMarginPercent).lt(money(input.targetMarginPercent));
  }
  return {
    plannedRevenue: storedString(plannedRevenue),
    plannedCost: storedString(plannedCost),
    plannedMargin: storedString(plannedMargin),
    plannedMarginPercent: pct(plannedMargin, plannedRevenue),
    forecastRevenue: storedString(forecastRevenue),
    forecastCost: storedString(forecastCost),
    forecastMargin: storedString(forecastMargin),
    forecastMarginPercent,
    belowTarget,
  };
}
