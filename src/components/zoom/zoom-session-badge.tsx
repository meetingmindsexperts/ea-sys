"use client";

import { Badge } from "@/components/ui/badge";
import { Video } from "lucide-react";

interface ZoomSessionBadgeProps {
  meetingType: string;
  status?: string;
}

const TYPE_LABELS: Record<string, string> = {
  MEETING: "Zoom Meeting",
  WEBINAR: "Zoom Webinar",
  WEBINAR_SERIES: "Webinar Series",
};

const STATUS_COLORS: Record<string, string> = {
  CREATED: "bg-blue-50 text-blue-700 border-blue-200",
  STARTED: "bg-green-50 text-green-700 border-green-200",
  ENDED: "bg-gray-50 text-gray-600 border-gray-200",
  DELETED: "bg-red-50 text-red-600 border-red-200",
};

export function ZoomSessionBadge({ meetingType, status = "CREATED" }: ZoomSessionBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={`gap-1 text-xs ${STATUS_COLORS[status] || STATUS_COLORS.CREATED}`}
    >
      <Video className="h-3 w-3" />
      {TYPE_LABELS[meetingType] || "Zoom"}
      {status === "STARTED" && (
        <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
      )}
    </Badge>
  );
}
