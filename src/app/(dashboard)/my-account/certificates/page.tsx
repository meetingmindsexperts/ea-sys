import Link from "next/link";
import { Award } from "lucide-react";
import { DEFAULT_EVENT_TIMEZONE } from "@/lib/event-time";
import {
  certificateMeta,
  certificateTitle,
  cmeTotals,
  findReleasedCertificates,
  groupCertificatesByYear,
} from "@/lib/registrant-certificates";
import { loadRegistrantPortal } from "@/lib/registrant-portal";
import { CertificateList } from "@/components/registrant/certificate-list";
import { CmeTotalsCard } from "@/components/registrant/cme-totals-card";
import { ConfirmEmailNotice } from "@/components/registrant/confirm-email-notice";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader, SectionHeading } from "@/components/ui/typography";

/**
 * Every certificate a person has been sent, across all their events
 * (docs/MY_PORTAL_PLAN.md, phase 1). Until now they were findable only inside
 * each event's card on My events, so three certificates for a June meeting sat
 * under the sixth card down.
 *
 * The same `findReleasedCertificates` as My events and the download route, so
 * this page can never list a certificate the download would refuse.
 */
export default async function MyCertificatesPage() {
  const { scope, data: certificates } = await loadRegistrantPortal("/my-account/certificates", findReleasedCertificates);
  const cme = cmeTotals(certificates, new Date(), DEFAULT_EVENT_TIMEZONE);
  const years = groupCertificatesByYear(certificates);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 sm:space-y-6 sm:py-2">
      <PageHeader
        title="My certificates"
        description={certificates.length > 0 ? `${certificates.length} certificate${certificates.length === 1 ? "" : "s"} from your events` : undefined}
      />

      {!scope.confirmed && <ConfirmEmailNotice email={scope.email} />}

      {cme.allTime > 0 && <CmeTotalsCard {...cme} />}

      {years.length === 0 && (
        <Card>
          <CardContent className="space-y-2 py-10 text-center">
            <Award className="mx-auto h-10 w-10 text-muted-foreground/40" aria-hidden />
            <p className="font-medium">No certificates yet</p>
            <p className="text-sm text-muted-foreground">
              The organiser sends certificates after an event, often once you have answered its survey. They will show here.
            </p>
            <p className="text-sm">
              <Link href="/my-account" className="font-medium text-primary hover:underline">
                See your events
              </Link>
            </p>
          </CardContent>
        </Card>
      )}

      {years.map(({ year, events }) => (
        <section key={year} className="space-y-3">
          <SectionHeading title={year} />
          {events.map(({ event, certificates: certs }) => (
            // The anchor My events' "N certificates" link lands on.
            <Card key={event.id} id={`event-${event.id}`} className="scroll-mt-20 gap-3">
              <CardHeader>
                <CardTitle className="leading-snug">{event.name}</CardTitle>
              </CardHeader>
              <CardContent>
                <CertificateList certificates={certs.map((c) => ({ id: c.id, title: certificateTitle(c), meta: certificateMeta(c) }))} />
              </CardContent>
            </Card>
          ))}
        </section>
      ))}
    </div>
  );
}
