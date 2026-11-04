import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { AlertCircle, Award, Calendar, Download, MapPin, Ticket } from "lucide-react";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { normalizeHost, resolveTenantOrg } from "@/lib/tenant/resolver";
import { runWithTenantLane } from "@/lib/tenant-lane";
import { formatEventDateRange } from "@/lib/event-time";
import { formatDate } from "@/lib/utils";
import { cmeHoursOf, findReleasedCertificates } from "@/lib/registrant-certificates";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/typography";

/**
 * Every event a person is registered for, and the certificates they have been
 * sent (Nov 4, 2026).
 *
 * A LIST, NOT A SECOND PORTAL. Until April 21 this route rendered a full
 * cross-event registration page, which was removed so that a registration is
 * viewed, edited and paid for on its own event's page (`322b421e`). That still
 * holds: each card links to /e/{slug}/my-registration and nothing here edits.
 * What the redirect that replaced it lost was the way BETWEEN events: it sent
 * everyone to their latest registration, so someone registered for three had
 * no route to the other two.
 *
 * It is always the list, even of one (owner, Nov 4, 2026): it is the page the
 * event pages' "All my events" link names, so it must not bounce a person
 * with one registration back to where they came from.
 */

const statusColors: Record<string, string> = {
  PENDING: "bg-yellow-100 text-yellow-800",
  CONFIRMED: "bg-green-100 text-green-800",
  WAITLISTED: "bg-blue-100 text-blue-800",
  CHECKED_IN: "bg-purple-100 text-purple-800",
};

const CERT_TYPE_LABEL: Record<string, string> = {
  ATTENDANCE: "Certificate of attendance",
  APPRECIATION: "Certificate of appreciation",
};

interface EventSummary {
  id: string;
  name: string;
  slug: string;
  startDate: Date;
  endDate: Date;
  timezone: string;
}

async function loadPortal(userId: string, email: string) {
  // A registrant is org-null, so the lane comes from the host, as sign-in does.
  const { orgId } = await resolveTenantOrg(normalizeHost((await headers()).get("host")));
  return runWithTenantLane(orgId, { route: "page:/my-registration", userId }, () =>
    Promise.all([
      db.registration.findMany({
        // A blank email matches nothing, rather than every row with no email.
        where: { status: { not: "CANCELLED" }, OR: [{ userId }, ...(email ? [{ attendee: { email } }] : [])] },
        select: {
          id: true,
          status: true,
          ticketType: { select: { name: true } },
          event: {
            select: { id: true, name: true, slug: true, startDate: true, endDate: true, timezone: true, venue: true, city: true, country: true },
          },
        },
        orderBy: { createdAt: "desc" },
      }),
      findReleasedCertificates(userId, email),
    ]),
  );
}

export default async function MyRegistrationPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login?callbackUrl=/my-registration");
  }
  const userId = session.user.id;
  const email = session.user.email?.toLowerCase() ?? "";

  let registrations: Awaited<ReturnType<typeof loadPortal>>[0];
  let certificates: Awaited<ReturnType<typeof loadPortal>>[1];
  try {
    [registrations, certificates] = await loadPortal(userId, email);
  } catch (err) {
    apiLogger.error({ err, msg: "my-registration:load-failed", userId });
    throw err;
  }


  // One card per event: its registrations and its certificates. A speaker's
  // appreciation certificate can belong to an event they never registered for.
  const events = new Map<string, EventSummary>();
  for (const r of registrations) events.set(r.event.id, r.event);
  for (const c of certificates) if (!events.has(c.event.id)) events.set(c.event.id, c.event);
  const ordered = [...events.values()].sort((a, b) => b.startDate.getTime() - a.startDate.getTime());

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8 sm:px-6">
      <PageHeader
        title="My events"
        description={email ? `Everything registered to ${email}` : "Your registrations and certificates"}
      />

      {ordered.length === 0 && (
        <Card>
          <CardContent className="space-y-2 py-10 text-center">
            <AlertCircle className="mx-auto h-10 w-10 text-muted-foreground/40" />
            <p className="font-medium">No registrations yet</p>
            <p className="text-sm text-muted-foreground">
              Use the event link from the organiser to register. It will show here once you have.
            </p>
          </CardContent>
        </Card>
      )}

      {ordered.map((event) => {
        const regs = registrations.filter((r) => r.event.id === event.id);
        const certs = certificates.filter((c) => c.event.id === event.id);
        const where = regs[0] ? [regs[0].event.venue, regs[0].event.city, regs[0].event.country].filter(Boolean).join(", ") : "";
        return (
          <Card key={event.id}>
            <CardHeader className="space-y-2">
              <CardTitle>{event.name}</CardTitle>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5" />
                  {formatEventDateRange(event.startDate, event.endDate, event.timezone)}
                </span>
                {where && (
                  <span className="flex items-center gap-1.5">
                    <MapPin className="h-3.5 w-3.5" />
                    {where}
                  </span>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {regs.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  {regs.map((r) => (
                    <span key={r.id} className="flex items-center gap-2">
                      <Badge variant="outline" className={statusColors[r.status]}>
                        {r.status.replace("_", " ")}
                      </Badge>
                      {r.ticketType?.name && (
                        <Badge variant="outline">
                          <Ticket className="mr-1 h-3 w-3" />
                          {r.ticketType.name}
                        </Badge>
                      )}
                    </span>
                  ))}
                  <Button asChild size="sm" className="ml-auto">
                    <Link href={`/e/${event.slug}/my-registration`}>Open registration</Link>
                  </Button>
                </div>
              )}

              {certs.length > 0 && (
                <ul className="divide-y rounded-md border">
                  {certs.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center gap-3 p-3">
                      <Award className="h-5 w-5 shrink-0 text-primary" />
                      {/* A floor on the text's width, so on a phone the button
                          wraps below it rather than squeezing it to a column. */}
                      <div className="min-w-[12rem] flex-1">
                        <p className="text-sm font-medium">
                          {c.certificateTemplate?.role ?? CERT_TYPE_LABEL[c.type] ?? "Certificate"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {[
                            cmeHoursOf(c) && `${cmeHoursOf(c)} CME hours`,
                            `No. ${c.serial}`,
                            `Issued ${formatDate(c.issuedAt)}`,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      </div>
                      <Button asChild size="sm" variant="outline">
                        {/* A plain link: the route answers with the PDF as an attachment. */}
                        <a href={`/api/registrant/certificates/${c.id}/download`}>
                          <Download className="mr-1.5 h-4 w-4" />
                          Download
                        </a>
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
