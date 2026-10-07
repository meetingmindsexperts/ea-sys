import { toast } from "sonner";

/**
 * Duplicate a survey from the dashboard (the list and the builder). Returns
 * the new survey's id, or null after telling the user why it failed. The copy
 * is always a closed extra survey (see duplicateSurvey in survey-service).
 */
export async function duplicateSurveyRequest(eventId: string, surveyId: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/events/${eventId}/surveys/${encodeURIComponent(surveyId)}/duplicate`, {
      method: "POST",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.id) {
      console.warn("survey:duplicate-failed", res.status, data);
      toast.error(data.error ?? "Could not duplicate the survey.");
      return null;
    }
    toast.success("Copied as a new survey. It starts closed: open it when it is ready.");
    return data.id as string;
  } catch (err) {
    console.error("survey:duplicate-failed", err);
    toast.error("Could not duplicate the survey.");
    return null;
  }
}
