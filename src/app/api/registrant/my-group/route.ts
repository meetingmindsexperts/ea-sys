import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { resolveRequestOrgId } from "@/lib/tenant/resolver";
import { runWithTenantLane } from "@/lib/tenant-lane";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { round2 } from "@/lib/registration-financials";
import { readGroupRegistrationSettings } from "@/lib/group-registration-settings";

/**
 * GET /api/registrant/my-group — the coordinator's own group registrations.
 *
 * Ownership is `RegistrationGroup.coordinatorUserId === session.user.id`, NOT
 * an org check: a coordinator is a REGISTRANT, org-null on master by design
 * (docs/IDENTITY_AND_ROLES.md §1). The ownership rule is unchanged, but the
 * route now runs inside a tenant LANE taken from the host — the two are
 * different questions, and the lane is what lets this read anything at all
 * under platform RLS (PLATFORM_DECISIONS §6, decided Aug 21 2026).
 *
 * Deliberately NOT returned: member `qrCode`. It is a physical-access
 * credential (the July-11 barcode boundary) and each member already receives
 * their own by email. The coordinator sees only WHETHER a badge exists, which
 * is what they actually need to chase a member.
 */
export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      apiLogger.warn({ msg: "my-group:unauthorized" });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Tenancy lane (item 6 follow-on). A REGISTRANT is org-null on master by
    // design, and the rows below sit behind an RLS policy on the platform — so
    // the lane cannot come from the session and cannot be read out of the
    // database first. It comes from the host, exactly as sign-in does.
    const orgId = await resolveRequestOrgId(req);
    return await runWithTenantLane(orgId, { route: "registrant/my-group", userId: session?.user?.id }, async () => {

    const groups = await db.registrationGroup.findMany({
      where: { coordinatorUserId: session.user.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        createdAt: true,
        coordinatorName: true,
        coordinatorEmail: true,
        coordinatorAttending: true,
        payerReference: true,
        billingAccount: {
          select: { name: true, contactName: true, email: true },
        },
        event: {
          select: {
            id: true,
            name: true,
            slug: true,
            startDate: true,
            endDate: true,
            venue: true,
            city: true,
            bannerImage: true,
            bannerImageMobile: true,
            taxRate: true,
            taxLabel: true,
            settings: true,
            // Org branding so the portal wears the organiser's colour rather
            // than a hardcoded accent. Nullable — the page falls back.
            organization: { select: { name: true, primaryColor: true } },
          },
        },
        registrations: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            serialId: true,
            status: true,
            paymentStatus: true,
            checkedInAt: true,
            originalPrice: true,
            // Boolean only — never the value (see the docblock).
            qrCode: true,
            ticketType: { select: { name: true, currency: true } },
            pricingTier: { select: { name: true } },
            attendee: {
              select: {
                title: true,
                firstName: true,
                lastName: true,
                email: true,
                organization: true,
                jobTitle: true,
                phone: true,
                city: true,
                country: true,
              },
            },
          },
        },
        invoices: {
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            invoiceNumber: true,
            type: true,
            status: true,
            issueDate: true,
            dueDate: true,
            paidDate: true,
            subtotal: true,
            taxAmount: true,
            total: true,
            currency: true,
          },
        },
      },
    });

    const payload = groups.map((g) => {
      const live = g.registrations.filter((r) => r.status !== "CANCELLED");
      const openInvoice = g.invoices.find(
        (i) => i.status !== "CANCELLED" && i.status !== "PAID",
      );
      const currency =
        g.invoices[0]?.currency ?? live[0]?.ticketType?.currency ?? "USD";

      // Amount still owed: the open invoice when one exists (it is the frozen
      // document the company is paying against), else nothing is due.
      const amountDue = openInvoice ? Number(openInvoice.total) : 0;
      const settings = readGroupRegistrationSettings(g.event.settings);

      return {
        id: g.id,
        createdAt: g.createdAt,
        coordinatorName: g.coordinatorName,
        coordinatorEmail: g.coordinatorEmail,
        coordinatorAttending: g.coordinatorAttending,
        payerReference: g.payerReference,
        payer: g.billingAccount,
        event: {
          id: g.event.id,
          name: g.event.name,
          slug: g.event.slug,
          startDate: g.event.startDate,
          endDate: g.event.endDate,
          venue: g.event.venue,
          city: g.event.city,
          bannerImage: g.event.bannerImage,
          bannerImageMobile: g.event.bannerImageMobile,
          taxRate: g.event.taxRate ? Number(g.event.taxRate) : null,
          taxLabel: g.event.taxLabel,
          organizationName: g.event.organization?.name ?? null,
          primaryColor: g.event.organization?.primaryColor ?? null,
        },
        groupSettings: {
          minMembers: settings.minMembers,
          maxMembers: settings.maxMembers,
        },
        members: g.registrations.map((r) => ({
          registrationId: r.id,
          serialId: r.serialId,
          status: r.status,
          paymentStatus: r.paymentStatus,
          checkedIn: !!r.checkedInAt,
          checkedInAt: r.checkedInAt,
          badgeIssued: !!r.qrCode,
          price: r.originalPrice ? Number(r.originalPrice) : 0,
          ticketTypeName: r.ticketType?.name ?? null,
          tierName: r.pricingTier?.name ?? null,
          title: r.attendee.title,
          firstName: r.attendee.firstName,
          lastName: r.attendee.lastName,
          email: r.attendee.email,
          organization: r.attendee.organization,
          jobTitle: r.attendee.jobTitle,
          phone: r.attendee.phone,
          city: r.attendee.city,
          country: r.attendee.country,
        })),
        memberCount: live.length,
        cancelledCount: g.registrations.length - live.length,
        currency,
        subtotal: round2(live.reduce((s, r) => s + Number(r.originalPrice ?? 0), 0)),
        amountDue,
        isPaid: !openInvoice && g.invoices.some((i) => i.status === "PAID"),
        invoices: g.invoices.map((i) => ({
          id: i.id,
          invoiceNumber: i.invoiceNumber,
          type: i.type,
          status: i.status,
          issueDate: i.issueDate,
          dueDate: i.dueDate,
          paidDate: i.paidDate,
          total: Number(i.total),
          currency: i.currency,
        })),
      };
    });

    return NextResponse.json({ groups: payload });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "my-group:list-failed" });
    return NextResponse.json({ error: "Failed to load your group" }, { status: 500 });
  }
}
