import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

function escapeCSV(value: string | null | undefined): string {
  const str = value ?? "";
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export async function GET() {
  try {
    const session = await auth();

    if (!session?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }

    const contacts = await db.contact.findMany({
      where: { organizationId: session.user.organizationId! },
      orderBy: { createdAt: "desc" },
      select: {
        firstName: true,
        lastName: true,
        email: true,
        company: true,
        jobTitle: true,
        phone: true,
        tags: true,
        notes: true,
      },
    });

    const headers = ["firstName", "lastName", "email", "company", "jobTitle", "phone", "tags", "notes"];
    const rows = contacts.map((c) => [
      escapeCSV(c.firstName),
      escapeCSV(c.lastName),
      escapeCSV(c.email),
      escapeCSV(c.company),
      escapeCSV(c.jobTitle),
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
