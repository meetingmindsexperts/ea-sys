-- Seed the MCP system user.
--
-- Background: MCP tool executors called via API key (no OAuth session)
-- attribute actions to a sentinel `SYSTEM_USER_ID = "mcp-remote"` defined in
-- src/lib/agent/mcp-server-builder.ts. Several FKs point at User.id —
-- AuditLog.userId, AbstractReviewer.assignedById, AbstractReviewSubmission
-- .reviewerUserId — and an `await db.auditLog.create({ data: { userId: "mcp-remote", ...}})`
-- was throwing `Foreign key constraint violated on the constraint:
-- AuditLog_userId_fkey` in prod. Seeding a real row fixes every FK-to-User
-- write the MCP surface can produce.
--
-- The row is unreachable for login: passwordHash is a plaintext sentinel, NOT
-- a bcrypt $2b$/$2a$/$2y$ hash, so any bcrypt.compare against it returns false.
-- organizationId is NULL so the user is org-independent.
--
-- Idempotent: ON CONFLICT DO NOTHING swallows conflicts on id OR email,
-- so re-running the migration (or running this manually on a DB that already
-- has the row) is safe.

INSERT INTO "User" (
  "id",
  "organizationId",
  "email",
  "passwordHash",
  "firstName",
  "lastName",
  "role",
  "createdAt",
  "updatedAt"
) VALUES (
  'mcp-remote',
  NULL,
  'mcp-remote@system.local',
  '__mcp-system-no-login__',
  'MCP',
  'System',
  'ORGANIZER',
  NOW(),
  NOW()
)
ON CONFLICT DO NOTHING;
