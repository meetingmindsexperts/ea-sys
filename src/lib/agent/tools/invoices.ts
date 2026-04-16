import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { Prisma } from "@prisma/client";
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

const INVOICE_STATUSES = new Set(["DRAFT", "SENT", "PAID", "OVERDUE", "CANCELLED", "REFUNDED"]);

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

const updateInvoiceStatus: ToolExecutor = async (input, ctx) => {
  try {
    const invoiceId = String(input.invoiceId ?? "").trim();
    const status = String(input.status ?? "").trim();
    if (!invoiceId) return { error: "invoiceId is required" };
    if (!INVOICE_STATUSES.has(status)) {
      return { error: `Invalid status. Must be one of: ${[...INVOICE_STATUSES].join(", ")}` };
    }

    const existing = await db.invoice.findFirst({
      where: { id: invoiceId, event: { organizationId: ctx.organizationId } },
      select: { id: true, eventId: true, invoiceNumber: true, status: true },
    });
    if (!existing) return { error: `Invoice ${invoiceId} not found or access denied` };

    const data: Prisma.InvoiceUpdateInput = { status: status as never };
    if (status === "PAID") data.paidDate = new Date();

    const updated = await db.invoice.update({
      where: { id: invoiceId },
      data,
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
          note: status === "REFUNDED" ? "DB flag only — Stripe refund not triggered" : undefined,
        },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:update_invoice_status audit-log-failed"));

    return {
      success: true,
      invoice: { ...updated, total: Number(updated.total) },
      ...(status === "REFUNDED" && {
        note: "Invoice marked REFUNDED in DB. This does NOT trigger a Stripe refund — use the dashboard for actual money movement.",
      }),
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
