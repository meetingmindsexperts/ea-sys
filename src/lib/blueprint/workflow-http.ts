/** Workflow refusals as HTTP. The service has already logged each with its code. */
import { NextResponse } from "next/server";

const STATUS: Record<string, number> = {
  INVALID_ID: 400,
  NOT_FOUND: 404,
  NOT_ALLOWED_FROM_STAGE: 409,
  CONFLICT: 409,
  STALE_VERSION: 409,
  OUT_OF_SCOPE: 403,
  APPROVER_IS_AUTHOR: 409,
  BLUEPRINT_INCOMPLETE: 409,
  DATES_NEEDED: 409,
  EVENT_CREATE_FAILED: 409,
};

export function workflowErrorResponse(err: { code: string; message: string; meta?: Record<string, unknown> }): NextResponse {
  return NextResponse.json({ error: err.message, code: err.code, ...(err.meta ?? {}) }, { status: STATUS[err.code] ?? 400 });
}
