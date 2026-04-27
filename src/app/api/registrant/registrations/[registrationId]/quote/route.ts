import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { buildQuotePDFFromRegistration } from "@/lib/quote-pdf";

interface RouteParams {
  params: Promise<{ registrationId: string }>;
}

/**
 * GET /api/registrant/registrations/[registrationId]/quote
 *
 * Generates and returns a PDF quote for the registration. Accessible by
 * the registration owner (REGISTRANT) or admin/organizer.
 *
 * @deprecated UI no longer calls this directly — both `e/[slug]/my-registration`
 *   and `InvoiceDownloadButtons` now use the unauthenticated public route
 *   `/api/public/events/[slug]/registrations/[id]/document`. This route is
 *   kept for backwards-compat with stale links / bookmarks. Once Sentry
 *   confirms zero traffic over a release cycle, remove it.
 *
 *   Why we moved away: when a registrant's NextAuth JWT session lapsed
 *   (24-hour maxAge), the browser still rendered the cached `/my-registration`
 *   page. Clicking the `<a download>` link hit this route, got a JSON 401
 *   back, and saved it as `quote.json` — a confusing UX we had no way to
 *   recover from at the route layer.
 */
export async function GET(_req: Request, { params }: RouteParams) {
  // Capture early so the catch block can log routing context even if
  // params/auth fail.
  let registrationId: string | undefined;
  let session: Session | null = null;
  try {
    [session, { registrationId }] = await Promise.all([
      auth() as Promise<Session | null>,
      params,
    ]);

    if (!session?.user) {
      apiLogger.warn({ msg: "registrant/quote:unauthenticated", registrationId });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Fetch registration with all needed data. Reviewers/submitters
    // (role != REGISTRANT but organizationId == null) are rejected
    // here — Prisma would otherwise throw a validation error on the
    // nested relation filter.
    const isRegistrant = session.user.role === "REGISTRANT";
    if (!isRegistrant && !session.user.organizationId) {
      apiLogger.warn({
        msg: "registrant/quote:forbidden-no-org",
        registrationId,
        userId: session.user.id,
        role: session.user.role,
      });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const registration = await db.registration.findFirst({
      where: {
        id: registrationId,
        // Allow owner or org members
        ...(isRegistrant
          ? { userId: session.user.id }
          : { event: { organizationId: session.user.organizationId! } }),
      },
      include: {
        attendee: true,
        ticketType: { select: { name: true, price: true, currency: true } },
        pricingTier: { select: { name: true, price: true, currency: true } },
        event: {
          select: {
            name: true,
            code: true,
            startDate: true,
            venue: true,
            city: true,
            taxRate: true,
            taxLabel: true,
            bankDetails: true,
            supportEmail: true,
            organization: {
              select: {
                name: true,
                companyName: true,
                companyAddress: true,
                companyCity: true,
                companyState: true,
                companyZipCode: true,
                companyCountry: true,
                taxId: true,
                logo: true,
              },
            },
          },
        },
      },
    });

    if (!registration) {
      apiLogger.warn({
        msg: "registrant/quote:not-found",
        registrationId,
        userId: session.user.id,
        role: session.user.role,
      });
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    // Shared builder — see `src/lib/quote-pdf.ts buildQuotePDFFromRegistration`.
    // Same code path as `/api/public/events/[slug]/registrations/[id]/document`.
    const { buffer, filename } = await buildQuotePDFFromRegistration(registration);

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, max-age=0",
      },
    });
  } catch (error) {
    // Surface routing context + the Prisma error code (when present) so
    // Sentry groups DB connectivity failures (P1001 / P1008 / P1017)
    // distinctly from logic errors. Without this, a transient pooler drop
    // and a real bug share the same fingerprint.
    apiLogger.error({
      err: error,
      msg: "registrant/quote:render-failed",
      registrationId,
      userId: session?.user?.id ?? null,
      role: session?.user?.role ?? null,
      prismaCode: (error as { code?: string })?.code ?? null,
    });
    return NextResponse.json({ error: "Failed to generate quote" }, { status: 500 });
  }
}
