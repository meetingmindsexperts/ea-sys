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
} from "./meetings";

// Meeting SDK signatures
export {
  generateZoomSignature,
  isZoomSdkConfigured,
} from "./signature";

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
