import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getOrgContext } from "@/lib/api-auth";

function escapeCSV(value: string | null | undefined): string {
  const str = value ?? "";
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export async function GET(req: Request) {
  try {
    const ctx = await getOrgContext(req);

    if (!ctx) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
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
        phone: true,
        tags: true,
        notes: true,
      },
    });

    const headers = ["title", "firstName", "lastName", "email", "organization", "jobTitle", "specialty", "registrationType", "phone", "tags", "notes"];
    const rows = contacts.map((c) => [
      escapeCSV(c.title),
      escapeCSV(c.firstName),
      escapeCSV(c.lastName),
      escapeCSV(c.email),
      escapeCSV(c.organization),
      escapeCSV(c.jobTitle),
      escapeCSV(c.specialty),
      escapeCSV(c.registrationType),
      escapeCSV(c.phone),
      escapeCSV(c.tags.join(",")),
      escapeCSV(c.notes),
    ]);

    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");

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
