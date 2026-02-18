import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect, notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { ArrowLeft, Building2, Mail, Phone, Briefcase, Calendar, Mic, Users } from "lucide-react";
import Link from "next/link";

const TAG_COLORS = [
  "bg-blue-100 text-blue-800",
  "bg-green-100 text-green-800",
  "bg-purple-100 text-purple-800",
  "bg-amber-100 text-amber-800",
  "bg-rose-100 text-rose-800",
  "bg-cyan-100 text-cyan-800",
];

function getTagColor(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = (hash * 31 + tag.charCodeAt(i)) % TAG_COLORS.length;
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ contactId: string }>;
}) {
  const [{ contactId }, session] = await Promise.all([params, auth()]);

  if (!session?.user) redirect("/login");

  const contact = await db.contact.findFirst({
    where: { id: contactId, organizationId: session.user.organizationId! },
  });

  if (!contact) notFound();

  // Derive event history
  const [speakers, registrations] = await Promise.all([
    db.speaker.findMany({
      where: {
        email: contact.email,
        event: { organizationId: session.user.organizationId! },
      },
      select: {
        id: true,
        status: true,
        createdAt: true,
        event: { select: { id: true, name: true, startDate: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    db.registration.findMany({
      where: {
        attendee: { email: contact.email },
        event: { organizationId: session.user.organizationId! },
      },
      select: {
        id: true,
        status: true,
        createdAt: true,
        event: { select: { id: true, name: true, startDate: true } },
        ticketType: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const eventHistory = [
    ...speakers.map((s) => ({
      eventId: s.event.id,
      eventName: s.event.name,
      eventDate: s.event.startDate,
      role: "Speaker" as const,
      status: s.status,
      createdAt: s.createdAt,
    })),
    ...registrations.map((r) => ({
      eventId: r.event.id,
      eventName: r.event.name,
      eventDate: r.event.startDate,
      role: "Attendee" as const,
      status: r.status,
      createdAt: r.createdAt,
    })),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/contacts" className="text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-2xl font-bold">
          {contact.firstName} {contact.lastName}
        </h1>
      </div>

      {/* Contact info card */}
      <div className="rounded-lg border bg-card p-6 space-y-4">
        <h2 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">Contact Details</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="flex items-center gap-2 text-sm">
            <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
            <a href={`mailto:${contact.email}`} className="text-primary hover:underline">{contact.email}</a>
          </div>
          {contact.phone && (
            <div className="flex items-center gap-2 text-sm">
              <Phone className="h-4 w-4 text-muted-foreground shrink-0" />
              <span>{contact.phone}</span>
            </div>
          )}
          {contact.organization && (
            <div className="flex items-center gap-2 text-sm">
              <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
              <span>{contact.organization}</span>
            </div>
          )}
          {contact.jobTitle && (
            <div className="flex items-center gap-2 text-sm">
              <Briefcase className="h-4 w-4 text-muted-foreground shrink-0" />
              <span>{contact.jobTitle}</span>
            </div>
          )}
          <div className="flex items-center gap-2 text-sm">
            <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground">Added {formatDate(contact.createdAt.toISOString())}</span>
          </div>
        </div>
        {contact.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {contact.tags.map((tag) => (
              <span key={tag} className={`text-xs px-2.5 py-1 rounded-full font-medium ${getTagColor(tag)}`}>
                {tag}
              </span>
            ))}
          </div>
        )}
        {contact.notes && (
          <div className="text-sm text-muted-foreground border-t pt-3">
            {contact.notes}
          </div>
        )}
      </div>

      {/* Event history */}
      <div className="rounded-lg border bg-card overflow-hidden">
        <div className="px-6 py-4 border-b">
          <h2 className="font-semibold">Event History</h2>
          <p className="text-sm text-muted-foreground">{eventHistory.length} appearance{eventHistory.length !== 1 ? "s" : ""}</p>
        </div>
        {eventHistory.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-muted-foreground">
            This contact hasn&apos;t been imported into any events yet.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-6 py-3 font-medium">Event</th>
                <th className="text-left px-6 py-3 font-medium">Role</th>
                <th className="text-left px-6 py-3 font-medium">Status</th>
                <th className="text-left px-6 py-3 font-medium">Event Date</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {eventHistory.map((item, i) => (
                <tr key={i} className="hover:bg-muted/30 transition-colors">
                  <td className="px-6 py-3">
                    <Link
                      href={`/events/${item.eventId}`}
                      className="font-medium hover:text-primary hover:underline"
                    >
                      {item.eventName}
                    </Link>
                  </td>
                  <td className="px-6 py-3">
                    <div className="flex items-center gap-1.5">
                      {item.role === "Speaker" ? (
                        <Mic className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : (
                        <Users className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      {item.role}
                    </div>
                  </td>
                  <td className="px-6 py-3">
                    <Badge variant="outline" className="text-xs capitalize">
                      {item.status.toLowerCase().replace("_", " ")}
                    </Badge>
                  </td>
                  <td className="px-6 py-3 text-muted-foreground">
                    {formatDate(item.eventDate.toISOString())}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
