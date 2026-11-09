import { Award, Download } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface CertificateListItem {
  id: string;
  title: string;
  /** CME hours, serial and issue date, already joined. */
  meta: string;
}

/**
 * A person's certificates with a download each. Shared by the all-events list
 * (/my-account) and an event's own My Registration page, so the two show
 * a certificate the same way.
 *
 * Mobile first: on a phone the download is a full-width button under the
 * text, big enough to hit with a thumb; from `sm` up it sits beside it.
 */
export function CertificateList({ certificates }: { certificates: CertificateListItem[] }) {
  return (
    <ul className="divide-y rounded-md border">
      {certificates.map((c) => (
        <li key={c.id} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <Award className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <div className="min-w-0">
              <p className="text-sm font-medium">{c.title}</p>
              <p className="break-words text-xs text-muted-foreground">{c.meta}</p>
            </div>
          </div>
          <Button asChild variant="outline" className="h-11 w-full sm:h-9 sm:w-auto">
            {/* A plain link: the route answers with the PDF as an attachment. */}
            <a href={`/api/registrant/certificates/${c.id}/download`}>
              <Download className="mr-1.5 h-4 w-4" />
              Download
            </a>
          </Button>
        </li>
      ))}
    </ul>
  );
}
