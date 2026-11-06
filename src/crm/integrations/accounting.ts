/**
 * THE CRM'S ACCOUNTING PORT (Nov 6, 2026; CRM product review P1-8).
 *
 * Everything the CRM asks of an accounting system: is one connected, find a
 * customer, a product/service, the VAT codes and a class, and send a quote as
 * an Estimate. The CRM's QuickBooks service and routes call this interface and
 * never @/lib/quickbooks directly, so a CRM deployed on its own (or a tenant on
 * another ledger) supplies a different implementation without the send's
 * never-twice logic changing. The default is EA-SYS's QuickBooks Online
 * connector, the one Budgets and later invoices share.
 *
 * The shapes are the connector's own (re-exported under the CRM's names): they
 * are already plain values, and a second set of identical types would be a
 * copy to keep in step, not a boundary.
 */
import { getCompanyInfo } from "@/lib/quickbooks/client";
import { loadQuickBooksApp } from "@/lib/quickbooks/app";
import { loadConnection, toStatus, type QuickBooksConnectionStatus } from "@/lib/quickbooks/connection";
import {
  buildEstimateBody,
  createEstimate,
  currentRealm,
  findClassByName,
  findEstimatesByDocNumber,
  getCustomTxnNumbers,
  getCustomer,
  getItems,
  listTaxCodes,
  searchCustomers,
  searchItems,
  type CreateEstimateResult,
  type EstimateInput,
  type QboClassRef,
  type QboCustomer,
  type QboEstimateSummary,
  type QboItem,
  type QboTaxCode,
} from "@/lib/quickbooks/sales";
import type { QboCompany, QboResult } from "@/lib/quickbooks/client";
import type { QuickBooksEnvironment } from "@/lib/quickbooks/config";

export type {
  CreateEstimateResult,
  EstimateInput,
  QboClassRef as AccountingClass,
  QboCompany as AccountingCompany,
  QboCustomer as AccountingCustomer,
  QboEstimateSummary as AccountingEstimate,
  QboItem as AccountingItem,
  QboResult as AccountingResult,
  QboTaxCode as AccountingTaxCode,
  QuickBooksConnectionStatus as AccountingConnectionStatus,
};

export interface CrmAccountingProvider {
  connectionStatus(organizationId: string): Promise<QuickBooksConnectionStatus>;
  /** Which company (and environment) the organisation is connected to now. */
  currentRealm(organizationId: string): Promise<QboResult<{ realmId: string; environment: QuickBooksEnvironment }>>;
  companyInfo(organizationId: string): Promise<QboResult<QboCompany>>;
  searchCustomers(organizationId: string, search: string): Promise<QboResult<QboCustomer[]>>;
  getCustomer(organizationId: string, id: string): Promise<QboResult<QboCustomer | null>>;
  searchItems(organizationId: string, search: string): Promise<QboResult<QboItem[]>>;
  getItems(organizationId: string, ids: string[]): Promise<QboResult<QboItem[]>>;
  listTaxCodes(organizationId: string): Promise<QboResult<QboTaxCode[]>>;
  findClassByName(organizationId: string, name: string): Promise<QboResult<QboClassRef | null>>;
  /** Does the company keep the document numbers it is sent? null when unknown. */
  customTxnNumbers(organizationId: string): Promise<QboResult<boolean | null>>;
  findEstimatesByDocNumber(organizationId: string, docNumber: string): Promise<QboResult<QboEstimateSummary[]>>;
  /** Create the Estimate; `requestId` makes a repeat return the first result. */
  createEstimate(organizationId: string, input: EstimateInput, requestId: string): Promise<CreateEstimateResult>;
}

/** EA-SYS's QuickBooks Online connector, behind the CRM's port. */
export const crmAccounting: CrmAccountingProvider = {
  async connectionStatus(organizationId) {
    const [app, connection] = await Promise.all([loadQuickBooksApp(organizationId), loadConnection(organizationId)]);
    return toStatus(connection, app);
  },
  currentRealm: (organizationId) => currentRealm(organizationId),
  companyInfo: (organizationId) => getCompanyInfo(organizationId),
  searchCustomers: (organizationId, search) => searchCustomers(organizationId, search),
  getCustomer: (organizationId, id) => getCustomer(organizationId, id),
  searchItems: (organizationId, search) => searchItems(organizationId, search),
  getItems: (organizationId, ids) => getItems(organizationId, ids),
  listTaxCodes: (organizationId) => listTaxCodes(organizationId),
  findClassByName: (organizationId, name) => findClassByName(organizationId, name),
  customTxnNumbers: (organizationId) => getCustomTxnNumbers(organizationId),
  findEstimatesByDocNumber: (organizationId, docNumber) => findEstimatesByDocNumber(organizationId, docNumber),
  createEstimate: (organizationId, input, requestId) => createEstimate(organizationId, buildEstimateBody(input), requestId),
};
