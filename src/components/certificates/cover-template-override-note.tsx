"use client";

/**
 * Shown in the Email Templates editor on the two one-certificate cover
 * templates (Sep 17, 2026, review M4). A certificate template with its own
 * saved cover email wins over these, so an organizer editing here needs to
 * know which certificates their edit will not reach. On production most did.
 */

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import type { CertificateType } from "@prisma/client";
import { CERT_COVER_TEMPLATE_SLUGS, hasOwnCoverEmail } from "@/lib/certificates/email-tokens";

interface CertTemplateRow {
  id: string;
  name: string;
  category: CertificateType;
  emailSubject: string | null;
  emailBody: string | null;
}

export function CertificateCoverOverrideNote({ eventId, slug }: { eventId: string; slug: string }) {
  const category = (Object.keys(CERT_COVER_TEMPLATE_SLUGS) as CertificateType[]).find(
    (c) => CERT_COVER_TEMPLATE_SLUGS[c] === slug,
  );
  // Same key and shape as the certificates page, so the two share the cache.
  const templatesQuery = useQuery({
    queryKey: ["cert-templates", eventId],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/certificates/templates`);
      if (!res.ok) throw new Error(`Failed to load certificate templates (${res.status})`);
      return (await res.json()) as { templates: CertTemplateRow[] };
    },
    enabled: Boolean(category),
  });

  if (!category) return null;
  const ownWording = (templatesQuery.data?.templates ?? []).filter(
    (t) => t.category === category && hasOwnCoverEmail(t),
  );
  if (ownWording.length === 0) return null;

  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
      <p className="font-medium">
        {ownWording.length === 1
          ? "1 certificate template uses its own wording, so edits here do not reach it:"
          : `${ownWording.length} certificate templates use their own wording, so edits here do not reach them:`}
      </p>
      <p className="mt-1">{ownWording.map((t) => t.name).join(", ")}</p>
      <p className="mt-1">
        To make one follow this template, open{" "}
        <Link href={`/events/${eventId}/certificates`} className="underline underline-offset-2">
          Certificates
        </Link>
        , click Edit on it, then Cover email → Use the email template instead.
      </p>
    </div>
  );
}
