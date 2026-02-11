"use client";

import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface ReloadingSpinnerProps {
  className?: string;
  iconClassName?: string;
  label?: string;
}

export function ReloadingSpinner({
  className,
  iconClassName,
  label = "Reloading...",
}: ReloadingSpinnerProps) {
  return (
    <div className={cn("flex items-center justify-center gap-2 text-muted-foreground", className)}>
      <Loader2 className={cn("h-6 w-6 animate-spin", iconClassName)} aria-hidden="true" />
      <span className="text-sm">{label}</span>
    </div>
  );
}
