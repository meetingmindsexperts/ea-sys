"use client";

/**
 * Conference Launch Readiness — organizer-facing pre-launch checklist, scoped
 * under an event so it's reached from that event's Overview (no sidebar item).
 * Read-only reference; distilled from the June/July 2026 end-to-end launch audit
 * (paid registration + abstracts). Visible to any team role that can open the event.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Rocket,
  CreditCard,
  FileText,
  Mail,
  CalendarCheck,
  ScanBarcode,
  CheckCircle2,
  AlertTriangle,
  Info,
  ArrowLeft,
} from "lucide-react";

function Check({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
      <span>{children}</span>
    </li>
  );
}

function Warn({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Icon className="h-5 w-5 text-primary" />
          {title}
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">{children}</CardContent>
    </Card>
  );
}

export default function EventReadinessPage() {
  const params = useParams<{ eventId: string }>();
  const eventId = params?.eventId;
  const { data: session } = useSession();
  const isViewer = session?.user?.role === "MEMBER";

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 md:p-6">
      {eventId && (
        <Link
          href={`/events/${eventId}`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Back to event
        </Link>
      )}

      {/* Header */}
      <div className="rounded-xl bg-gradient-primary p-6 text-white">
        <div className="flex items-center gap-3">
          <Rocket className="h-7 w-7" />
          <div>
            <h1 className="text-2xl font-bold">Conference Launch Readiness</h1>
            <p className="text-sm text-white/85">
              Run this checklist before opening a paid conference (with or without abstracts) to the public.
            </p>
          </div>
        </div>
      </div>

      {isViewer && (
        <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            You&rsquo;re viewing as a <strong>Member</strong> (read-only). This is a reference — an
            Organizer or Admin makes the changes below.
          </span>
        </div>
      )}

      {/* The critical path banner */}
      <Warn>
        <span>
          <strong>The one non-negotiable:</strong> before you open registration, do <strong>one real test
          registration + a small live payment</strong> and confirm it flips to <em>Paid</em>, sends the
          payment confirmation + invoice, and issues the badge. If you accept abstracts, submit <strong>one
          test abstract</strong> and confirm a reviewer can score it. That single dry-run catches almost
          everything.
        </span>
      </Warn>

      {/* 1. Event basics */}
      <Section
        icon={CalendarCheck}
        title="1 · Set up the event"
        description="The basics that everything else hangs off."
      >
        <ul className="space-y-2">
          <Check>Create the event as a <strong>Conference</strong> (not Webinar — the emails differ). Set dates and venue.</Check>
          <Check><strong>Timezone</strong> — set it deliberately (defaults to Asia/Dubai). It drives sales windows and session times.</Check>
          <Check>Publish the event (status Published or Live) — a Draft event rejects public registrations and abstract submissions.</Check>
          <Check>Keep <strong>&ldquo;Registration Open&rdquo; OFF</strong> in Settings &rarr; Registration until you&rsquo;re ready to launch — it defaults to open once tiers are active.</Check>
        </ul>
      </Section>

      {/* 2. Money & tickets */}
      <Section
        icon={CreditCard}
        title="2 · Money &amp; tickets"
        description="What makes paid registration actually collect money."
      >
        <ul className="space-y-2">
          <Check>Create <strong>Registration Types</strong> with real prices (a $0 price silently becomes &ldquo;complimentary&rdquo; — no payment).</Check>
          <Check>Set up <strong>Pricing Tiers</strong> (Early Bird / Standard / Onsite) with correct sales-start/end windows <em>in the event timezone</em>.</Check>
          <Check>Set <strong>Tax</strong> (rate + label, e.g. VAT) and <strong>Bank Details</strong> (printed on the quote for pay-by-transfer).</Check>
          <Check>Confirm the currency on each ticket type.</Check>
        </ul>
        <Warn>
          <span>
            <strong>Admin/engineering item:</strong> confirm Stripe is in <strong>LIVE mode</strong>
            {" "}(<code>sk_live_…</code> keys) and the live webhook is registered at{" "}
            <code>/api/webhooks/stripe</code>. In test mode, real cards can&rsquo;t pay. Ask your admin to
            verify before launch.
          </span>
        </Warn>
      </Section>

      {/* 3. Email */}
      <Section
        icon={Mail}
        title="3 · Email &amp; branding"
        description="So confirmations, quotes and invoices actually arrive."
      >
        <ul className="space-y-2">
          <Check>Set the event&rsquo;s <strong>sender address</strong> (Settings &rarr; Email Branding) to a verified <code>@meetingmindsexperts.com</code> address — an unverified sender means emails silently fail.</Check>
          <Check>Add the <strong>email header/footer branding</strong>.</Check>
          <Check>Make sure the <strong>organization company details</strong> are filled in — the quote PDF only attaches when they are.</Check>
        </ul>
      </Section>

      {/* 4. Content & terms */}
      <Section icon={FileText} title="4 · Content &amp; terms">
        <ul className="space-y-2">
          <Check>Write the <strong>registration welcome</strong> text and the <strong>Terms &amp; Conditions</strong> (registrants must accept them).</Check>
          <Check>Review the confirmation email copy.</Check>
        </ul>
      </Section>

      {/* 5. Abstracts */}
      <Section
        icon={FileText}
        title="5 · Abstracts (only if you accept submissions)"
        description="Skip this whole section if your conference has no abstracts."
      >
        <ul className="space-y-2">
          <Check>Turn <strong>&ldquo;Allow Abstract Submissions&rdquo; ON</strong> — it defaults OFF, and until it&rsquo;s on, authors see &ldquo;submissions are not open.&rdquo;</Check>
          <Check>Set the <strong>submission deadline</strong> (optional) and the <strong>abstract welcome</strong> text.</Check>
          <Check>Create <strong>abstract themes</strong> and <strong>review criteria</strong> (weights) before reviewers start scoring.</Check>
          <Check>Invite <strong>reviewers</strong> into the pool (Reviewers page) and optionally assign per-abstract with a role / conflict-of-interest flag.</Check>
          <Check>Choose how many reviews an abstract needs before it can be accepted/rejected (<strong>required review count</strong>, default 1).</Check>
          <Check>Share the <strong>Abstract Submission link</strong> — the copyable card at the top of the Abstracts page.</Check>
        </ul>
      </Section>

      {/* 6. Prove it */}
      <Section
        icon={CheckCircle2}
        title="6 · Prove it (dry run before going public)"
        description="Ten minutes here saves a launch-day fire."
      >
        <ul className="space-y-2">
          <Check><strong>Test registration + live payment</strong> (a small real amount): confirm it shows <em>Paid</em>, you receive the payment-confirmation email + invoice PDF, and a badge/barcode is issued.</Check>
          <Check><strong>Test pay-later</strong>: register without paying, confirm the quote email arrives, then use <strong>&ldquo;Pay Now&rdquo;</strong> in the attendee&rsquo;s <em>My Registration</em> portal.</Check>
          <Check><strong>Test abstract</strong> (if applicable): submit one, confirm it appears and a reviewer can open + score it.</Check>
        </ul>
      </Section>

      {/* 7. Go live */}
      <Section icon={Rocket} title="7 · Go live">
        <ul className="space-y-2">
          <Check>Flip <strong>&ldquo;Registration Open&rdquo; ON</strong>.</Check>
          <Check>Share the public link <code>/e/&lt;your-event-slug&gt;</code>.</Check>
          <Check>Watch the first few real registrations come through and confirm payments settle.</Check>
        </ul>
      </Section>

      {/* 8. Onsite */}
      <Section
        icon={ScanBarcode}
        title="8 · On-site preparation"
        description="Desk, badges, check-in."
      >
        <ul className="space-y-2">
          <Check>Invite <strong>Onsite Staff</strong> accounts (Settings &rarr; Users) for the registration desk — they can add walk-ins, check people in, and print badges (money is hidden from them).</Check>
          <Check>If in Dubai, turn on <strong>DTCM barcode</strong> and import the barcodes 1&ndash;2 days before.</Check>
          <Check>Test the <strong>check-in scanner</strong> (camera or USB scanner) and <strong>badge printing</strong> (one badge per print).</Check>
          <Check>Ensure the desk has a <strong>reliable wired/stable internet</strong> connection — every scan is a live action.</Check>
        </ul>
      </Section>

      {/* 9. During the event */}
      <Section icon={AlertTriangle} title="9 · During the event — day-of rules">
        <ul className="space-y-2">
          <Check><strong>Don&rsquo;t deploy / change settings mid-event</strong> unless necessary.</Check>
          <Check>The registration <strong>desk and check-in are unthrottled</strong> — staff can work as fast as they need.</Check>
          <Check>Attendees who owe money can pay anytime via their <em>My Registration</em> portal; staff can also record cash/bank/card payments from the registration&rsquo;s Billing tab.</Check>
        </ul>
      </Section>

      {/* Payment states cheat sheet */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Info className="h-5 w-5 text-primary" />
            Payment status cheat-sheet
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 font-medium">Meaning</th>
                </tr>
              </thead>
              <tbody className="[&_td]:py-2 [&_td]:pr-4 [&_tr]:border-b">
                <tr><td><strong>Unpaid</strong></td><td>Registered online, owes money via Stripe (can Pay Now in the portal).</td></tr>
                <tr><td><strong>Pending</strong></td><td>Stripe checkout is mid-flight; auto-resolves to Paid on success or back to Unpaid if abandoned.</td></tr>
                <tr><td><strong>Paid</strong></td><td>Money collected (Stripe or recorded offline). Invoice issued.</td></tr>
                <tr><td><strong>Unassigned</strong></td><td>Admin-created, payment intentionally pending / to be invoiced.</td></tr>
                <tr><td><strong>Complimentary</strong></td><td>No money due (VIP / free / staff).</td></tr>
                <tr><td><strong>Inclusive</strong></td><td>Covered by a sponsor out-of-band.</td></tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <p className="pb-4 text-center text-xs text-muted-foreground">
        Questions? Use the Help Assistant (bottom of the sidebar) or contact your system admin.
      </p>
    </div>
  );
}
