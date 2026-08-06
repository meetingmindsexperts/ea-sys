"use client";

/**
 * My Group — the coordinator's portal (group registration Phase 3).
 *
 * Reached by the person who registered the company's attendees. Ownership is
 * enforced server-side on `coordinatorUserId`; this page only renders what
 * `/api/registrant/my-group` returns for the signed-in user, filtered to the
 * event in the URL (a group belongs to exactly one event).
 *
 * Member barcodes are deliberately NOT shown — each attendee already has
 * theirs by email, and a badge is a door credential, so the coordinator sees
 * only whether one has been issued.
 */

import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { AddGroupMembersDialog, type AddGroupMembersResultShape } from "@/components/public/add-group-members-dialog";
import { useSession, signOut } from "next-auth/react";
import { format } from "date-fns";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import { EventBanner } from "@/components/public/event-banner";
import { formatPersonName, formatCurrency } from "@/lib/utils";
import { formatSerialId } from "@/lib/registration-serial";
import {
  Calendar, MapPin, Users, Building2, CreditCard, Download, Loader2,
  CheckCircle2, AlertCircle, LogOut, BadgeCheck, HelpCircle, Plus,
} from "lucide-react";

/**
 * A label with a supplementary explanation on hover.
 *
 * Deliberately supplementary only: tooltips don't exist on touch devices, so
 * nothing a coordinator NEEDS in order to act is hidden behind one — those
 * stay as visible text.
 */
