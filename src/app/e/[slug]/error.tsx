"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { PublicEventNotice } from "@/components/public/event-notice";

/**
 * A page of one public event crashed (Nov 17, 2026).
 *
 * This boundary sits INSIDE the `[slug]` layout, so the event's branding is
 * still in reach and the visitor keeps the banner and footer around the
 * message. `src/app/e/error.tsx` stays as the boundary above the layout, for
 * the case where the layout itself (or this frame) is what failed.
 *
 * The raw error message is deliberately not shown, for the reason given there:
 * this faces attendees and sponsors, and a client-thrown message is not
 * redacted by Next the way a server one is. The full message and stack go to
 * Sentry; the digest is a safe reference to quote to the organiser.
 */
export default function PublicEventPageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const params = useParams<{ slug: string }>();
  // When the page that crashed IS the event page, a link back to it is a link
  // to the failure. Then the way out is the site's home, as on the boundary
  // above the layout.
  const eventPath = `/e/${params.slug}`;
  const crashedOnEventPage = usePathname() === eventPath;

  useEffect(() => {
    Sentry.captureException(error, {
      tags: { boundary: "public-event-page" },
      extra: { digest: error.digest, message: error.message, stack: error.stack },
    });
    console.error("Public event page error:", error);
  }, [error]);

  return (
    <PublicEventNotice
      tone="error"
      title="Something went wrong"
      description="We couldn’t load this page. Please try again, or contact the event organizer if the problem persists."
    >
      {error.digest && (
        <p className="text-xs text-slate-400">
          Reference: <code>{error.digest}</code>
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors"
        >
          Try again
        </button>
        <Link
          href={crashedOnEventPage ? "/" : eventPath}
          className="rounded-md border px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
        >
          {crashedOnEventPage ? "Go home" : "Back to event"}
        </Link>
      </div>
    </PublicEventNotice>
  );
}
