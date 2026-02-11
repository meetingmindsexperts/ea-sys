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
    <div className={cn("flex items-center justify-center gap-3 text-primary", className)}>
      <Loader2 className={cn("h-[70px] w-[70px] animate-spin", iconClassName)} aria-hidden="true" />
      <span className="text-sm">{label}</span>
    </div>
  );
}
