import { redirect } from "next/navigation";
import Link from "next/link";
import { AlertCircle } from "lucide-react";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { Button } from "@/components/ui/button";

/**
 * The global /my-registration route no longer renders a cross-event list.
 * Per-event isolation rule: users only interact with their registration in
 * the context of the specific event they registered for. This route exists
 * purely as a gateway for:
 *
 *   1. REGISTRANT auth redirects (middleware + login fallback) that don't
 *      know the right event slug upfront. We look up the user's most-recent
 *      registration and forward them to /e/{slug}/my-registration.
 *   2. Users who type the URL directly. Same thing — land them on the
 *      event-scoped page for the event they actually registered for.
 *
 * When the user has zero registrations we render a minimal empty state so
 * the page doesn't return 404 for valid auth'd sessions.
 */
export default async function MyRegistrationGatewayPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login?callbackUrl=/my-registration");
  }

  const latest = await db.registration.findFirst({
    where: {
      userId: session.user.id,
      status: { not: "CANCELLED" },
    },
    select: { event: { select: { slug: true } } },
    orderBy: { createdAt: "desc" },
  });

  if (latest?.event?.slug) {
    redirect(`/e/${latest.event.slug}/my-registration`);
  }

  return (
    <div className="min-h-screen bg-[#f8f9fb] flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white rounded-xl border border-slate-200 p-8 text-center space-y-4">
        <AlertCircle className="h-10 w-10 text-slate-300 mx-auto" />
        <div>
          <h2 className="text-lg font-semibold text-slate-900 mb-2">No registrations yet</h2>
          <p className="text-slate-500 text-sm">
            You haven&apos;t registered for any events. Use the event link
            provided by the organizer to sign up.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/login">Sign out</Link>
        </Button>
      </div>
    </div>
  );
}
