/**
 * The acting "user" of an API-key or OAuth MCP call: a placeholder, NOT a User
 * row. A tool that stores a user id (an owner, an activity actor) turns it into
 * null instead of breaking the User foreign key. Its own module so the CRM
 * tools can import it without a cycle through register-mcp-tools.
 */
export const MCP_PLACEHOLDER_USER_ID = "mcp-remote";
