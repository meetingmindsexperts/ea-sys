"use client";

import { useEffect } from "react";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Dashboard error:", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="mx-auto max-w-md rounded-lg border bg-white p-8 shadow-sm">
        <h2 className="mb-2 text-xl font-semibold text-gray-900">
          Something went wrong
        </h2>
        <p className="mb-6 text-sm text-gray-600">
          An error occurred while loading this page. Please try again.
        </p>
        <button
          onClick={reset}
          className="rounded-md bg-[#00aade] px-4 py-2 text-sm font-medium text-white hover:bg-[#0090c0] transition-colors"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
