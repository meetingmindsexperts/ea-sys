"use client";

import { Presentation } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useCan } from "@/hooks/use-can";
import { PresentationUploads } from "@/components/speakers/presentation-uploads";

/**
 * The speaker page's Presentations card (Nov 19, 2026;
 * docs/SPEAKER_PRESENTATIONS_PLAN.md): the slides or video received for each
 * of the speaker's talks, with download, and upload on the speaker's behalf.
 * Shown to whoever may read speaker documents; downloading needs the files
 * key and uploading or removing the write key. The speaker's own door is their profile form link.
 */
export function SpeakerPresentationsCard({ eventId, speakerId }: { eventId: string; speakerId: string }) {
  const canRead = useCan("speakers.documents.read", eventId) === "allowed";
  const canWrite = useCan("speakers.documents.write", eventId) === "allowed";
  // The files themselves need their own key (a read-only Member sees that a
  // file was received and cannot download it), as the Documents card does.
  const canOpen = useCan("speakers.documents.open", eventId) === "allowed";
  if (!canRead) return null;
  return (
    <PresentationUploads
      apiBase={`/api/events/${eventId}/speakers/${speakerId}/presentations`}
      canUpload={canWrite}
      canDownload={canOpen}
      staff
      shell={(content) => (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Presentation className="h-4 w-4" />
              Presentations
            </CardTitle>
          </CardHeader>
          <CardContent>{content}</CardContent>
        </Card>
      )}
    />
  );
}
