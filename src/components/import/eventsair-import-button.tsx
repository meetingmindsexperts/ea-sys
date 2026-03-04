"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Cloud } from "lucide-react";
import { EventsAirImportDialog } from "./eventsair-import-dialog";

export function EventsAirImportButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Cloud className="mr-2 h-4 w-4" />
        Import from EventsAir
      </Button>
      <EventsAirImportDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
