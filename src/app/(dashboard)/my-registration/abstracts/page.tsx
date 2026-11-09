import Link from "next/link";
import type { AbstractStatus, SessionProposalStatus } from "@prisma/client";
import { ChevronRight, FileText } from "lucide-react";
import { db } from "@/lib/db";
import { formatEventDateRange } from "@/lib/event-time";
import { formatAbstractSerial } from "@/lib/abstract-serial";
import { formatSessionProposalSerial } from "@/lib/session-proposal-serial";
import type { RegistrantScope } from "@/lib/registrant-access";
import { loadRegistrantPortal } from "@/lib/registrant-portal";
import { formatDate } from "@/lib/utils";
import { abstractStatusColor } from "@/app/(dashboard)/events/[eventId]/abstracts/abstract-enums";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/typography";

/**
 * A person's abstracts and session proposals across all their events
 * (docs/MY_PORTAL_PLAN.md, phase 4). Until now each event's were reachable
 * only from inside that event's dashboard.
 *
 * Matched by the ACCOUNT LINK only (`Speaker.userId`), never by email address
 * (owner, Nov 9, 2026, D3): an abstract is authored work under someone's name,
 * and an account that has not proven its address must not be shown work filed
 * under it. Read-only: each row opens the event's own page, where a submitter
 * edits and reads reviewer feedback.
 */

const ABSTRACT_STATUS_LABEL: Record<AbstractStatus, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  UNDER_REVIEW: "Under review",
  ACCEPTED: "Accepted",
  REJECTED: "Not accepted",
  REVISION_REQUESTED: "Revision requested",
  WITHDRAWN: "Withdrawn",
};

const PROPOSAL_STATUS_LABEL: Record<SessionProposalStatus, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  WITHDRAWN: "Withdrawn",
};

const EVENT_FIELDS = { id: true, name: true, startDate: true, endDate: true, timezone: true } as const;

async function loadSubmissions(scope: RegistrantScope) {
  const mine = { speaker: { userId: scope.userId } };
  const [abstracts, proposals] = await Promise.all([
    db.abstract.findMany({
      where: mine,
      select: { id: true, serialId: true, title: true, status: true, submittedAt: true, theme: { select: { name: true } }, event: { select: EVENT_FIELDS } },
      orderBy: { submittedAt: "desc" },
    }),
    db.sessionProposal.findMany({
      where: mine,
      select: { id: true, serialId: true, title: true, status: true, submittedAt: true, createdAt: true, event: { select: EVENT_FIELDS } },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  return { abstracts, proposals };
}

interface Row {
  key: string;
  serial: string;
  title: string;
  status: string;
  statusClass: string;
  meta: string;
  href: string;
}

export default async function MyAbstractsPage() {
  const { data, role } = await loadRegistrantPortal("/my-registration/abstracts", loadSubmissions);
  // The event's own Abstracts / Session Proposals pages are a submitter's;
  // another role would only be bounced from them, so it gets the list alone.
  const linked = role === "SUBMITTER";

  type EventInfo = (typeof data.abstracts)[number]["event"];
  const events = new Map<string, { event: EventInfo; rows: Row[] }>();
  const add = (event: EventInfo, row: Row) => {
    const group = events.get(event.id) ?? { event, rows: [] };
    events.set(event.id, group);
    group.rows.push(row);
  };
  for (const a of data.abstracts) {
    add(a.event, {
      key: `a-${a.id}`,
      serial: formatAbstractSerial(a.serialId),
      title: a.title,
      status: ABSTRACT_STATUS_LABEL[a.status],
      statusClass: abstractStatusColor(a.status),
      meta: ["Abstract", a.theme?.name, a.status !== "DRAFT" && `Submitted ${formatDate(a.submittedAt)}`].filter(Boolean).join(" · "),
      href: `/events/${a.event.id}/abstracts`,
    });
  }
  for (const p of data.proposals) {
    add(p.event, {
      key: `p-${p.id}`,
      serial: formatSessionProposalSerial(p.serialId),
      title: p.title,
      status: PROPOSAL_STATUS_LABEL[p.status],
      statusClass: p.status === "SUBMITTED" ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-700",
      meta: ["Session proposal", p.submittedAt && `Submitted ${formatDate(p.submittedAt)}`].filter(Boolean).join(" · "),
      href: `/events/${p.event.id}/session-proposals`,
    });
  }
  const groups = [...events.values()].sort((a, b) => b.event.startDate.getTime() - a.event.startDate.getTime());
  const total = data.abstracts.length + data.proposals.length;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 sm:space-y-6 sm:py-2">
      <PageHeader
        title="My abstracts"
        description={total > 0 ? `${total} submission${total === 1 ? "" : "s"} across your events` : undefined}
      />

      {groups.length === 0 && (
        <Card>
          <CardContent className="space-y-2 py-10 text-center">
            <FileText className="mx-auto h-10 w-10 text-muted-foreground/40" aria-hidden />
            <p className="font-medium">No submissions yet</p>
            <p className="text-sm text-muted-foreground">
              Abstracts and session proposals you submit to an event will show here.
            </p>
          </CardContent>
        </Card>
      )}

      {groups.map(({ event, rows }) => (
        <Card key={event.id} className="gap-3">
          <CardHeader className="space-y-1">
            <CardTitle className="leading-snug">{event.name}</CardTitle>
            <p className="text-xs text-muted-foreground">{formatEventDateRange(event.startDate, event.endDate, event.timezone)}</p>
          </CardHeader>
          <CardContent>
            <ul className="divide-y rounded-md border">
              {rows.map((row) => {
                const body = (
                  <>
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="text-sm font-medium">
                        <span className="mr-2 font-mono text-xs text-muted-foreground">{row.serial}</span>
                        {row.title}
                      </p>
                      <p className="text-xs text-muted-foreground">{row.meta}</p>
                    </div>
                    <Badge variant="outline" className={`shrink-0 self-start border-transparent sm:self-auto ${row.statusClass}`}>
                      {row.status}
                    </Badge>
                    {linked && <ChevronRight className="hidden h-4 w-4 shrink-0 text-muted-foreground sm:block" aria-hidden />}
                  </>
                );
                const layout = "flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:gap-3";
                return (
                  <li key={row.key}>
                    {linked ? (
                      <Link href={row.href} className={`${layout} transition-colors hover:bg-muted/50`}>
                        {body}
                      </Link>
                    ) : (
                      <div className={layout}>{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
