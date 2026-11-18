"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  TOPIC_PRESENTER_LABELS,
  TOPIC_PRESENTER_LABEL_KEYS,
  type TopicPresenterLabel,
} from "@/lib/session-topic-presets";

/**
 * "Presented by" for a Panel Discussion or Q&A preset topic: All, All Faculty
 * or All the above, in place of the speaker picker (owner, Nov 18, 2026).
 * Shared by the session dialog and the session detail panel.
 */
export function PresenterLabelSelect({
  value,
  onChange,
}: {
  value: TopicPresenterLabel;
  onChange: (value: TopicPresenterLabel) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground shrink-0">Presented by</span>
      <Select value={value} onValueChange={(v) => onChange(v as TopicPresenterLabel)}>
        <SelectTrigger className="h-8 w-44" aria-label="Presented by">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {TOPIC_PRESENTER_LABEL_KEYS.map((key) => (
            <SelectItem key={key} value={key}>
              {TOPIC_PRESENTER_LABELS[key]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
