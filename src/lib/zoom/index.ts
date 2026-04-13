/**
 * Zoom integration module.
 * Re-exports all public functions for convenient imports.
 */

// Client & auth
export {
  getZoomCredentials,
  isZoomConfigured,
  getZoomAccessToken,
  zoomApiRequest,
  encryptSecret,
  decryptSecret,
} from "./client";

// Meetings & webinars
export {
  createZoomMeeting,
  getZoomMeeting,
  updateZoomMeeting,
  deleteZoomMeeting,
  createZoomWebinar,
  createWebinarSeries,
  getZoomWebinar,
  updateZoomWebinar,
  deleteZoomWebinar,
  addWebinarPanelists,
  listWebinarPanelists,
  removeWebinarPanelist,
  enableZoomLiveStreaming,
  enableWebinarLiveStreaming,
} from "./meetings";

// Meeting SDK signatures
export {
  generateZoomSignature,
  generateZoomSignatureForOrg,
} from "./signature";

// Cloud recordings
export {
  getZoomRecordings,
  pickBestRecordingFile,
} from "./recordings";
export type { ZoomRecordingFile, ZoomRecordingsResponse } from "./recordings";

// Reports (participants, polls, Q&A)
export { getZoomParticipants } from "./reports";
export type { ZoomParticipant } from "./reports";

// Types
export type {
  ZoomOAuthTokenResponse,
  ZoomOrgCredentials,
  CreateZoomMeetingParams,
  CreateZoomWebinarParams,
  ZoomMeetingResponse,
  ZoomWebinarResponse,
  ZoomRecurrence,
  ZoomOccurrence,
  ZoomPanelist,
  ZoomUserResponse,
  ZoomEventSettings,
  ZoomApiError,
} from "./types";
