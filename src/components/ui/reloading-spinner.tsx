"use client";

import { cn } from "@/lib/utils";

interface ReloadingSpinnerProps {
  className?: string;
  iconClassName?: string;
  label?: string;
}

export function ReloadingSpinner({
  className,
  iconClassName,
  label,
}: ReloadingSpinnerProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3", className)}>
      <div className="relative h-12 w-12" aria-hidden="true">
        <span
          className={cn(
            "absolute inset-0 rounded-full border-2 border-primary/20",
            iconClassName
          )}
        />
        <span
          className={cn(
            "absolute inset-0 rounded-full border-2 border-transparent border-t-primary border-r-primary animate-spin",
            iconClassName
          )}
        />
        <span className="absolute inset-[10px] rounded-full bg-primary/10 animate-pulse" />
      </div>
      {label ? <span className="text-sm text-muted-foreground">{label}</span> : null}
    </div>
  );
}
