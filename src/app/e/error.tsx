"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import Link from "next/link";

export default function PublicEventError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error, {
      tags: { boundary: "public-event" },
      extra: { digest: error.digest, message: error.message, stack: error.stack },
    });
    console.error("Public event page error:", error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f8f9fb] p-4">
      <div className="mx-auto w-full max-w-lg rounded-2xl border border-slate-100 bg-white p-8 shadow-sm">
        <h2 className="mb-2 text-xl font-semibold text-slate-900">
          Something went wrong
        </h2>
        <p className="mb-4 text-sm text-slate-600">
          We couldn&apos;t load this page. Please try again or contact the event organizer if the problem persists.
        </p>
        {/*
          The raw error message is deliberately NOT shown here, unlike the
          dashboard boundary. This page faces attendees and sponsors: engine
          internals are noise to them at best, and a client-thrown message is
          not redacted by Next the way a server one is. The full message and
          stack still go to Sentry above; the digest below is a safe reference
          the organiser can quote to support.
        */}
        {error.digest && (
          <p className="mb-4 text-xs text-slate-400">
            Reference: <code>{error.digest}</code>
          </p>
        )}
        <div className="flex gap-2">
          <button
            onClick={reset}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors"
          >
            Try again
          </button>
          <Link
            href="/"
            className="rounded-md border px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}
