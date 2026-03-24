"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ImportRegistrationsDialog } from "./import-registrations-dialog";
import { ClipboardList } from "lucide-react";

interface ImportRegistrationsButtonProps {
  eventId: string;
}

export function ImportRegistrationsButton({ eventId }: ImportRegistrationsButtonProps) {
  const [open, setOpen] = useState(false);
  const [dialogKey, setDialogKey] = useState(0);

  const handleOpen = () => {
    setDialogKey((k) => k + 1);
    setOpen(true);
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={handleOpen}>
        <ClipboardList className="h-4 w-4 mr-1.5" />
        Import from Registrations
      </Button>
      <ImportRegistrationsDialog
        key={dialogKey}
        open={open}
        onOpenChange={setOpen}
        eventId={eventId}
      />
    </>
  );
}
