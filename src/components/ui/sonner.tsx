"use client"

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      // Toasts in the organisation's theme colour with white text (owner,
      // Oct 6, 2026); errors stay red so a failure never reads as a success.
      // `--primary` is the org colour (set by OrgTheme). The `!` is needed
      // because Sonner styles toasts through its own stylesheet.
      closeButton
      toastOptions={{
        classNames: {
          // Sonner marks each toast with data-type; keying the red off it
          // outranks the brand colour by specificity, not stylesheet order.
          toast:
            "!rounded-xl !border !border-primary !bg-primary !px-4 !py-3.5 !text-white !shadow-lg !gap-3 data-[type=error]:!border-red-600 data-[type=error]:!bg-red-600",
          title: "!text-sm !font-semibold !text-white",
          description: "!text-[13px] !leading-snug !text-white/90",
          icon: "!size-5 !text-white",
          actionButton: "!rounded-md !bg-white !font-medium !text-primary",
          cancelButton: "!rounded-md !bg-white/20 !text-white",
          closeButton: "!border-white/40 !bg-white !text-slate-700 hover:!text-slate-900",
        },
      }}
      icons={{
        success: <CircleCheckIcon className="size-5" />,
        info: <InfoIcon className="size-5" />,
        warning: <TriangleAlertIcon className="size-5" />,
        error: <OctagonXIcon className="size-5" />,
        loading: <Loader2Icon className="size-5 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
