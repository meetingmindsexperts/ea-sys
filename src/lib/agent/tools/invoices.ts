import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import type { ToolExecutor } from "./_shared";

const listInvoices: ToolExecutor = async (input, ctx) => {
  try {
    const limit = Math.min(Number(input.limit ?? 50), 200);
    const invoices = await db.invoice.findMany({
      where: {
        eventId: ctx.eventId,
        ...(input.type ? { type: String(input.type) as never } : {}),
        ...(input.status ? { status: String(input.status) as never } : {}),
      },
      select: {
        id: true, invoiceNumber: true, type: true, status: true, total: true, currency: true,
        issueDate: true, paidDate: true,
        registration: { select: { attendee: { select: { firstName: true, lastName: true, email: true } } } },
      },
      take: limit,
      orderBy: { issueDate: "desc" },
    });
    return { invoices, total: invoices.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_invoices failed");
    return { error: "Failed to fetch invoices" };
  }
};

// ─── Email Template Executor ──────────────────────────────────────────────────

const createInvoiceExec: ToolExecutor = async (input, ctx) => {
  try {
    const registrationId = String(input.registrationId ?? "").trim();
    if (!registrationId) return { error: "registrationId is required" };

    // Verify registration belongs to this org's event
    const registration = await db.registration.findFirst({
      where: { id: registrationId, event: { organizationId: ctx.organizationId } },
      select: { id: true, eventId: true },
    });
    if (!registration) return { error: `Registration ${registrationId} not found or access denied` };

    const { createInvoice } = await import("@/lib/invoice-service");
    const invoice = await createInvoice({
      registrationId,
      eventId: registration.eventId,
      organizationId: ctx.organizationId,
      dueDate: input.dueDate ? new Date(String(input.dueDate)) : undefined,
    });

    return {
      success: true,
      invoice: {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        type: invoice.type,
        status: invoice.status,
        total: Number(invoice.total),
        currency: invoice.currency,
        issueDate: invoice.issueDate,
        dueDate: invoice.dueDate,
      },
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:create_invoice failed");
    return { error: err instanceof Error ? err.message : "Failed to create invoice" };
  }
};

const sendInvoiceExec: ToolExecutor = async (input, ctx) => {
  try {
    const invoiceId = String(input.invoiceId ?? "").trim();
    if (!invoiceId) return { error: "invoiceId is required" };

    const existing = await db.invoice.findFirst({
      where: { id: invoiceId, event: { organizationId: ctx.organizationId } },
      select: { id: true, eventId: true, invoiceNumber: true, status: true, registrationId: true },
    });
    if (!existing) return { error: `Invoice ${invoiceId} not found or access denied` };

    const { sendInvoiceEmail } = await import("@/lib/invoice-service");
    await sendInvoiceEmail(invoiceId);

    db.auditLog.create({
      data: {
        eventId: existing.eventId,
        userId: ctx.userId,
        action: "SEND",
        entityType: "Invoice",
        entityId: invoiceId,
        changes: { source: "mcp", invoiceNumber: existing.invoiceNumber },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:send_invoice audit-log-failed"));

    return { success: true, invoiceId, invoiceNumber: existing.invoiceNumber, emailed: true };
  } catch (err) {
    apiLogger.error({ err }, "agent:send_invoice failed");
    return { error: err instanceof Error ? err.message : "Failed to send invoice" };
  }
};

// Transitions the agent may set directly — parity with the dashboard's REST
// PUT (cancel / mark overdue). Everything else is minted by a money flow:
// PAID by the Stripe webhook / desk Record Payment (which also creates the
// Payment row, receipt, and email), REFUNDED by the credit-note-gated refund
// flow, SENT by the send route (which actually emails it). Setting any of
// those as a bare flag desyncs the invoice from the registration + Payment
// rows (review M6).
const AGENT_SETTABLE_INVOICE_STATUSES = new Set(["CANCELLED", "OVERDUE"]);

const updateInvoiceStatus: ToolExecutor = async (input, ctx) => {
  try {
    const invoiceId = String(input.invoiceId ?? "").trim();
    const status = String(input.status ?? "").trim();
    if (!invoiceId) return { error: "invoiceId is required" };
    if (!AGENT_SETTABLE_INVOICE_STATUSES.has(status)) {
      return {
        error: `Invalid status "${status}". This tool can set: ${[...AGENT_SETTABLE_INVOICE_STATUSES].join(", ")}. PAID is minted by the payment flows (Stripe webhook / desk Record Payment), REFUNDED by the credit-note-gated refund flow, and SENT by send_invoice — setting them as bare flags would desync the invoice from the registration and Payment rows.`,
        code: "INVOICE_STATUS_NOT_SETTABLE",
      };
    }

    const existing = await db.invoice.findFirst({
      where: { id: invoiceId, event: { organizationId: ctx.organizationId } },
      select: { id: true, eventId: true, invoiceNumber: true, status: true },
    });
    if (!existing) return { error: `Invoice ${invoiceId} not found or access denied` };

    const updated = await db.invoice.update({
      where: { id: invoiceId },
      data: { status: status as never },
      select: {
        id: true,
        invoiceNumber: true,
        status: true,
        total: true,
        currency: true,
        paidDate: true,
      },
    });

    db.auditLog.create({
      data: {
        eventId: existing.eventId,
        userId: ctx.userId,
        action: "UPDATE",
        entityType: "Invoice",
        entityId: invoiceId,
        changes: {
          source: "mcp",
          before: existing.status,
          after: status,
        },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:update_invoice_status audit-log-failed"));

    return {
      success: true,
      invoice: { ...updated, total: Number(updated.total) },
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:update_invoice_status failed");
    return { error: err instanceof Error ? err.message : "Failed to update invoice status" };
  }
};

// ─── A5: Email template editing ───────────────────────────────────────────────

export const INVOICE_TOOL_DEFINITIONS: Tool[] = [
  {
    name: "list_invoices",
    description: "List invoices, receipts, and credit notes for this event.",
    input_schema: {
      type: "object" as const,
      properties: {
        type: { type: "string", enum: ["INVOICE", "RECEIPT", "CREDIT_NOTE"] },
        status: { type: "string", enum: ["DRAFT", "SENT", "PAID", "OVERDUE", "CANCELLED", "REFUNDED"] },
        limit: { type: "number", description: "Max results (default 50, max 200)" },
      },
      required: [],
    },
  },
];

export const INVOICE_EXECUTORS: Record<string, ToolExecutor> = {
  list_invoices: listInvoices,
  create_invoice: createInvoiceExec,
  send_invoice: sendInvoiceExec,
  update_invoice_status: updateInvoiceStatus,
};
