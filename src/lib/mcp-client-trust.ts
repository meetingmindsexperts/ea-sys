/**
 * Classify where an MCP OAuth grant would actually SEND the authorization code
 * (Aug 12, 2026). Pure, no I/O, safe in a server component.
 *
 * WHY THIS EXISTS. `/api/mcp/oauth/register` is unauthenticated, because RFC
 * 7591 Dynamic Client Registration is: a browser-based MCP client has no way to
 * hold a pre-issued credential, so anyone on the internet may register a client.
 * That is not the hole. The hole is what the human sees next.
 *
 * Everything after registration reduces to ONE decision by ONE admin on the
 * `/mcp-authorize` screen, and until now that screen rendered `client_name` (a
 * free-text field the registrant types) while never rendering `redirect_uri`
 * (the field that actually identifies them). So a client registered as
 * "EA-SYS Official Sync" pointing at an attacker's callback was visually
 * indistinguishable from the real Claude integration, and approving it handed
 * over the org's entire MCP tool set.
 *
 * This is the classic OAuth consent-phishing shape (the 2017 "Google Docs"
 * worm was an app literally named Google Docs asking for Gmail scope). The
 * durable rule: on a consent screen, show the field the requester CANNOT forge,
 * not the one they typed.
 *
 * WHY ITS OWN ALLOW-LIST, and not the CORS one in `mcp-cors.ts`. They hold the
 * same hostnames today and answer different questions: CORS answers "may this
 * browser origin call our API", this answers "should a human be reassured about
 * this grant destination". Sharing the list would mean that adding an origin
 * for a future CORS reason silently marks it trusted on the consent screen,
 * which is exactly the kind of coupling that turns an unrelated change into a
 * security regression. Same reasoning as the finance / barcode / contact
 * visibility predicates deliberately disagreeing.
 */

/**
 * Hosts we ship an MCP integration for. An exact host or a subdomain of one of
 * these renders as recognised; anything else renders with a warning. This is
 * ADVISORY: an unrecognised destination is never blocked, because a legitimate
 * self-hosted client (n8n, a customer's own agent) is a real use case and the
 * admin is the one who knows. It changes what the screen SAYS, not what it
 * allows.
 */
export const RECOGNIZED_MCP_CLIENT_HOSTS = [
  "claude.ai",
  "anthropic.com",
] as const;

export interface RedirectTarget {
  /** Scheme + host + port, e.g. "https://claude.ai". Null if unparseable. */
  origin: string | null;
  /** Hostname only, e.g. "claude.ai". Null if unparseable. */
  host: string | null;
  /** True when the host is, or is a subdomain of, a recognised host. */
  recognized: boolean;
  /**
   * True when the destination is plain http on a non-loopback host, i.e. the
   * code would cross the network in the clear. Surfaced separately because it
   * is alarming for a different reason than an unknown vendor.
   */
  insecure: boolean;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Describe a registered redirect_uri for display on the consent screen.
 *
 * Never throws: an unparseable URI yields `{ origin: null, recognized: false }`
 * so the caller renders the warning rather than a blank space. A consent screen
 * that silently omits the destination is the bug this module exists to fix, so
 * failing closed here means "warn", not "hide".
 */
export function describeRedirectTarget(redirectUri: string): RedirectTarget {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return { origin: null, host: null, recognized: false, insecure: false };
  }

  const host = url.hostname.toLowerCase();
  const recognized = RECOGNIZED_MCP_CLIENT_HOSTS.some(
    // Anchor the suffix on a dot so "notclaude.ai" cannot pass as a subdomain
    // of "claude.ai". Bare `endsWith(host)` is the standard mistake here.
    (known) => host === known || host.endsWith(`.${known}`),
  );
  const insecure = url.protocol !== "https:" && !LOOPBACK_HOSTS.has(host);

  return { origin: url.origin, host, recognized, insecure };
}
