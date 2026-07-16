import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getOrgContext } from "@/lib/api-auth";
import { denyContactAccess, denyContactExport } from "@/lib/contact-visibility";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { escapeCsvCell as escapeCSV } from "@/lib/csv-escape";

/**
 * Full-CRM CSV export — the highest-value object in the contact domain: every
 * contact's email, phone, bio and the organizer's private notes, in one file.
 *
 * Hardened July 14, 2026 (contacts review H1): it previously authorized on
 * `getOrgContext` alone, so any org-bound account — including an ONSITE desk
 * temp hired for a single event, or an internal-domain REGISTRANT — could pull
 * the entire organization's contact book, with no role gate, no audit trail and
 * no rate limit. Now: staff + MEMBER only, audited, and rate-limited.
 */
export async function GET(req: Request) {
  try {
    const ctx = await getOrgContext(req);

    if (!ctx) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }

    const denied = denyContactAccess(ctx);
    if (denied) return denied;

    // Export is a narrower boundary than read: CRM_USER may search/read the
    // store (to link a rep to a registration) but may NOT pull the whole org
    // book as a file (owner decision, July 16, 2026).
    const exportDenied = denyContactExport(ctx);
    if (exportDenied) return exportDenied;

    // A bulk PII export deserves its own budget, separate from the read routes.
    const limit = checkRateLimit({
      key: `contacts-export:org:${ctx.organizationId}`,
      limit: 10,
      windowMs: 60 * 60 * 1000, // 10 full-CRM exports per hour per org
    });
    if (!limit.allowed) {
      apiLogger.warn({
        msg: "contacts-export:rate-limited",
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        retryAfterSeconds: limit.retryAfterSeconds,
      });
      return new Response(
        JSON.stringify({ error: "Export limit reached. Maximum 10 per hour." }),
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
      );
    }

    const contacts = await db.contact.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { createdAt: "desc" },
      select: {
        title: true,
        firstName: true,
        lastName: true,
        email: true,
        organization: true,
        jobTitle: true,
        specialty: true,
        registrationType: true,
        bio: true,
        phone: true,
        tags: true,
        notes: true,
      },
    });

    const headers = ["title", "firstName", "lastName", "email", "organization", "jobTitle", "specialty", "registrationType", "bio", "phone", "tags", "notes"];
    const rows = contacts.map((c) => [
      escapeCSV(c.title),
      escapeCSV(c.firstName),
      escapeCSV(c.lastName),
      escapeCSV(c.email),
      escapeCSV(c.organization),
      escapeCSV(c.jobTitle),
      escapeCSV(c.specialty),
      escapeCSV(c.registrationType),
      escapeCSV(c.bio),
      escapeCSV(c.phone),
      escapeCSV(c.tags.join(",")),
      escapeCSV(c.notes),
    ]);

    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");

    // Who pulled the whole contact book, when, and how much of it. Fire-and-
    // forget: an audit-write blip must not fail a completed export, but it is
    // logged so the gap is visible.
    db.auditLog
      .create({
        data: {
          userId: ctx.userId ?? null,
          action: "EXPORT",
          entityType: "Contact",
          // No single contact is the subject — the org's whole book is.
          entityId: `org:${ctx.organizationId}`,
          changes: {
            source: ctx.fromApiKey ? "api" : "rest",
            rowCount: contacts.length,
            role: ctx.role,
            ip: getClientIp(req),
          },
        },
      })
      .catch((err) =>
        apiLogger.error({ err, msg: "contacts-export:audit-failed", organizationId: ctx.organizationId }),
      );

    apiLogger.info({
      msg: "contacts-export:completed",
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      role: ctx.role,
      rowCount: contacts.length,
    });

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="contacts-${Date.now()}.csv"`,
      },
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error exporting contacts" });
    return new Response(JSON.stringify({ error: "Failed to export contacts" }), { status: 500 });
  }
}
