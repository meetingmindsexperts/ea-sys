"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ImportContactsDialog } from "./import-contacts-dialog";
import { BookUser } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/hooks/use-api";

interface ImportContactsButtonProps {
  eventId: string;
  mode: "speaker" | "registration";
}

export function ImportContactsButton({ eventId, mode }: ImportContactsButtonProps) {
  const [open, setOpen] = useState(false);
  const [dialogKey, setDialogKey] = useState(0);
  const queryClient = useQueryClient();

  const handleOpen = () => {
    setDialogKey((k) => k + 1);
    setOpen(true);
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={handleOpen}>
        <BookUser className="h-4 w-4 mr-1.5" />
        Import from Contacts
      </Button>
      <ImportContactsDialog
        key={dialogKey}
        open={open}
        onOpenChange={setOpen}
        eventId={eventId}
        mode={mode}
        onSuccess={() => {
          if (mode === "speaker") {
            queryClient.invalidateQueries({ queryKey: queryKeys.speakers(eventId) });
          } else {
            queryClient.invalidateQueries({ queryKey: queryKeys.registrations(eventId) });
          }
        }}
      />
    </>
  );
}
