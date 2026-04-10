"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function AuthError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error, {
      tags: { boundary: "auth" },
      extra: { digest: error.digest, message: error.message, stack: error.stack },
    });
    console.error("Auth error:", error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <div className="mx-auto w-full max-w-md rounded-lg border bg-white p-8 shadow-sm">
        <h2 className="mb-2 text-xl font-semibold text-gray-900">
          Something went wrong
        </h2>
        <p className="mb-4 text-sm text-gray-600">
          We couldn&apos;t load this page. Please try again.
        </p>
        {error.message && (
          <details className="mb-4 rounded-md border bg-red-50 p-3 text-xs text-red-800">
            <summary className="cursor-pointer font-medium">Error details</summary>
            <p className="mt-2 break-all font-mono">{error.message}</p>
            {error.digest && (
              <p className="mt-2 text-red-600">Digest: <code>{error.digest}</code></p>
            )}
          </details>
        )}
        <button
          onClick={reset}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
