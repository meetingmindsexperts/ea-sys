/**
 * Topics an organiser adds to a session with one click (Nov 18, 2026): a
 * panel discussion and a Q&A close most sessions. A preset is an ordinary
 * topic whose title is filled in and stays editable: the organiser sets its
 * minutes (the agenda derives its time slot from them, as for every topic),
 * renames it or deletes it. Nothing is added on its own: the organiser
 * decides, session by session.
 *
 * A preset names no speakers. Its "Presented by" is one of three phrases the
 * organiser picks (owner, Nov 18, 2026), stored as a code on
 * `SessionTopic.presenterLabel`. A topic WITH a label is a preset, whatever
 * its title says now, so it keeps the choice after a rename; a topic without
 * one is an ordinary topic with its speakers. Every place that shows a
 * topic's speakers shows `presenterLabelText` for a preset instead.
 *
 * Pure: imported by the dashboard forms, the public pages and the server.
 */
export const SESSION_TOPIC_PRESETS = ["Panel Discussion", "Q&A"] as const;

export const TOPIC_PRESENTER_LABELS = {
  ALL: "All",
  ALL_FACULTY: "All Faculty",
  ALL_ABOVE: "All the above",
} as const;

export type TopicPresenterLabel = keyof typeof TOPIC_PRESENTER_LABELS;

export const TOPIC_PRESENTER_LABEL_KEYS = Object.keys(TOPIC_PRESENTER_LABELS) as [
  TopicPresenterLabel,
  ...TopicPresenterLabel[],
];

/** What a preset says when the organiser has not changed it (owner: "All"). */
export const DEFAULT_TOPIC_PRESENTER_LABEL: TopicPresenterLabel = "ALL";

export function isTopicPresenterLabel(value: unknown): value is TopicPresenterLabel {
  return typeof value === "string" && Object.hasOwn(TOPIC_PRESENTER_LABELS, value);
}

/** The words for a stored code; null for an ordinary topic or an unknown code. */
export function presenterLabelText(value: string | null | undefined): string | null {
  return isTopicPresenterLabel(value) ? TOPIC_PRESENTER_LABELS[value] : null;
}
