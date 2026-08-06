import Link from "next/link";
import { FileQuestion } from "lucide-react";

/**
 * Platform-wide 404.
 *
 * Without this file Next.js renders its built-in page — bare black-on-white
 * "404 | This page could not be found", no branding and no way forward. This
 * replaces it for every unmatched URL, and for any `notFound()` thrown above
 * a more specific boundary (e.g. an unknown event slug, where there is no
 * event left to brand the page with).
 *
 * Deliberately a SERVER component with no data fetching: a 404 is often the
 * first thing a mistyped link hits, so it must render even when the database
 * is unreachable.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f8f9fb] p-4">
      <div className="mx-auto w-full max-w-lg rounded-2xl border border-slate-100 bg-white p-8 text-center shadow-sm">
        <FileQuestion className="mx-auto mb-4 h-10 w-10 text-slate-400" />
        <h1 className="mb-2 text-xl font-semibold text-slate-900">
          Page not found
        </h1>
        <p className="mb-6 text-sm text-slate-600">
          This link may be out of date, or the address may have been mistyped.
          Please check the link you were given, or contact the event organizing
          team.
        </p>
        <Link
          href="/"
          className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary/90"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}
