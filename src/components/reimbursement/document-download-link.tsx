"use client";

import { Download } from "lucide-react";

/**
 * One-click download for a document a speaker attached to a reimbursement
 * claim (Nov 19, 2026), beside the link that opens it in the browser. The
 * same authed route, asked for an attachment instead of inline.
 */
export function DocumentDownloadLink({ href, filename }: { href: string; filename: string }) {
  return (
    <a
      href={`${href}?download=1`}
      download={filename}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      title={`Download ${filename}`}
      aria-label={`Download ${filename}`}
    >
      <Download className="h-4 w-4" />
    </a>
  );
}
