/**
 * Topics an organiser adds to a session with one click (Nov 18, 2026): a
 * panel discussion and a Q&A close most sessions. A preset only fills the
 * title of an ordinary topic, which stays editable like any other: the
 * organiser sets its minutes (the agenda derives its time slot from them,
 * as for every topic), may assign speakers, rename it or delete it. Nothing
 * is added on its own: the organiser decides, session by session.
 */
export const SESSION_TOPIC_PRESETS = ["Panel Discussion", "Q&A"] as const;
