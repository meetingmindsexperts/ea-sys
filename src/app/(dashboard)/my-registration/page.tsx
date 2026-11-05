import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { AlertCircle, Award, Calendar, MapPin, Ticket } from "lucide-react";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { normalizeHost, resolveTenantOrg } from "@/lib/tenant/resolver";
import { runWithTenantLane } from "@/lib/tenant-lane";
import { DEFAULT_EVENT_TIMEZONE, formatEventDateRange } from "@/lib/event-time";
import { certificateMeta, certificateTitle, cmeTotals, findReleasedCertificates } from "@/lib/registrant-certificates";
import { loadRegistrantScope, ownRegistrationWhere } from "@/lib/registrant-access";
import { CertificateList } from "@/components/registrant/certificate-list";
import { ConfirmEmailNotice } from "@/components/registrant/confirm-email-notice";
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

interface EventSummary {
  id: string;
  name: string;
  slug: string;
  startDate: Date;
  endDate: Date;
  timezone: string;
}

async function loadPortal(userId: string) {
  // A registrant is org-null, so the lane comes from the host, as sign-in does.
  const { orgId } = await resolveTenantOrg(normalizeHost((await headers()).get("host")));
  return runWithTenantLane(orgId, { route: "page:/my-registration", userId }, async () => {
    const scope = await loadRegistrantScope(userId);
    // A session for an account that no longer exists: back to sign-in.
    if (!scope) return null;
    const [registrations, certificates] = await Promise.all([
      db.registration.findMany({
        // Linked registrations, plus those carrying the address once the
        // account has proven it owns it (registrant-access.ts).
        where: { status: { not: "CANCELLED" }, ...ownRegistrationWhere(scope) },
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
      findReleasedCertificates(scope),
    ]);
    return { registrations, certificates, scope };
  });
}

export default async function MyRegistrationPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login?callbackUrl=/my-registration");
  }
  const userId = session.user.id;

  let portal: Awaited<ReturnType<typeof loadPortal>>;
  try {
    portal = await loadPortal(userId);
  } catch (err) {
    apiLogger.error({ err, msg: "my-registration:load-failed", userId });
    throw err;
  }
  if (!portal) {
    apiLogger.warn({ msg: "my-registration:user-not-found", userId });
    redirect("/login?callbackUrl=/my-registration");
  }
  const { registrations, certificates, scope } = portal;


  // One card per event: its registrations and its certificates. A speaker's
  // appreciation certificate can belong to an event they never registered for.
  const events = new Map<string, EventSummary>();
  for (const r of registrations) events.set(r.event.id, r.event);
  for (const c of certificates) if (!events.has(c.event.id)) events.set(c.event.id, c.event);
  const ordered = [...events.values()].sort((a, b) => b.startDate.getTime() - a.startDate.getTime());
  const cme = cmeTotals(certificates, new Date(), DEFAULT_EVENT_TIMEZONE);

  return (
    // Mobile first (owner, Nov 4, 2026): most people open this from the
    // confirmation email on a phone. Everything stacks and buttons span the
    // card by default; from `sm` up the actions sit beside their text.
    <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6 sm:space-y-6 sm:px-6 sm:py-8">
      <PageHeader
        title="My events"
        description={`Signed in as ${scope.email}`}
      />

      {/* Registrations made earlier under this address appear once it is
          confirmed. Never a count: that would tell an unproven account the
          address has history. */}
      {!scope.confirmed && <ConfirmEmailNotice email={scope.email} />}

      {cme.allTime > 0 && (
        <Card className="gap-0 py-0">
          <CardContent className="flex items-center gap-4 p-4 sm:p-5">
            <Award className="h-8 w-8 shrink-0 text-primary" />
            <div className="grid flex-1 grid-cols-2 gap-4">
              <div>
                <p className="text-2xl font-semibold tabular-nums">{cme.thisYear}</p>
                <p className="text-xs text-muted-foreground">CME hours in {cme.year}</p>
              </div>
              <div>
                <p className="text-2xl font-semibold tabular-nums">{cme.allTime}</p>
                <p className="text-xs text-muted-foreground">CME hours in total</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

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
              <CardTitle className="leading-snug">{event.name}</CardTitle>
              <div className="flex flex-col gap-1 text-xs text-muted-foreground sm:flex-row sm:flex-wrap sm:gap-x-4">
                <span className="flex items-start gap-1.5">
                  <Calendar className="mt-px h-3.5 w-3.5 shrink-0" />
                  {formatEventDateRange(event.startDate, event.endDate, event.timezone)}
                </span>
                {where && (
                  <span className="flex items-start gap-1.5">
                    <MapPin className="mt-px h-3.5 w-3.5 shrink-0" />
                    {where}
                  </span>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {regs.length > 0 && (
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <div className="flex flex-wrap gap-2">
                    {regs.map((r) => (
                      <span key={r.id} className="flex flex-wrap items-center gap-2">
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
                  </div>
                  <Button asChild className="h-11 w-full sm:ml-auto sm:h-9 sm:w-auto">
                    <Link href={`/e/${event.slug}/my-registration`}>Open registration</Link>
                  </Button>
                </div>
              )}

              {certs.length > 0 && (
                <CertificateList certificates={certs.map((c) => ({ id: c.id, title: certificateTitle(c), meta: certificateMeta(c) }))} />
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