function Hint({ children, text }: { children: React.ReactNode; text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-help items-center gap-1">
          {children}
          <HelpCircle className="h-3.5 w-3.5 opacity-50" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs bg-popover text-popover-foreground border shadow-md">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

interface GroupMember {
  registrationId: string;
  serialId: number | null;
  status: string;
  paymentStatus: string;
  checkedIn: boolean;
  badgeIssued: boolean;
  price: number;
  ticketTypeName: string | null;
  tierName: string | null;
  title: string | null;
  firstName: string;
  lastName: string;
  email: string;
  organization: string | null;
  jobTitle: string | null;
}
interface GroupInvoice {
  id: string;
  invoiceNumber: string;
  status: string;
  issueDate: string;
  dueDate: string | null;
  paidDate: string | null;
  total: number;
  currency: string;
}
interface MyGroup {
  id: string;
  coordinatorName: string;
  coordinatorAttending: boolean;
  payerReference: string | null;
  payer: { name: string; contactName: string | null; email: string | null };
  event: {
    id: string; name: string; slug: string; startDate: string; endDate: string | null;
    venue: string | null; city: string | null; taxRate: number | null; taxLabel: string | null;
    bannerImage: string | null; bannerImageMobile: string | null;
    organizationName: string | null; primaryColor: string | null;
  };
  groupSettings: { minMembers: number; maxMembers: number };
  members: GroupMember[];
  memberCount: number;
  cancelledCount: number;
  currency: string;
  subtotal: number;
  amountDue: number;
  isPaid: boolean;
  invoices: GroupInvoice[];
}

export default function MyGroupPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;
  const router = useRouter();
  const { status: sessionStatus } = useSession();
  const [paying, setPaying] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addNotice, setAddNotice] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery<{ groups: MyGroup[] }>({
    queryKey: ["my-group", slug],
    queryFn: async () => {
      const res = await fetch("/api/registrant/my-group");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: sessionStatus === "authenticated",
  });

  // A group belongs to one event; match on slug (and tolerate an id in the URL).
  const group = useMemo(
    () => data?.groups.find((g) => g.event.slug === slug || g.event.id === slug) ?? null,
    [data, slug],
  );

  const payByCard = async () => {
    if (!group) return;
    setPaying(true);
    try {
      const res = await fetch(`/api/public/events/${group.event.slug}/group-checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId: group.id }),
      });
      const body = await res.json();
      if (!res.ok || !body.checkoutUrl) {
        console.error("my-group: checkout failed", body);
        toast.error(body.error || "We couldn't start the card payment. You can still pay by bank transfer using the invoice.");
        return;
      }
      window.location.href = body.checkoutUrl;
    } catch (err) {
      console.error("my-group: checkout error", err);
      toast.error("We couldn't reach the payment page. Your invoice is still valid — please try again.");
    } finally {
      setPaying(false);
    }
  };

  if (sessionStatus === "loading" || isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (sessionStatus === "unauthenticated") {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="rounded-xl border bg-white p-8 text-center max-w-md">
          <h1 className="text-xl font-semibold mb-2">Sign in to view your group</h1>
          <p className="text-slate-600 mb-5">
            Use the email address you registered the group with.
          </p>
          <Button onClick={() => router.push(`/e/${slug}/login?redirect=${encodeURIComponent(`/e/${slug}/my-group`)}`)}>
            Sign in
          </Button>
        </div>
      </div>
    );
  }

  // Never let a failed fetch masquerade as "you have no group" — the
  // coordinator would think their whole company's registration vanished.
  if (isError) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="rounded-xl border border-red-200 bg-red-50 p-8 text-center max-w-md">
          <AlertCircle className="mx-auto h-10 w-10 text-red-500 mb-3" />
          <h1 className="text-xl font-semibold mb-2">Couldn&apos;t load your group</h1>
          <p className="text-slate-600 mb-5">
            Your group registration is safe — this is a loading problem. Please try again.
          </p>
          <Button onClick={() => refetch()}>Try again</Button>
        </div>
      </div>
    );
  }

  if (!group) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="rounded-xl border bg-white p-8 text-center max-w-md">
          <h1 className="text-xl font-semibold mb-2">No group registration found</h1>
          <p className="text-slate-600">
            This account doesn&apos;t coordinate a group for this event. If someone else
            registered your company, ask them to share the details.
          </p>
        </div>
      </div>
    );
  }

  const tax = group.event.taxRate ? (group.subtotal * group.event.taxRate) / 100 : 0;
  const openInvoice = group.invoices.find((i) => i.status !== "CANCELLED" && i.status !== "PAID");
  // `--org` / `--org-tint` / `--org-edge` are set for the whole `/e/[slug]`
  // subtree by the public layout, so this page no longer derives them. The
  // globals.css defaults apply for an org that hasn't set a brand colour.
  return (
    <TooltipProvider delayDuration={200}>
    <div className="min-h-screen bg-slate-50">
      <EventBanner
        banner={group.event.bannerImage}
        bannerMobile={group.event.bannerImageMobile}
        name={group.event.name}
        className="w-full max-h-[240px] object-cover"
        priority
      />

      <div className="mx-auto w-full max-w-5xl px-4 py-8">
        {/* Event + coordinator header */}
        <div className="mb-6">
          <h1 className="text-2xl font-semibold">{group.event.name}</h1>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-slate-600">
            <span className="inline-flex items-center gap-1.5">
              <Calendar className="h-4 w-4" />
              {format(new Date(group.event.startDate), "d MMM yyyy")}
            </span>
            {group.event.venue ? (
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="h-4 w-4" /> {group.event.venue}
              </span>
            ) : null}
            <span
              className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-medium"
              style={{ color: "var(--org)", background: "var(--org-tint)" }}
            >
              <Users className="h-4 w-4" /> Group registration
            </span>
          </div>
        </div>

        {/* Payment state */}
        <div
          className="mb-6 overflow-hidden rounded-xl border bg-white"
          style={{ borderColor: "var(--org-edge)" }}
        >
          <div className="h-1" style={{ background: "var(--org)" }} />
          <div className="p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-sm text-slate-500">
                  <Building2 className="h-4 w-4" />
                  <Hint text="The company or institution paying for this group. Individual attendees are never asked to pay.">
                    Billed to
                  </Hint>
                </div>
                <p className="text-lg font-medium">{group.payer.name}</p>
                {group.payerReference ? (
                  <p className="text-sm text-slate-500">PO / Reference: {group.payerReference}</p>
                ) : null}
              </div>
              <div className="text-right">
                {group.isPaid ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-sm font-medium text-emerald-700">
                    <CheckCircle2 className="h-4 w-4" /> Paid in full
                  </span>
                ) : (
                  <>
                    <p className="text-sm text-slate-500">
                      <Hint text="The total on your consolidated invoice, including tax. It's fixed at the amount invoiced, so it won't move if the attendee list changes.">
                        Amount due
                      </Hint>
                    </p>
                    <p className="text-2xl font-semibold tabular-nums" style={{ color: "var(--org)" }}>
                      {formatCurrency(group.amountDue || group.subtotal + tax, group.currency)}
                    </p>
                  </>
                )}
              </div>
            </div>

            {!group.isPaid && group.amountDue > 0 ? (
              <div className="mt-5 border-t pt-5">
                <Button
                  onClick={payByCard}
                  disabled={paying}
                  style={{ background: "var(--org)" }}
                  className="text-white hover:opacity-90"
                >
                  {paying ? (
                    <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Opening payment…</>
                  ) : (
                    <><CreditCard className="mr-2 h-4 w-4" /> Pay {formatCurrency(group.amountDue, group.currency)} by card</>
                  )}
                </Button>
                <p className="mt-2 text-sm text-slate-500">
                  Or pay by bank transfer using the invoice below — the bank details are on it.
                </p>
              </div>
            ) : null}
          </div>
        </div>

        {/* Members */}
        <div className="mb-6 rounded-xl border bg-white">
          <div className="flex items-center justify-between border-b px-6 py-4">
            <h2 className="font-semibold">
              Attendees{" "}
              <span className="font-normal text-slate-500">
                ({group.memberCount}
                {group.cancelledCount > 0 ? ` · ${group.cancelledCount} cancelled` : ""})
              </span>
            </h2>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="mr-1 h-4 w-4" />
              Add people
            </Button>
          </div>
          {addNotice && (
            <div className="border-b bg-emerald-50 px-6 py-3 text-sm text-emerald-900">
              {addNotice}
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-slate-500">
                <tr className="border-b">
                  <th className="px-6 py-3 font-medium">#</th>
                  <th className="px-6 py-3 font-medium">Name</th>
                  <th className="px-6 py-3 font-medium">Type</th>
                  <th className="px-6 py-3 font-medium">
                    <Hint text="Each attendee's entry barcode goes straight to them by email — it isn't shown here. “Issued” means theirs has been generated and sent.">
                      Badge
                    </Hint>
                  </th>
                  <th className="px-6 py-3 font-medium">
                    <Hint text="“Confirmed” means they're registered. “Checked in” appears once they've been scanned at the door on the day.">
                      Status
                    </Hint>
                  </th>
                  <th className="px-6 py-3 text-right font-medium">Price</th>
                </tr>
              </thead>
              <tbody>
                {group.members.map((m) => {
                  const cancelled = m.status === "CANCELLED";
                  return (
                    <tr key={m.registrationId} className={`border-b last:border-0 ${cancelled ? "text-slate-400" : ""}`}>
                      <td className="px-6 py-3 tabular-nums">{formatSerialId(m.serialId)}</td>
                      <td className="px-6 py-3">
                        <div className={cancelled ? "line-through" : "font-medium"}>
                          {formatPersonName(m.title, m.firstName, m.lastName)}
                        </div>
                        <div className="text-xs text-slate-500">{m.email}</div>
                      </td>
                      <td className="px-6 py-3">
                        {m.ticketTypeName ?? "—"}
                        {m.tierName ? <span className="text-slate-500"> · {m.tierName}</span> : null}
                      </td>
                      <td className="px-6 py-3">
                        {cancelled ? "—" : m.badgeIssued ? (
                          <span className="inline-flex items-center gap-1 text-emerald-700">
                            <BadgeCheck className="h-4 w-4" /> Issued
                          </span>
                        ) : (
                          <Hint text="This attendee's barcode hasn't been generated yet. It's sent automatically — no action needed from you.">
                            <span className="text-slate-400">Pending</span>
                          </Hint>
                        )}
                      </td>
                      <td className="px-6 py-3">
                        {cancelled ? (
                          <Badge variant="outline">Cancelled</Badge>
                        ) : m.checkedIn ? (
                          <Badge className="bg-emerald-600">Checked in</Badge>
                        ) : (
                          <Badge variant="secondary">{m.status.toLowerCase()}</Badge>
                        )}
                      </td>
                      <td className="px-6 py-3 text-right tabular-nums">
                        {formatCurrency(m.price, group.currency)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="border-t px-6 py-4 text-sm">
            <div className="flex justify-between py-0.5">
              <span className="text-slate-500">Subtotal</span>
              <span className="tabular-nums">{formatCurrency(group.subtotal, group.currency)}</span>
            </div>
            {group.event.taxRate ? (
              <div className="flex justify-between py-0.5">
                <span className="text-slate-500">
                  {group.event.taxLabel || "VAT"} ({group.event.taxRate}%)
                </span>
                <span className="tabular-nums">{formatCurrency(tax, group.currency)}</span>
              </div>
            ) : null}
            <div className="mt-1 flex justify-between border-t pt-2 font-semibold">
              <span>Total</span>
              <span className="tabular-nums">
                {formatCurrency(group.subtotal + tax, group.currency)}
              </span>
            </div>
            {group.cancelledCount > 0 ? (
              <p className="mt-3 text-xs text-slate-500">
                Cancelled attendees are excluded from this total. Your issued invoice may still
                include them — contact the organizer for a credit note.
              </p>
            ) : null}
          </div>
        </div>

        {/* Invoices */}
        <div className="rounded-xl border bg-white">
          <div className="border-b px-6 py-4">
            <h2 className="font-semibold">Invoices</h2>
          </div>
          {group.invoices.length === 0 ? (
            <p className="px-6 py-5 text-sm text-slate-500">
              Your consolidated invoice will appear here shortly.
            </p>
          ) : (
            <ul className="divide-y">
              {group.invoices.map((inv) => (
                <li key={inv.id} className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
                  <div>
                    <div className="font-medium">{inv.invoiceNumber}</div>
                    <div className="text-sm text-slate-500">
                      Issued {format(new Date(inv.issueDate), "d MMM yyyy")}
                      {inv.status === "PAID" && inv.paidDate
                        ? ` · Paid ${format(new Date(inv.paidDate), "d MMM yyyy")}`
                        : inv.dueDate
                          ? ` · Due ${format(new Date(inv.dueDate), "d MMM yyyy")}`
                          : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge variant={inv.status === "PAID" ? "default" : inv.status === "CANCELLED" ? "outline" : "secondary"}>
                      {inv.status.toLowerCase()}
                    </Badge>
                    <span className="tabular-nums">{formatCurrency(inv.total, inv.currency)}</span>
                    <Button
                      variant="outline"
                      size="sm"
                      asChild
                      className="bg-white hover:bg-slate-50"
                      style={{ borderColor: "var(--org-edge)", color: "var(--org)" }}
                    >
                      <a
                        href={`/api/registrant/my-group/${group.id}/invoice/${inv.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <Download className="mr-1.5 h-4 w-4" /> PDF
                      </a>
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {openInvoice ? (
          <p className="mt-4 text-center text-sm text-slate-500">
            Registration is confirmed on receipt of payment.
          </p>
        ) : null}

        <div className="mt-8 flex flex-col items-center gap-2">
          {group.event.organizationName ? (
            <p className="text-xs text-slate-400">
              Organised by {group.event.organizationName}
            </p>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => signOut({ callbackUrl: `/e/${slug}/login` })}>
            <LogOut className="mr-1.5 h-4 w-4" /> Sign out
          </Button>
        </div>
      </div>

      <AddGroupMembersDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        slug={slug}
        groupId={group.id}
        currency={group.currency}
        remainingSlots={
          group.groupSettings.maxMembers
            ? Math.max(0, group.groupSettings.maxMembers - group.memberCount)
            : null
        }
        groupIsPaid={group.isPaid}
        onAdded={(r: AddGroupMembersResultShape) => {
          refetch();
          setAddNotice(
            `${r.addedCount} ${r.addedCount === 1 ? "person" : "people"} added.` +
              (r.invoiceNumber
                ? r.reissued
                  ? ` Your invoice was replaced with ${r.invoiceNumber}, covering everyone.`
                  : ` Invoice ${r.invoiceNumber} covers the new ${r.addedCount === 1 ? "attendee" : "attendees"}.`
                : " Your invoice will follow shortly."),
          );
          toast.success("Added to your group");
        }}
      />
    </div>
    </TooltipProvider>
  );
}
