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
      // Coloured success / error / warning / info toasts with a close button
      // and a card look (owner, Oct 6, 2026: "looking bland"). The `!` is
      // needed because Sonner styles toasts through its own stylesheet.
      richColors
      closeButton
      toastOptions={{
        classNames: {
          toast: "!rounded-xl !border !px-4 !py-3.5 !shadow-lg !gap-3",
          title: "!text-sm !font-semibold",
          description: "!text-[13px] !leading-snug !opacity-90",
          icon: "!size-5",
          actionButton: "!rounded-md !font-medium",
          closeButton: "!border !bg-background !text-muted-foreground hover:!text-foreground",
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
