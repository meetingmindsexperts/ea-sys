-- Help-assistant Q&A capture. Additive + idempotent (blue-green safe): a new
-- table only, no changes to existing tables. See model HelpChatQuery.
CREATE TABLE IF NOT EXISTS "HelpChatQuery" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "userEmail" TEXT,
    "userName" TEXT,
    "role" TEXT,
    "organizationId" TEXT,
    "organizationName" TEXT,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HelpChatQuery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "HelpChatQuery_createdAt_idx" ON "HelpChatQuery"("createdAt");
CREATE INDEX IF NOT EXISTS "HelpChatQuery_userId_createdAt_idx" ON "HelpChatQuery"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "HelpChatQuery_organizationId_createdAt_idx" ON "HelpChatQuery"("organizationId", "createdAt");
