-- MCP OAuth 2.1 tables: Dynamic Client Registration (RFC 7591), PKCE authorization codes,
-- and hashed Bearer access/refresh tokens. Enables claude.ai web (and any spec-compliant
-- remote MCP client) to authenticate to /api/mcp via OAuth. The existing ApiKey-based
-- auth path stays untouched for backward compatibility with Claude Desktop / mcp-remote / n8n.

CREATE TABLE "McpOAuthClient" (
    "id"                      TEXT NOT NULL,
    "clientId"                TEXT NOT NULL,
    "clientSecretHash"        TEXT,
    "clientName"              TEXT,
    "redirectUris"            TEXT[],
    "grantTypes"              TEXT[] DEFAULT ARRAY['authorization_code', 'refresh_token']::TEXT[],
    "tokenEndpointAuthMethod" TEXT NOT NULL DEFAULT 'none',
    "scope"                   TEXT NOT NULL DEFAULT 'mcp',
    "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "McpOAuthClient_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "McpOAuthClient_clientId_key" ON "McpOAuthClient"("clientId");
CREATE INDEX "McpOAuthClient_clientId_idx" ON "McpOAuthClient"("clientId");

CREATE TABLE "McpOAuthAuthCode" (
    "id"                  TEXT NOT NULL,
    "codeHash"            TEXT NOT NULL,
    "clientId"            TEXT NOT NULL,
    "userId"              TEXT NOT NULL,
    "organizationId"      TEXT NOT NULL,
    "codeChallenge"       TEXT NOT NULL,
    "codeChallengeMethod" TEXT NOT NULL DEFAULT 'S256',
    "redirectUri"         TEXT NOT NULL,
    "scope"               TEXT NOT NULL DEFAULT 'mcp',
    "expiresAt"           TIMESTAMP(3) NOT NULL,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "McpOAuthAuthCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "McpOAuthAuthCode_codeHash_key" ON "McpOAuthAuthCode"("codeHash");
CREATE INDEX "McpOAuthAuthCode_clientId_idx" ON "McpOAuthAuthCode"("clientId");
CREATE INDEX "McpOAuthAuthCode_userId_idx" ON "McpOAuthAuthCode"("userId");
CREATE INDEX "McpOAuthAuthCode_expiresAt_idx" ON "McpOAuthAuthCode"("expiresAt");

ALTER TABLE "McpOAuthAuthCode"
    ADD CONSTRAINT "McpOAuthAuthCode_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "McpOAuthClient"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "McpOAuthAuthCode"
    ADD CONSTRAINT "McpOAuthAuthCode_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "McpOAuthAccessToken" (
    "id"             TEXT NOT NULL,
    "tokenHash"      TEXT NOT NULL,
    "refreshHash"    TEXT,
    "clientId"       TEXT NOT NULL,
    "userId"         TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "scope"          TEXT NOT NULL DEFAULT 'mcp',
    "expiresAt"      TIMESTAMP(3) NOT NULL,
    "revokedAt"      TIMESTAMP(3),
    "lastUsedAt"     TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "McpOAuthAccessToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "McpOAuthAccessToken_tokenHash_key" ON "McpOAuthAccessToken"("tokenHash");
CREATE UNIQUE INDEX "McpOAuthAccessToken_refreshHash_key" ON "McpOAuthAccessToken"("refreshHash");
CREATE INDEX "McpOAuthAccessToken_clientId_idx" ON "McpOAuthAccessToken"("clientId");
CREATE INDEX "McpOAuthAccessToken_userId_idx" ON "McpOAuthAccessToken"("userId");
CREATE INDEX "McpOAuthAccessToken_expiresAt_idx" ON "McpOAuthAccessToken"("expiresAt");

ALTER TABLE "McpOAuthAccessToken"
    ADD CONSTRAINT "McpOAuthAccessToken_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "McpOAuthClient"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "McpOAuthAccessToken"
    ADD CONSTRAINT "McpOAuthAccessToken_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
